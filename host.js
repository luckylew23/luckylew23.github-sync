// GitHub Sync — keeps a Textus folder as a plain git repository on GitHub.
//
// Design notes (why the sync looks like this):
//
// - One sync is one commit: blobs, then a tree, then a commit, then the ref
//   moves. A sync that dies half way leaves the branch exactly as it was, so
//   the repository can never hold half of a change.
// - The plugin remembers, per path, the blob hash both sides agreed on
//   ("base"). Every decision compares three states - local, remote, base.
//   Without base "deleted here" and "added there" look identical, and
//   guessing which one it is is how sync plugins lose files.
// - Deleting is the one irreversible act, so it never happens on its own: a
//   file deleted on GitHub is put back here unless this folder's own
//   deletion is what removed it. The cloud-sync plugin learned that the hard
//   way; this plugin keeps the rule.
// - The remote side is an ordinary git repository - real paths, no encrypted
//   chunks, no lock or manifest files. Any git client can read it, and a
//   sync costs a handful of requests instead of three per file, which keeps
//   it inside GitHub's 5000 requests an hour.
// - Nothing is filtered by file type. The settings say what to leave out
//   (gitignore syntax) and how large a file may be; what is skipped is
//   reported, not silently dropped.

const PLUGIN_ID = "luckylew23.github-sync";
const VIEW_ID = PLUGIN_ID + ".tab";
const STATUS_ID = PLUGIN_ID + ".status";
const API = "https://api.github.com";
const PUSH_RETRIES = 3;
const MAX_BLOB = 32 * 1024 * 1024;
const DEFAULT_MAX_FILE = 20 * 1024 * 1024;

// Directories that never sync, whatever the rules say: .git is a repository
// of its own (writing into it would corrupt it) and .textus holds this
// plugin's own state.
const HARD_EXCLUDES = [/(^|\/)\.git\//, /(^|\/)\.textus\//];

const DEFAULT_RULES = [
  "# One rule a line, gitignore syntax. A trailing / excludes a folder,",
  "# ! brings a path back, # is a comment. A pattern without / matches at",
  "# any depth.",
  ".git/",
  ".textus/",
  "node_modules/",
  "dist/",
  "build/",
  "target/",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "*.tmp",
  "*.swp",
  "*.part",
  "# Keep secrets off GitHub - uncomment and adjust:",
  "# secrets/",
  "# *.kdbx",
].join("\n");

const DEFAULTS = {
  owner: "",
  repo: "",
  branch: "main",
  mode: "merge", // merge | push | pull
  onRemoteDelete: "restore", // restore | delete
  conflictPolicy: "ask", // ask | local | remote | both
  maxFileSize: DEFAULT_MAX_FILE,
  rules: DEFAULT_RULES,
  commitMessage: "",
  autoPush: true,
  autoPull: true,
  pullMinutes: 5,
  settleSeconds: 5,
  syncOnOpen: false,
  last: null,
};

// --- bytes and hashes ----------------------------------------------------

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(String(text || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Git names a file by the SHA-1 of "blob <length>\0<content>", so a local
// hash can be compared with a tree entry without fetching the file. This is
// what makes "did it change?" free.
async function blobSha(bytes) {
  const header = new TextEncoder().encode("blob " + bytes.length + "\u0000");
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// --- exclusion rules -----------------------------------------------------
//
// The gitignore subset people already know, so a copied .gitignore behaves
// the way it does in git.

function globToRegexSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; ) {
    const piece = glob.slice(i).match(/^(\*\*\/|\*\*|\*|\?|\[[^\]]*\]|\\.)/u);
    if (!piece) {
      out += glob[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
      continue;
    }
    const token = piece[1];
    i += token.length;
    if (token === "**/") out += "(?:[^/]+/)*";
    else if (token === "**") out += ".*";
    else if (token === "*") out += "[^/]*";
    else if (token === "?") out += "[^/]";
    else if (token.startsWith("\\")) out += token[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else {
      const body = token.slice(1, -1);
      // [!abc] means "none of these" in a gitignore.
      out += body.startsWith("!") ? "[^" + body.slice(1) + "]" : "[" + body + "]";
    }
  }
  return out;
}

function parseRules(text) {
  const rules = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1).trim();
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    // A leading slash means "this path from the folder's top", as in git;
    // without it the name matches at any depth.
    const anchored = line.startsWith("/") || line.includes("/");
    line = line.replace(/^\.\//, "").replace(/^\/+/, "");
    if (!line) continue;
    const body = globToRegexSource(line);
    let regex;
    try {
      regex = anchored ? new RegExp("^" + body + "$", "u") : new RegExp("(^|/)" + body + "$", "u");
    } catch {
      continue; // an unusable rule must not break the whole sync
    }
    rules.push({ negate, dirOnly, regex });
  }
  return rules;
}

function hardExcluded(rel) {
  return HARD_EXCLUDES.some((regex) => regex.test(rel));
}

// A rule that matched a folder excludes everything under it, as in git:
// "build/" has to exclude build/app.js without naming it.
function isExcluded(rel, isDir, rules) {
  const parts = rel.split("/");
  const parents = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  let excluded = false;
  for (const rule of rules) {
    const hit = (!rule.dirOnly || isDir) && rule.regex.test(rel) ? true : parents.some((parent) => rule.regex.test(parent));
    if (hit) excluded = !rule.negate;
  }
  return excluded;
}

// --- GitHub --------------------------------------------------------------
//
// Only the Git Database endpoints, plus two account calls to pick a
// repository: the file endpoints cost one request per file, and a first sync
// of a few hundred files would use up the hour's budget.

class ApiError extends Error {
  constructor(status, kind, message) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

function apiKind(status, body) {
  const message = String((body && body.message) || "");
  if (status === 401) return "auth";
  if (status === 403 && /rate limit/i.test(message)) return "rateLimit";
  if (status === 403 || status === 404) return message.includes("not found") ? "notFound" : "auth";
  if (status === 409) return "conflict";
  if (status === 422) return "nonFastForward";
  if (status >= 500) return "server";
  return "error";
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

class GitHub {
  constructor(token, config) {
    this.token = token;
    this.config = config;
    this.quota = null;
  }

  get repoPath() {
    return "/repos/" + encodeURIComponent(this.config.owner) + "/" + encodeURIComponent(this.config.repo);
  }

  headers(extra) {
    return {
      Authorization: "Bearer " + this.token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
  }

  note(response) {
    // GitHub reports the hour's budget on every answer; showing it saves
    // the user from wondering why a sync suddenly says "rate limit".
    const left = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (left !== null) this.quota = { left: Number(left), reset: reset === null ? null : Number(reset) * 1000 };
  }

  async request(method, path, body, signal, left = 2) {
    const response = await textus.net.fetch(API + path, {
      method,
      headers: this.headers(body ? { "Content-Type": "application/json" } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    this.note(response);
    const text = await response.text();
    if (response.ok) return parseJson(text);
    const data = parseJson(text);
    const kind = apiKind(response.status, data);
    const wait = Number(response.headers.get("retry-after"));
    // A server hiccup or GitHub's secondary limit is worth waiting out once;
    // a used-up hourly budget is not.
    if (left > 0 && (kind === "server" || response.status === 429 || (response.status === 403 && wait > 0))) {
      await new Promise((resolve) => setTimeout(resolve, wait > 0 ? wait * 1000 : 2000));
      return this.request(method, path, body, signal, left - 1);
    }
    throw new ApiError(response.status, kind, (data && data.message) || response.status + " " + method + " " + path);
  }

  whoAmI() {
    return this.request("GET", "/user");
  }

  listRepos() {
    return this.request("GET", "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member");
  }

  createRepo(name, isPrivate) {
    return this.request("POST", "/user/repos", { name, private: isPrivate, auto_init: false });
  }

  async branchHead(branch, signal) {
    const response = await textus.net.fetch(API + this.repoPath + "/branches/" + encodeURIComponent(branch), {
      headers: this.headers(),
      signal,
    });
    this.note(response);
    if (response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) {
      const data = parseJson(text);
      throw new ApiError(response.status, apiKind(response.status, data), text);
    }
    const data = parseJson(text);
    return { commit: data.commit.sha, tree: data.commit.commit.tree.sha };
  }

  async treeBlobs(tree, signal) {
    const data = await this.request("GET", this.repoPath + "/git/trees/" + tree + "?recursive=1", undefined, signal);
    if (data.truncated) {
      // GitHub truncates above ~100k entries; syncing half of a folder
      // silently would be worse than refusing.
      throw new ApiError(0, "truncated", "tree truncated");
    }
    const blobs = new Map();
    for (const entry of data.tree || []) {
      if (entry.type === "blob") blobs.set(entry.path, { sha: entry.sha, size: entry.size || 0 });
    }
    return blobs;
  }

  async getBlob(sha, signal) {
    const data = await this.request("GET", this.repoPath + "/git/blobs/" + sha, undefined, signal);
    return base64ToBytes(data.content);
  }

  async createBlob(bytes, signal) {
    const data = await this.request(
      "POST",
      this.repoPath + "/git/blobs",
      { content: bytesToBase64(bytes), encoding: "base64" },
      signal,
    );
    return data.sha;
  }

  // entries: [{path, sha}] where sha === null deletes the path.
  async commit(message, entries, head, signal) {
    const tree = await this.request(
      "POST",
      this.repoPath + "/git/trees",
      {
        base_tree: head ? head.tree : undefined,
        tree: entries.map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: entry.sha })),
      },
      signal,
    );
    const commit = await this.request(
      "POST",
      this.repoPath + "/git/commits",
      { message, tree: tree.sha, parents: head ? [head.commit] : [] },
      signal,
    );
    const ref = { ref: "refs/heads/" + this.config.branch, sha: commit.sha };
    if (head) await this.request("PATCH", this.repoPath + "/git/refs/heads/" + encodeURIComponent(this.config.branch), { sha: commit.sha, force: false }, signal);
    else await this.request("POST", this.repoPath + "/git/refs", ref, signal);
    return commit.sha;
  }
}

// --- the folder ----------------------------------------------------------
//
// The planner needs one thing per path: a hash. Local hashes are cached
// against size and modification time, so a folder of a few thousand files
// re-hashes only what changed since the last sync.

async function scanLocal(root, rules, maxBytes, signal, cache) {
  const files = new Map();
  const tooLarge = [];
  let excluded = 0;

  const walk = async (dir) => {
    if (signal.aborted) throw new ApiError(0, "cancelled", "aborted");
    for (const entry of await textus.files.list(dir)) {
      const rel = entry.rel;
      if (hardExcluded(rel)) continue;
      if (entry.isDir) {
        if (isExcluded(rel, true, rules)) {
          excluded += 1;
          continue;
        }
        await walk(entry.path);
        continue;
      }
      if (isExcluded(rel, false, rules)) {
        excluded += 1;
        continue;
      }
      if (entry.size > maxBytes) {
        tooLarge.push({ rel, size: entry.size });
        continue;
      }
      const known = cache ? cache[rel] : null;
      const usable = known && entry.modifiedMs !== null && known.size === entry.size && known.at === entry.modifiedMs;
      if (usable) {
        files.set(rel, { sha: known.sha, size: entry.size });
        continue;
      }
      const sha = await blobSha(await textus.files.read(entry.path));
      files.set(rel, { sha, size: entry.size });
      if (cache && entry.modifiedMs !== null) cache[rel] = { sha, size: entry.size, at: entry.modifiedMs };
    }
  };

  await walk(root);
  return { files, tooLarge, excluded };
}

// --- the plan ------------------------------------------------------------
//
// A pure function of (local, remote, base): no I/O, no state. Every case in
// the table in README.md can be read off here and tested without a network.
// An entry names a local and a remote path separately, because "keep both"
// downloads to a different name.

function conflictName(rel, now) {
  const slash = rel.lastIndexOf("/");
  const dir = slash < 0 ? "" : rel.slice(0, slash + 1);
  const name = slash < 0 ? rel : rel.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return dir + stem + " (conflict " + stamp + ")" + ext;
}

function plan(input) {
  const { local, remote, base, first, mode, onRemoteDelete, now } = input;
  const result = {
    pulls: [], // {remote, local, sha}
    pushes: [], // {local, remote} - local === null deletes the remote path
    localDeletes: [], // {local}
    conflicts: [], // {path, kind, remoteSha}
    dropBase: [],
    unchanged: 0,
  };
  const push = (rel) => result.pushes.push({ local: rel, remote: rel });
  const pull = (rel) => result.pulls.push({ remote: rel, local: rel, sha: remote.get(rel).sha });
  const conflict = (rel, kind) => result.conflicts.push({ path: rel, kind, remoteSha: remote.has(rel) ? remote.get(rel).sha : null });

  for (const rel of [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)])].sort()) {
    const mine = local.get(rel);
    const theirs = remote.get(rel);
    const agreed = base[rel];

    if (first) {
      // First connection: the mode decides for a path both sides have.
      if (mine && theirs) {
        if (mine.sha === theirs.sha) result.unchanged += 1;
        else if (mode === "push") push(rel);
        else if (mode === "pull") pull(rel);
        else conflict(rel, "bothAdded");
      } else if (mine) {
        if (mode === "pull") result.localDeletes.push({ local: rel });
        else push(rel);
      } else if (mode === "push") {
        result.pushes.push({ local: null, remote: rel });
      } else {
        pull(rel);
      }
      continue;
    }

    if (mine && theirs) {
      if (mine.sha === theirs.sha) {
        result.unchanged += 1;
        continue;
      }
      const localChanged = mine.sha !== agreed;
      const remoteChanged = theirs.sha !== agreed;
      if (!agreed || (localChanged && remoteChanged)) conflict(rel, agreed ? "bothChanged" : "bothAdded");
      else if (localChanged) push(rel);
      else if (remoteChanged) pull(rel);
      continue;
    }

    if (mine) {
      if (!agreed) {
        push(rel); // never synced; GitHub simply lacks it
      } else if (mine.sha === agreed) {
        // Deleted on GitHub, untouched here: put it back, unless the user
        // asked for the deletion to win.
        if (onRemoteDelete === "delete") result.localDeletes.push({ local: rel });
        else push(rel);
      } else {
        conflict(rel, "changedHereDeletedThere");
      }
      continue;
    }

    if (theirs) {
      if (!agreed) {
        pull(rel); // never synced; missing here
      } else if (theirs.sha === agreed) {
        result.pushes.push({ local: null, remote: rel }); // deleted here, untouched there
      } else {
        conflict(rel, "deletedHereChangedThere");
      }
      continue;
    }

    result.dropBase.push(rel);
  }

  return result;
}

// Settle every conflict without asking, by the policy in the settings.
// "both" keeps the remote version beside the local one, so neither side
// loses a byte; when only one side still has the file there is nothing to
// keep twice, and the surviving side wins.
function applyPolicy(result, policy) {
  for (const conflict of result.conflicts) {
    const rel = conflict.path;
    if (policy === "local" || conflict.kind === "changedHereDeletedThere") {
      result.pushes.push({ local: conflict.kind === "deletedHereChangedThere" ? null : rel, remote: rel });
    } else if (policy === "remote") {
      if (conflict.kind === "deletedHereChangedThere") result.pulls.push({ remote: rel, local: rel, sha: conflict.remoteSha });
      else if (conflict.kind === "changedHereDeletedThere") result.localDeletes.push({ local: rel });
      else result.pulls.push({ remote: rel, local: rel, sha: conflict.remoteSha });
    } else {
      const copy = conflictName(rel, Date.now());
      if (conflict.kind === "deletedHereChangedThere") {
        // The local file is gone, the remote one changed: keep the remote
        // copy beside it, then let the deletion reach GitHub.
        result.pulls.push({ remote: rel, local: copy, sha: conflict.remoteSha });
        result.pushes.push({ local: null, remote: rel });
      } else {
        // Both versions exist: the remote one lands under a new name.
        result.pulls.push({ remote: rel, local: copy, sha: conflict.remoteSha });
        result.pushes.push({ local: rel, remote: rel });
      }
    }
    result.dropBase.push(rel);
  }
  result.conflicts = [];
  return result;
}

// --- the plugin ----------------------------------------------------------

function formatError(error, t) {
  if (error instanceof ApiError) return t("error." + error.kind);
  if (/abort/i.test(String(error && error.message))) return t("error.cancelled");
  return t("error.network");
}

class GitHubSync {
  constructor(ctx) {
    this.ctx = ctx;
    this.t = (key, ...args) => textus.l10n.t(key, ...args);
    this.webview = null;
    this.busy = false;
    this.abort = null;
    this.timer = null;
    this.settle = null;
    this.config = { ...DEFAULTS };
    this.base = { commit: null, files: {} };
    this.cache = {};
    this.status = null;
    this.state = {
      configured: false,
      connected: false,
      busy: false,
      error: null,
      message: null,
      last: null,
      ahead: 0,
      behind: 0,
      conflicts: [],
      tooLarge: [],
      excluded: 0,
      progress: null,
      login: null,
      quota: null,
    };
  }

  // --- lifecycle ---------------------------------------------------------

  activate() {
    const ctx = this.ctx;
    ctx.subscriptions.push(
      textus.commands.register(PLUGIN_ID + ".open", () => textus.layout.showSidebarTab(VIEW_ID)),
      textus.commands.register(PLUGIN_ID + ".sync", () => this.run(DEFAULTS.mode)),
      textus.commands.register(PLUGIN_ID + ".push", () => this.run("push")),
      textus.commands.register(PLUGIN_ID + ".pull", () => this.run("pull")),
      textus.views.registerWebview(VIEW_ID, { resolve: (webview) => this.resolve(webview) }),
      textus.files.onDidSave(() => this.saved()),
      textus.files.onDidChangeRoot(() => this.refresh()),
    );
    this.status = textus.ui.statusItem(STATUS_ID, {
      text: this.t("status.text"),
      tooltip: this.t("status.tooltip"),
      command: PLUGIN_ID + ".open",
    });
    this.restore().then(() => {
      this.restartTimer();
      this.refresh();
    });
  }

  async restore() {
    const saved = await this.ctx.storage.project.get("config");
    if (saved) this.config = { ...DEFAULTS, ...saved };
    const base = await this.ctx.storage.project.get("base");
    if (base) this.base = { commit: base.commit || null, files: base.files || {} };
    const cache = await this.ctx.storage.project.get("cache");
    if (cache) this.cache = cache;
    this.state.configured = Boolean(this.config.owner && this.config.repo);
    this.state.last = this.config.last || null;
  }

  async persist() {
    await this.ctx.storage.project.set("config", { ...this.config, last: this.state.last });
  }

  resolve(webview) {
    this.webview = webview;
    this.ctx.plugin.readText("panel.html").then((html) => {
      webview.html = html;
    });
    webview.onDidReceiveMessage((message) => this.receive(message));
    webview.onDidDispose(() => {
      if (this.webview === webview) this.webview = null;
    });
    this.broadcast();
    if (this.state.configured && this.config.syncOnOpen) this.run(this.config.mode);
  }

  post(message) {
    if (this.webview) this.webview.postMessage(message);
  }

  broadcast() {
    this.post({
      type: "state",
      state: {
        ...this.state,
        config: this.config,
        base: { files: Object.keys(this.base.files).length, commit: this.base.commit },
      },
    });
    this.showStatus();
  }

  showStatus() {
    if (!this.status) return;
    if (this.state.busy) this.status.text = this.t("status.syncing");
    else if (this.state.error) this.status.text = this.t("status.error");
    else if (this.state.conflicts.length) this.status.text = this.t("status.conflict", this.state.conflicts.length);
    else if (this.state.ahead || this.state.behind) this.status.text = this.t("status.pending", this.state.ahead, this.state.behind);
    else this.status.text = this.t("status.text");
    this.status.tooltip = this.state.last
      ? this.t("status.last", new Date(this.state.last.at).toLocaleString())
      : this.t("status.never");
  }

  // --- panel messages ----------------------------------------------------

  async receive(message) {
    try {
      await this.handle(message);
    } catch (error) {
      this.failed(error);
    }
  }

  async handle(message) {
    switch (message.type) {
      case "ready":
        this.broadcast();
        return;
      case "connect":
        await this.connect(String(message.token || "").trim());
        return;
      case "repos":
        this.post({ type: "repos", repos: await this.listRepos() });
        return;
      case "createRepo": {
        const api = await this.client();
        const created = await api.createRepo(String(message.name || "").trim(), Boolean(message.private));
        this.post({ type: "created", fullName: created.full_name });
        return;
      }
      case "setup":
        this.config.owner = String(message.owner || "").trim();
        this.config.repo = String(message.repo || "").trim();
        this.config.branch = String(message.branch || "main").trim() || "main";
        this.state.configured = true;
        await this.persist();
        this.broadcast();
        await this.firstConnection();
        return;
      case "first":
        await this.run(message.choice === "push" ? "push" : "pull");
        return;
      case "sync":
        await this.run(message.mode || this.config.mode);
        return;
      case "resolve": {
        const conflict = this.findConflict(message.path);
        if (conflict) await this.resolveConflict(conflict, message.choice);
        return;
      }
      case "settings":
        this.config = {
          ...this.config,
          autoPush: Boolean(message.autoPush),
          autoPull: Boolean(message.autoPull),
          pullMinutes: Math.max(1, Number(message.pullMinutes) || 5),
          settleSeconds: Math.max(1, Number(message.settleSeconds) || 5),
          syncOnOpen: Boolean(message.syncOnOpen),
          mode: ["merge", "push", "pull"].includes(message.mode) ? message.mode : "merge",
          onRemoteDelete: message.onRemoteDelete === "delete" ? "delete" : "restore",
          conflictPolicy: ["ask", "local", "remote", "both"].includes(message.conflictPolicy) ? message.conflictPolicy : "ask",
          maxFileSize: Math.min(MAX_BLOB, Math.round((Number(message.maxFileSizeMb) || 20) * 1024 * 1024)),
          rules: String(message.rules || ""),
          commitMessage: String(message.commitMessage || "").trim(),
        };
        await this.persist();
        this.restartTimer();
        this.broadcast();
        return;
      case "disconnect":
        this.config.owner = "";
        this.config.repo = "";
        this.base = { commit: null, files: {} };
        this.cache = {};
        this.state.configured = false;
        this.state.conflicts = [];
        this.state.ahead = 0;
        this.state.behind = 0;
        await this.ctx.storage.project.delete("base");
        await this.ctx.storage.project.delete("cache");
        await this.persist();
        this.broadcast();
        return;
      default:
        return;
    }
  }

  findConflict(path) {
    return this.state.conflicts.find((item) => item.path === path) || null;
  }

  // --- credentials and repository ---------------------------------------

  async client() {
    const token = await this.ctx.secrets.get("token");
    if (!token) throw new ApiError(401, "auth", "no token");
    return new GitHub(token, this.config);
  }

  async connect(token) {
    if (!token) throw new ApiError(401, "auth", "no token");
    await this.ctx.secrets.set("token", token);
    const api = await this.client();
    const user = await api.whoAmI();
    this.state.connected = true;
    this.state.login = user.login;
    this.post({ type: "repos", repos: await this.listRepos() });
    if (this.state.configured) await this.firstConnection();
    else this.broadcast();
  }

  async listRepos() {
    const api = await this.client();
    const repos = await api.listRepos();
    return (repos || []).map((repo) => ({ fullName: repo.full_name, private: repo.private }));
  }

  async firstConnection() {
    const api = await this.client();
    const head = await api.branchHead(this.config.branch);
    const remote = head ? await api.treeBlobs(head.tree) : new Map();
    const root = await textus.files.root();
    const { files } = await scanLocal(root, parseRules(this.config.rules), this.config.maxFileSize, new AbortController().signal, null);
    const shared = [...files.keys()].filter((rel) => remote.has(rel));
    const differs = shared.filter((rel) => remote.get(rel).sha !== files.get(rel).sha);
    if (Object.keys(this.base.files).length === 0 && (differs.length > 0 || (shared.length > 0 && files.size !== remote.size))) {
      // Both sides hold files the plugin has never reconciled: asking costs
      // one question, guessing wrongly costs the user's work.
      this.post({ type: "firstChoice", local: files.size, remote: remote.size, shared: shared.length, differs: differs.length });
      return;
    }
    await this.run(this.config.mode);
  }

  // --- the sync ----------------------------------------------------------

  async run(mode) {
    if (this.busy) return;
    if (!this.state.configured) {
      this.state.error = this.t("error.notConfigured");
      this.broadcast();
      return;
    }
    this.busy = true;
    this.abort = new AbortController();
    this.state = { ...this.state, busy: true, error: null, message: null, progress: null };
    this.broadcast();
    try {
      await this.sync(mode || this.config.mode);
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy = false;
      this.abort = null;
      this.state.busy = false;
      this.state.progress = null;
      this.broadcast();
      await this.ctx.storage.project.set("cache", this.cache);
    }
  }

  progress(stage, done, total) {
    this.state.progress = { stage, done, total };
    this.post({ type: "progress", progress: this.state.progress });
  }

  async sync(mode) {
    const signal = this.abort.signal;
    const api = await this.client();
    const root = await textus.files.root();
    if (!root) throw new ApiError(0, "noFolder", "no folder");
    const rules = parseRules(this.config.rules);

    this.progress("read", 0, 1);
    const head = await api.branchHead(this.config.branch, signal);
    const remote = head ? await api.treeBlobs(head.tree, signal) : new Map();

    // A rule that leaves a path out on this side has to leave it out on the
    // other side too, or one side would delete what the other keeps.
    const remoteTooLarge = [];
    for (const [rel, entry] of [...remote]) {
      if (hardExcluded(rel) || isExcluded(rel, false, rules)) {
        remote.delete(rel);
        continue;
      }
      if (entry.size > this.config.maxFileSize) {
        remoteTooLarge.push({ rel, size: entry.size });
        remote.delete(rel);
      }
    }

    const { files: local, tooLarge, excluded } = await scanLocal(root, rules, this.config.maxFileSize, signal, this.cache);

    let result = plan({
      local,
      remote,
      base: this.base.files,
      first: this.base.commit === null,
      mode,
      onRemoteDelete: this.config.onRemoteDelete,
      now: Date.now(),
    });
    if (result.conflicts.length && this.config.conflictPolicy !== "ask") {
      result = applyPolicy(result, this.config.conflictPolicy);
    }

    const { pulled, pushed } = await this.apply(api, root, local, result, signal);

    this.state.tooLarge = [...tooLarge, ...remoteTooLarge].sort((a, b) => b.size - a.size).slice(0, 50);
    this.state.excluded = excluded;
    this.state.conflicts = result.conflicts.map((conflict) => ({ path: conflict.path, kind: conflict.kind }));
    this.state.last = {
      at: Date.now(),
      pulled,
      pushed,
      conflicts: this.state.conflicts.length,
      skipped: this.state.tooLarge.length,
    };
    this.state.message = this.state.conflicts.length
      ? this.t("sync.conflicts", this.state.conflicts.length)
      : this.t("sync.done", pushed, pulled, this.state.tooLarge.length);
    await this.persist();
    await this.recount();
  }

  // Downloads first: a pull can replace a file the push would otherwise
  // upload, and deletions go before commits so one commit carries them all.
  async apply(api, root, local, result, signal) {
    const next = {};
    const touched = new Set();
    for (const pull of result.pulls) touched.add(pull.local).add(pull.remote);
    for (const push of result.pushes) if (push.local) touched.add(push.local);
    for (const deletion of result.localDeletes) touched.add(deletion.local);
    for (const drop of result.dropBase) touched.add(drop);
    for (const [rel, sha] of Object.entries(this.base.files)) if (!touched.has(rel)) next[rel] = sha;

    let pulled = 0;
    for (const pull of result.pulls) {
      this.progress("download", pulled, result.pulls.length);
      const bytes = await api.getBlob(pull.sha, signal);
      await textus.files.write(root + "/" + pull.local, bytes);
      next[pull.local] = pull.sha;
      pulled += 1;
    }

    for (const deletion of result.localDeletes) {
      await textus.files.trash(root + "/" + deletion.local).catch(() => {});
      delete next[deletion.local];
    }

    if (result.pushes.length === 0) {
      this.base = { commit: this.base.commit, files: next };
      await this.ctx.storage.project.set("base", this.base);
      return { pulled, pushed: 0 };
    }

    const entries = [];
    const shas = new Map();
    for (const push of result.pushes) {
      this.progress("upload", entries.length, result.pushes.length);
      if (push.local === null) {
        entries.push({ path: push.remote, sha: null });
        continue;
      }
      const bytes = await textus.files.read(root + "/" + push.local);
      const sha = await api.createBlob(bytes, signal);
      entries.push({ path: push.remote, sha });
      shas.set(push.remote, sha);
    }

    const message = this.config.commitMessage || this.t("commit.default", shas.size);
    let head = await api.branchHead(this.config.branch, signal);
    let commit = null;
    for (let attempt = 0; commit === null; attempt++) {
      try {
        commit = await api.commit(message, entries, head, signal);
      } catch (error) {
        // Someone else pushed meanwhile: rebuild on the new tip, and give up
        // loudly rather than force a ref over their commit.
        if (error instanceof ApiError && error.kind === "nonFastForward" && attempt < PUSH_RETRIES - 1) {
          head = await api.branchHead(this.config.branch, signal);
          continue;
        }
        throw error;
      }
    }

    for (const [path, sha] of shas) next[path] = sha;
    for (const entry of entries) if (entry.sha === null) delete next[entry.path];

    this.base = { commit, files: next };
    await this.ctx.storage.project.set("base", this.base);
    return { pulled, pushed: shas.size };
  }

  // A cheap "how far apart are we" for the status line: hashes only, no file
  // bodies, and never a write.
  async recount() {
    if (this.busy || !this.state.configured) return;
    try {
      const api = await this.client();
      const head = await api.branchHead(this.config.branch);
      const remote = head ? await api.treeBlobs(head.tree) : new Map();
      const root = await textus.files.root();
      if (!root) return;
      const { files: local } = await scanLocal(root, parseRules(this.config.rules), this.config.maxFileSize, new AbortController().signal, this.cache);
      const result = plan({
        local,
        remote,
        base: this.base.files,
        first: this.base.commit === null,
        mode: "merge",
        onRemoteDelete: this.config.onRemoteDelete,
        now: Date.now(),
      });
      this.state.ahead = result.pushes.length;
      this.state.behind = result.pulls.length;
      this.state.quota = api.quota;
      if (!this.state.conflicts.length) {
        this.state.conflicts = result.conflicts.map((conflict) => ({ path: conflict.path, kind: conflict.kind }));
      }
      this.broadcast();
    } catch (error) {
      this.ctx.log.warn("GitHub Sync: status check failed: " + String(error && error.message));
    }
  }

  async refresh() {
    const root = await textus.files.root();
    this.state.configured = Boolean(root) && Boolean(this.config.owner && this.config.repo);
    if (!this.state.configured) {
      this.broadcast();
      return;
    }
    await this.recount();
  }

  async resolveConflict(conflict, choice) {
    const api = await this.client();
    const root = await textus.files.root();
    const head = await api.branchHead(this.config.branch);
    const remote = head ? await api.treeBlobs(head.tree) : new Map();
    const entry = remote.get(conflict.path);
    const resolved = { pulls: [], pushes: [], localDeletes: [], dropBase: [conflict.path], conflicts: [], unchanged: 0 };
    if (choice === "remote") {
      if (entry) resolved.pulls.push({ remote: conflict.path, local: conflict.path, sha: entry.sha });
      else resolved.localDeletes.push({ local: conflict.path });
    } else if (choice === "both" && entry) {
      resolved.pulls.push({ remote: conflict.path, local: conflictName(conflict.path, Date.now()), sha: entry.sha });
      resolved.pushes.push({ local: conflict.path, remote: conflict.path });
    } else if (entry) {
      resolved.pushes.push({ local: conflict.path, remote: conflict.path });
    } else {
      resolved.pushes.push({ local: null, remote: conflict.path });
    }
    const { files: local } = await scanLocal(root, parseRules(this.config.rules), this.config.maxFileSize, new AbortController().signal, this.cache);
    await this.apply(api, root, local, resolved, new AbortController().signal);
    this.state.conflicts = this.state.conflicts.filter((item) => item.path !== conflict.path);
    this.broadcast();
    await this.recount();
  }

  failed(error) {
    this.ctx.log.error("GitHub Sync: " + String((error && error.stack) || error));
    this.state.error = formatError(error, this.t);
    this.state.message = this.state.error;
    if (error instanceof ApiError && error.kind === "rateLimit") this.state.quota = { left: 0, reset: null };
    this.broadcast();
  }

  // --- background work ---------------------------------------------------

  saved() {
    if (!this.config.autoPush || !this.state.configured) return;
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      this.run("push");
    }, Math.max(1, this.config.settleSeconds) * 1000);
  }

  restartTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.config.autoPull || !this.state.configured) return;
    this.timer = setInterval(() => {
      // A pull while this side has its own changes would either overwrite
      // them or manufacture conflicts nobody asked for; the merge is the
      // user's next sync.
      if (this.state.ahead === 0 && this.state.conflicts.length === 0) this.run("pull");
    }, Math.max(1, this.config.pullMinutes) * 60 * 1000);
  }
}

exports.activate = (ctx) => {
  const plugin = new GitHubSync(ctx);
  plugin.activate();
  return plugin;
};

// Node can load this file, which is how the table in README.md is tested;
// Textus hands the plugin an `exports` object instead.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { plan, applyPolicy, parseRules, isExcluded, hardExcluded, conflictName, blobSha };
}