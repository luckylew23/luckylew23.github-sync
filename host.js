/// <reference path="textus.d.ts" />

// GitHub Sync: two-way sync between the open folder and a GitHub repository.
//
// The plugin cannot run a real git (Textus plugins are sandboxed in a
// webview; textus.git has no push/pull/fetch). It uses GitHub's Git
// Database REST API instead, which lets one sync become one atomic commit:
//
//   push  GET tree  -> POST blobs (N) -> POST tree (1) -> POST commit (1) -> PATCH ref (1)
//   pull  GET tree  -> GET blobs  (M) -> write/trash locally
//
// To know what changed without downloading anything, the plugin computes
// each file's GitHub blob SHA locally (sha1("blob " + len + "\0" + content))
// and compares it against the remote tree and against the SHA it recorded
// after the last sync (a three-way diff). A file where local and remote
// both moved away from that base is a conflict, resolved per file.

const PLUGIN_ID = "luckylew23.github-sync";
const VIEW_ID = PLUGIN_ID + ".tab";
const API = "https://api.github.com";

// Scheduling: wait this long after a save before pushing, and this long
// between auto-pulls (minutes). The debounce folds a burst of saves into
// one push; the interval is the steady-state poll.
const SETTLE_MS = 5000;
const DEFAULT_PULL_MINUTES = 5;
const PUSH_RETRIES = 3;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB, overridable in settings

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const textEncoder = new TextEncoder();

// A GitHub blob's SHA-1, computed locally: sha1("blob " + length + "\0" + content).
// This is what lets us diff without downloading the remote files.
async function blobSha(bytes) {
  const header = textEncoder.encode("blob " + bytes.length + "\0");
  const whole = new Uint8Array(header.length + bytes.length);
  whole.set(header, 0);
  whole.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", whole);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
  return out;
}

function relPath(path) {
  return path.replace(/^\/+/, "");
}

// ---------------------------------------------------------------------------
// .gitignore matching (a small, conservative subset)
// ---------------------------------------------------------------------------

function parseGitignore(text) {
  const patterns = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    patterns.push(line);
  }
  return patterns;
}

// Whether `path` (relative, forward slashes) matches a .gitignore pattern.
// Negations ("!") are treated as "include after all", the common case.
function isIgnored(path, patterns) {
  let ignored = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const p = (negated ? pattern.slice(1) : pattern).replace(/\/+$/, "");
    if (!p) continue;
    if (matchPattern(p, path)) ignored = !negated;
  }
  return ignored;
}

function matchPattern(pattern, path) {
  // A pattern without a slash matches a file or folder by name anywhere.
  if (!pattern.includes("/")) {
    for (const part of path.split("/")) {
      if (globMatch(pattern, part)) return true;
    }
    return false;
  }
  // A pattern with a slash is matched against the whole path.
  const anchored = pattern.startsWith("/");
  const p = anchored ? pattern.slice(1) : pattern;
  return globMatch(p, path) || path.startsWith(p + "/");
}

function globMatch(glob, str) {
  const regex = new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, ".*") +
      "$",
  );
  return regex.test(str);
}

// ---------------------------------------------------------------------------
// GitHub REST API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message, kind) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

class GitHub {
  constructor(token, owner, repo) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  async request(method, path, body, signal) {
    const res = await textus.net.fetch(API + path, {
      method,
      headers: {
        Authorization: "token " + this.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (res.status === 401) {
      throw new ApiError(401, "invalid token", "auth");
    }
    if (res.status === 403 && /rate limit/i.test(json.message || "")) {
      throw new ApiError(403, "rate limited", "rateLimit");
    }
    if (res.status === 404) {
      throw new ApiError(404, "not found", "notFound");
    }
    if (res.status === 409) {
      // 409 on GET ref = empty repo; on POST/PATCH = a race to be retried.
      throw new ApiError(409, json.message || "conflict", "conflict");
    }
    if (res.status === 422) {
      throw new ApiError(422, json.message || "unprocessable", "nonFastForward");
    }
    if (res.status >= 400) {
      throw new ApiError(res.status, json.message || "error", "error");
    }
    return json;
  }

  async whoAmI(signal) {
    return this.request("GET", "/user", undefined, signal);
  }

  async listRepos(signal) {
    return this.request(
      "GET",
      "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      undefined,
      signal,
    );
  }

  async createRepo(name, isPrivate, signal) {
    return this.request("POST", "/user/repos", { name, private: isPrivate }, signal);
  }

  // The branch's commit SHA and tree SHA, or null when the branch is absent.
  async branchHead(branch, signal) {
    try {
      const data = await this.request(
        "GET",
        "/repos/" + this.owner + "/" + this.repo + "/branches/" + branch,
        undefined,
        signal,
      );
      return {
        commit: data.commit.sha,
        tree: data.commit.commit.tree.sha,
      };
    } catch (e) {
      if (e.kind === "notFound") return null;
      throw e;
    }
  }

  // A flat map of path -> { sha, size } for every blob under `tree`.
  async treeBlobs(tree, signal) {
    const data = await this.request(
      "GET",
      "/repos/" + this.owner + "/" + this.repo + "/git/trees/" + tree + "?recursive=1",
      undefined,
      signal,
    );
    const out = new Map();
    for (const entry of data.tree || []) {
      if (entry.type === "blob") out.set(entry.path, { sha: entry.sha, size: entry.size });
    }
    return out;
  }

  async createBlob(bytes, signal) {
    const data = await this.request(
      "POST",
      "/repos/" + this.owner + "/" + this.repo + "/git/blobs",
      { content: bytesToBase64(bytes), encoding: "base64" },
      signal,
    );
    return data.sha;
  }

  async createTree(baseTree, entries, signal) {
    const data = await this.request(
      "POST",
      "/repos/" + this.owner + "/" + this.repo + "/git/trees",
      { base_tree: baseTree || undefined, tree: entries },
      signal,
    );
    return data.sha;
  }

  async createCommit(message, tree, parents, signal) {
    const data = await this.request(
      "POST",
      "/repos/" + this.owner + "/" + this.repo + "/git/commits",
      { message, tree, parents },
      signal,
    );
    return data.sha;
  }

  async updateRef(branch, sha, signal) {
    return this.request(
      "PATCH",
      "/repos/" + this.owner + "/" + this.repo + "/git/refs/heads/" + branch,
      { sha },
      signal,
    );
  }

  // Write one file through the contents API, which also creates the branch
  // and the first commit when the repository has none. Each path segment is
  // encoded: a file name may hold '#', '?' or a space.
  async putFile(rel, bytes, message, branch, signal) {
    const path = rel.split("/").map(encodeURIComponent).join("/");
    return this.request(
      "PUT",
      "/repos/" + this.owner + "/" + this.repo + "/contents/" + path,
      { message, content: bytesToBase64(bytes), branch },
      signal,
    );
  }

  async getBlob(sha, signal) {
    const data = await this.request(
      "GET",
      "/repos/" + this.owner + "/" + this.repo + "/git/blobs/" + sha,
      undefined,
      signal,
    );
    return base64ToBytes(data.content.replace(/\n/g, ""));
  }
}

// ---------------------------------------------------------------------------
// Local workspace scan
// ---------------------------------------------------------------------------

// Returns [{ rel, path, size }] for every file to sync: not a dot-folder,
// not matched by .gitignore, and under the size cap.
async function scanFiles(root, gitignore, maxSize, signal) {
  const patterns = gitignore ? parseGitignore(gitignore) : [];
  const out = [];
  async function walk(dir) {
    const entries = await textus.files.list(dir);
    for (const entry of entries) {
      if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
      if (entry.isDir) {
        if (entry.name.startsWith(".")) continue; // dot-folders are never synced
        await walk(entry.path);
      } else {
        if (isIgnored(entry.rel, patterns)) continue;
        if (entry.size > maxSize) continue;
        out.push({ rel: entry.rel, path: entry.path, size: entry.size });
      }
    }
  }
  await walk(root);
  return out;
}

async function readGitignore(root) {
  try {
    return await textus.files.readText(root + "/.gitignore");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The sync engine
// ---------------------------------------------------------------------------

// A three-way diff over the union of local, remote and base paths. Returns
// { toPush, toPull, conflicts } where each is a list of { rel }. `local` and
// `remote` are Maps; `base` is the plain object kept in storage, which is
// normalized here so one diff serves both.
function diff(local, remote, base) {
  const baseMap =
    base instanceof Map ? base : new Map(Object.entries(base || {}));
  const toPush = [];
  const toPull = [];
  const conflicts = [];
  const paths = new Set([...local.keys(), ...remote.keys(), ...baseMap.keys()]);
  for (const rel of paths) {
    const l = local.get(rel);
    const rInfo = remote.get(rel);
    const r = rInfo ? (typeof rInfo === "object" ? rInfo.sha : rInfo) : undefined;
    const b = baseMap.get(rel);
    if (l === r) continue; // identical, nothing to do
    if (l !== undefined && r !== undefined && b !== undefined && l !== b && r !== b) {
      conflicts.push({ rel }); // both moved away from base
    } else if (l !== undefined && r === undefined && b !== undefined && l !== b) {
      conflicts.push({ rel }); // remote deleted, local changed
    } else if (l === undefined && r !== undefined && b !== undefined && r !== b) {
      conflicts.push({ rel }); // local deleted, remote changed
    } else if (l !== undefined && (r === b || b === undefined)) {
      toPush.push({ rel }); // local new or changed, remote unchanged
    } else if (r !== undefined && (l === b || b === undefined)) {
      toPull.push({ rel }); // remote new or changed, local unchanged
    } else if (l === undefined && r === undefined) {
      // both deleted; nothing to do
    } else if (r === undefined) {
      toPull.push({ rel }); // remote deleted, local unchanged: pull the deletion
    } else {
      toPush.push({ rel }); // local deleted, remote unchanged: push the deletion
    }
  }
  return { toPush, toPull, conflicts };
}

// Pull `toPull` down: existing remote blobs are written, rels the remote no
// longer has are trashed locally. Writes go through files.write so binaries
// stay intact.
async function pullFiles(gh, remote, toPull, root, signal, report) {
  const done = [];
  for (let i = 0; i < toPull.length; i++) {
    const { rel } = toPull[i];
    report && report((i + 1) / toPull.length, "downloading " + rel);
    const info = remote.get(rel);
    if (info) {
      const bytes = await gh.getBlob(info.sha, signal);
      await textus.files.write(root + "/" + rel, bytes);
    } else {
      // Remote deleted it while we were unchanged; delete here too.
      await textus.files.trash(root + "/" + rel).catch(() => {});
    }
    done.push(rel);
  }
  return done;
}

async function pushFiles(gh, config, local, remote, toPush, head, root, signal, report) {
  // A repository with no commits rejects the whole Git Data API with
  // "Git Repository is empty", so the first file goes through the contents
  // API: that creates the branch and the initial commit for us. Every
  // later file travels the normal way, in one commit.
  let pending = toPush;
  if (!head) {
    const first = pending.find((change) => local.get(change.rel) !== undefined);
    if (!first) return null; // only deletions, and there is nothing to delete
    report && report(0, "uploading " + first.rel);
    const bytes = await textus.files.read(root + "/" + first.rel);
    await gh.putFile(first.rel, bytes, "Sync from Textus", config.branch, signal);
    head = await gh.branchHead(config.branch, signal);
    if (!head) throw new ApiError(500, "the new branch did not appear", "server");
    pending = pending.filter((change) => change !== first);
  }
  if (!pending.length) return head.commit;

  // Create blobs for changed and added files; deletions are a null sha in
  // the tree. Every entry is relative to the current remote tree, so the
  // files we did not touch carry over unchanged.
  const entries = [];
  let n = 0;
  for (const { rel } of pending) {
    const localSha = local.get(rel);
    if (localSha === undefined) {
      // Deleted locally: remove from the remote tree.
      entries.push({ path: rel, mode: "100644", type: "blob", sha: null });
    } else {
      report && report(n++ / pending.length, "uploading " + rel);
      const bytes = await textus.files.read(root + "/" + rel);
      const sha = await gh.createBlob(bytes, signal);
      entries.push({ path: rel, mode: "100644", type: "blob", sha });
    }
  }
  report && report(1, "committing");
  const tree = await gh.createTree(head.tree, entries, signal);
  const commit = await gh.createCommit("Sync from Textus", tree, [head.commit], signal);
  await gh.updateRef(config.branch, commit, signal);
  return commit;
}

// One full sync: diff, then pull remote-only changes, then push local-only
// changes (or just one side, depending on `mode`). Returns the outcome.
async function synchronize(gh, config, base, root, signal, report, mode) {
  // 1. Remote state.
  const head = await gh.branchHead(config.branch, signal);
  const remote = head ? await gh.treeBlobs(head.tree, signal) : new Map();

  // 2. Local state: scan, then hash every file.
  const gitignore = await readGitignore(root);
  const files = await scanFiles(root, gitignore, config.maxFileSize || MAX_FILE_SIZE, signal);
  const local = new Map();
  for (const f of files) {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    const bytes = await textus.files.read(f.path);
    local.set(f.rel, await blobSha(bytes));
  }

  // 3. Three-way diff against the recorded base.
  const baseShas = (base && base.fileShas) || {};
  const { toPush, toPull, conflicts } = diff(local, remote, baseShas);
  // A conflict stops the sync before anything moves, but the result keeps
  // the same shape as a completed one: the panel and the Controller read
  // pushed, pulled and fileShas without asking which outcome it was.
  if (conflicts.length) {
    return { conflicts, head, remote, local, fileShas: baseShas, pushed: 0, pulled: 0 };
  }

  // 4. Pull the remote-only side (unless we were asked to push only).
  const pulled = [];
  if (mode !== "push" && toPull.length) {
    pulled.push(...(await pullFiles(gh, remote, toPull, root, signal, report)));
  }

  // 5. Push the local-only side (unless pull-only), retrying on a race.
  // The retry re-reads the branch head so the next attempt bases its tree
  // on what is actually there now, not on the stale head from before.
  let newCommit = head ? head.commit : null;
  let newTree = head ? head.tree : null;
  let pushedCount = 0;
  if (mode !== "pull" && toPush.length) {
    let current = head;
    for (let attempt = 0; ; attempt++) {
      try {
        newCommit = await pushFiles(
          gh,
          config,
          local,
          remote,
          toPush,
          current,
          root,
          signal,
          report,
        );
        pushedCount = newCommit ? toPush.length : 0;
        break;
      } catch (e) {
        // Someone else pushed while we worked; re-read and retry.
        if (e.kind === "nonFastForward" && attempt < PUSH_RETRIES - 1) {
          current = (await gh.branchHead(config.branch, signal)) || current;
          continue;
        }
        throw e;
      }
    }
    const again = await gh.branchHead(config.branch, signal);
    if (again) newTree = again.tree;
  }

  // 6. Record the new base: every path now agrees on both sides.
  const fileShas = { ...baseShas };
  for (const rel of pulled) {
    const info = remote.get(rel);
    if (info) fileShas[rel] = info.sha;
    else delete fileShas[rel]; // pulled a deletion: it no longer exists
  }
  for (const { rel } of toPush) {
    const sha = local.get(rel);
    if (sha === undefined) delete fileShas[rel];
    else fileShas[rel] = sha;
  }
  return {
    conflicts: [],
    head: newCommit ? { commit: newCommit, tree: newTree } : head,
    remote,
    local,
    fileShas,
    pushed: pushedCount,
    pulled: pulled.length,
  };
}

// ---------------------------------------------------------------------------
// The controller: state, panel communication, commands, auto-sync
// ---------------------------------------------------------------------------

class Controller {
  constructor(ctx) {
    this.ctx = ctx;
    this.views = [];
    this.abort = null;
    this.busy = false;
    this.state = {
      configured: false,
      connected: false,
      syncing: false,
      synced: false,
      error: null,
      message: "",
      progress: null,
      lastSync: null,
      ahead: 0,
      behind: 0,
      conflicts: null,
      config: null,
      login: null,
    };
    this.pacer = new Pacer(this, SETTLE_MS, DEFAULT_PULL_MINUTES);
  }

  t(key, ...args) {
    return textus.l10n.t(key, ...args);
  }

  async activate() {
    const ctx = this.ctx;
    const subs = ctx.subscriptions;

    subs.push(
      textus.commands.register(PLUGIN_ID + ".open", () => this.open()),
      textus.commands.register(PLUGIN_ID + ".sync", () => this.runSync()),
      textus.commands.register(PLUGIN_ID + ".push", () => this.runSync("push")),
      textus.commands.register(PLUGIN_ID + ".pull", () => this.runSync("pull")),
    );

    subs.push(
      textus.views.registerWebview(VIEW_ID, {
        resolve: (webview) => this.resolve(webview),
      }),
    );

    this.statusHandle = textus.ui.statusItem(PLUGIN_ID + ".status", {
      text: this.t("status.tooltip"),
      tooltip: this.t("status.tooltip"),
      command: PLUGIN_ID + ".open",
    });

    // Auto-push: every save arms a debounce; a quiet spell triggers a push.
    subs.push(textus.files.onDidSave(() => this.pacer.saved()));

    // A different folder means a different repository; reload everything.
    subs.push(textus.files.onDidChangeRoot(() => this.refresh()));

    // Steady-state auto-pull.
    this.pullTimer = setInterval(() => this.autoPull(), DEFAULT_PULL_MINUTES * 60000);

    await this.refresh();
  }

  async refresh() {
    const root = await textus.files.root();
    if (!root) {
      this.state.configured = false;
      this.state.message = this.t("state.noFolder");
      this.broadcast();
      return;
    }
    const config = await this.ctx.storage.project.get("config");
    this.state.config = config || null;
    this.state.configured = Boolean(config && config.owner && config.repo);
    this.state.connected = Boolean(await this.ctx.secrets.get("pat"));
    if (this.state.configured) {
      await this.countChanges();
    }
    this.broadcast();
    this.showStatus();
  }

  async countChanges() {
    try {
      const config = this.state.config;
      const gh = await this.github();
      const root = await textus.files.root();
      if (!root || !gh) return;
      const head = await gh.branchHead(config.branch);
      const remote = head ? await gh.treeBlobs(head.tree) : new Map();
      const gitignore = await readGitignore(root);
      const files = await scanFiles(root, gitignore, config.maxFileSize || MAX_FILE_SIZE);
      const local = new Map();
      for (const f of files) {
        const bytes = await textus.files.read(f.path);
        local.set(f.rel, await blobSha(bytes));
      }
      const base = (await this.ctx.storage.project.get("base")) || { fileShas: {} };
      const { toPush, toPull, conflicts } = diff(local, remote, base.fileShas || {});
      this.state.ahead = toPush.length;
      this.state.behind = toPull.length;
      this.state.conflicts = conflicts.length ? conflicts : null;
    } catch (e) {
      // Status-only; a failed head count must not raise an error dialog.
    }
  }

  async github() {
    const token = await this.ctx.secrets.get("pat");
    const config = this.state.config;
    if (!token || !config) return null;
    return new GitHub(token, config.owner, config.repo);
  }

  async resolve(webview) {
    this.views.push(webview);
    const html = await this.ctx.plugin.readText("panel.html");
    webview.html = html;
    webview.onDidReceiveMessage((msg) => this.receive(msg));
    webview.onDidDispose(() => {
      const i = this.views.indexOf(webview);
      if (i >= 0) this.views.splice(i, 1);
    });
    this.broadcast();
  }

  open() {
    return textus.layout.openView(VIEW_ID, { title: this.t("panel.title") });
  }

  broadcast(patch) {
    if (patch) Object.assign(this.state, patch);
    const msg = { type: "state", state: this.state };
    for (const view of this.views) view.postMessage(msg);
    this.showStatus();
  }

  showStatus() {
    if (!this.statusHandle) return;
    let text = "GitHub";
    if (this.state.syncing) text = this.t("state.syncing");
    else if (this.state.conflicts) text = this.t("state.conflict");
    else if (this.state.error) text = this.t("state.error");
    else if (this.state.connected) text = this.t("state.connected");
    else text = this.t("state.disconnected");
    this.statusHandle.update({ text, tooltip: this.t("status.tooltip") });
  }

  async receive(msg) {
    switch (msg.type) {
      case "ready":
        this.broadcast();
        break;
      case "connect":
        await this.connect(msg.token);
        break;
      case "repos":
        await this.listRepos();
        break;
      case "createRepo":
        await this.createRepo(msg.name, msg.isPrivate);
        break;
      case "setup":
        await this.setup(msg.owner, msg.repo, msg.branch);
        break;
      case "sync":
        await this.runSync();
        break;
      case "push":
        await this.runSync("push");
        break;
      case "pull":
        await this.runSync("pull");
        break;
      case "resolveConflict":
        await this.resolveConflict(msg.rel, msg.choice);
        break;
      case "firstSync":
        // The user picked a winner for the first sync of a folder that has
        // content on both sides; record the losing side as already synced
        // so the next run only carries the winner's changes.
        await this.firstSync(msg.choice);
        break;
      case "setupCancel":
        // Back out of a first-choice prompt without syncing either side.
        this.broadcast();
        break;
      case "disconnect":
        await this.disconnect();
        break;
      case "settings":
        await this.saveSettings(msg);
        break;
    }
  }

  async connect(token) {
    try {
      this.broadcast({ syncing: true, error: null });
      const gh = new GitHub(token, "", "");
      const user = await gh.whoAmI();
      await this.ctx.secrets.set("pat", token);
      this.state.connected = true;
      this.state.login = user.login;
      this.state.syncing = false;
      this.broadcast();
      await this.listRepos();
    } catch (e) {
      this.broadcast({ syncing: false, error: this.t("setup.error.token") });
    }
  }

  async listRepos() {
    const token = await this.ctx.secrets.get("pat");
    if (!token) return;
    try {
      const gh = new GitHub(token, "", "");
      const repos = await gh.listRepos();
      for (const view of this.views) {
        view.postMessage({ type: "repos", repos });
      }
    } catch (e) {
      this.broadcast({ error: this.t("setup.error.network") });
    }
  }

  async createRepo(name, isPrivate) {
    const token = await this.ctx.secrets.get("pat");
    if (!token) return;
    try {
      const gh = new GitHub(token, "", "");
      const repo = await gh.createRepo(name, isPrivate);
      const login = repo.owner.login;
      for (const view of this.views) {
        view.postMessage({ type: "repoCreated", fullName: login + "/" + repo.name });
      }
      await this.listRepos();
    } catch (e) {
      this.broadcast({ error: this.t("setup.error.repo") });
    }
  }

  async setup(owner, repo, branch) {
    const config = {
      owner,
      repo,
      branch: branch || "main",
      autoPush: true,
      autoPull: true,
      autoPullMinutes: DEFAULT_PULL_MINUTES,
      maxFileSize: MAX_FILE_SIZE,
    };
    await this.ctx.storage.project.set("config", config);
    this.state.config = config;
    this.state.configured = true;
    this.broadcast();

    // First sync: if both sides hold content, ask which one wins.
    const root = await textus.files.root();
    const gh = new GitHub(await this.ctx.secrets.get("pat"), owner, repo);
    const head = await gh.branchHead(config.branch).catch(() => null);
    const remote = head ? await gh.treeBlobs(head.tree).catch(() => new Map()) : new Map();
    const gitignore = await readGitignore(root);
    const files = await scanFiles(root, gitignore, config.maxFileSize);
    const hasLocal = files.length > 0;
    const hasRemote = remote.size > 0;

    if (hasLocal && hasRemote) {
      for (const view of this.views) {
        view.postMessage({ type: "firstChoice" });
      }
      return;
    }
    await this.runSync();
  }

  async saveSettings(msg) {
    const config = { ...(this.state.config || {}), ...msg };
    await this.ctx.storage.project.set("config", config);
    this.state.config = config;
    this.broadcast();
    await this.countChanges();
  }

  // First sync where both sides hold content: the user's choice decides
  // which side wins as a whole. The winner's files are recorded as the new
  // base first, so the following sync only moves the loser's changes.
  async firstSync(choice) {
    try {
      const config = this.state.config;
      const root = await textus.files.root();
      const gh = await this.github();
      if (!config || !root || !gh) return;
      const head = await gh.branchHead(config.branch);
      const remote = head ? await gh.treeBlobs(head.tree) : new Map();
      const gitignore = await readGitignore(root);
      const files = await scanFiles(root, gitignore, config.maxFileSize);
      const local = new Map();
      for (const f of files) {
        local.set(f.rel, await blobSha(await textus.files.read(f.path)));
      }
      const fileShas = {};
      if (choice === "push") {
        // Remote loses: treat the remote state as the base, then push ours
        // over it (remote-only files are deleted by the push).
        for (const [rel, info] of remote) fileShas[rel] = info.sha;
      } else {
        // Local loses: pull the remote over ours, keeping remote-only files
        // and deleting local-only ones.
        for (const [rel, sha] of local) fileShas[rel] = sha;
        await this.runSync("pull");
        await this.ctx.storage.project.set("base", {
          commitSha: head ? head.commit : null,
          fileShas: Object.fromEntries(remote),
        });
        this.broadcast();
        return;
      }
      await this.ctx.storage.project.set("base", { commitSha: head ? head.commit : null, fileShas });
      await this.runSync("push");
    } catch (e) {
      this.broadcast({ error: this.errorText(e) });
    }
  }

  async runSync(mode) {
    if (this.busy) return;
    this.busy = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.broadcast({ syncing: true, error: null, progress: { fraction: 0, message: "" } });
    try {
      const config = this.state.config;
      if (!config) {
        this.broadcast({ syncing: false, error: this.t("state.disconnected") });
        return;
      }
      const root = await textus.files.root();
      if (!root) {
        this.broadcast({ syncing: false, error: this.t("state.noFolder") });
        return;
      }
      const gh = await this.github();
      if (!gh) {
        this.broadcast({ syncing: false, error: this.t("error.auth") });
        return;
      }
      const base = (await this.ctx.storage.project.get("base")) || { fileShas: {} };
      const report = (fraction, message) => {
        this.broadcast({ progress: { fraction, message } });
      };
      const result = await synchronize(gh, config, base, root, signal, report, mode);

      if (result.conflicts.length) {
        this.state.conflicts = result.conflicts;
        this.state.synced = false;
        this.broadcast({
          syncing: false,
          conflicts: result.conflicts,
          message: this.t("sync.conflicts", result.conflicts.length),
        });
        return;
      }

      await this.ctx.storage.project.set("base", {
        commitSha: result.head ? result.head.commit : null,
        fileShas: result.fileShas || base.fileShas || {},
      });
      this.state.lastSync = new Date().toISOString();
      this.state.conflicts = null;
      this.state.synced = true;
      this.state.ahead = 0;
      this.state.behind = 0;
      const pushed = result.pushed || 0;
      const pulled = result.pulled || 0;
      this.broadcast({
        syncing: false,
        progress: null,
        message: this.t("state.synced"),
      });
      if (pushed || pulled) {
        textus.ui.notice(
          this.t("sync.done", pushed, pulled),
          { tone: "info" },
        );
      }
      await this.countChanges();
    } catch (e) {
      if (e.name === "AbortError") {
        this.broadcast({ syncing: false, progress: null, message: this.t("state.cancelled") });
      } else {
        this.broadcast({ syncing: false, progress: null, error: this.errorText(e) });
      }
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  async autoPull() {
    if (this.busy) return;
    const config = this.state.config;
    if (!config || !config.autoPull) return;
    const root = await textus.files.root();
    if (!root) return;
    // Only pull when there is nothing local to push, so a pull never races
    // an unsaved edit; the debounced push handles the other direction.
    await this.countChanges();
    if (this.state.ahead > 0 || this.state.conflicts) return;
    await this.runSync("pull");
  }

  async resolveConflict(rel, choice) {
    const root = await textus.files.root();
    const gh = await this.github();
    const base = (await this.ctx.storage.project.get("base")) || { fileShas: {} };
    if (choice === "local") {
      // Keep the local file; next push uploads it over the remote version.
      await this.ctx.storage.project.set("base", {
        ...base,
        fileShas: { ...base.fileShas, [rel]: await blobSha(await textus.files.read(root + "/" + rel)) },
      });
      await this.runSync("push");
    } else if (choice === "remote") {
      // Keep the remote file; overwrite the local one with it.
      const head = await gh.branchHead(this.state.config.branch);
      const remote = await gh.treeBlobs(head.tree);
      const bytes = await gh.getBlob(remote.get(rel).sha);
      await textus.files.write(root + "/" + rel, bytes);
      await this.ctx.storage.project.set("base", {
        ...base,
        fileShas: { ...base.fileShas, [rel]: remote.get(rel).sha },
      });
      await this.runSync("pull");
    } else if (choice === "both") {
      // Keep both: the remote copy becomes a sibling file, the local one wins.
      const head = await gh.branchHead(this.state.config.branch);
      const remote = await gh.treeBlobs(head.tree);
      const bytes = await gh.getBlob(remote.get(rel).sha);
      const stem = rel.replace(/\.[^.]+$/, "");
      const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")) : ".md";
      await textus.files.write(root + "/" + stem + " (remote)" + ext, bytes);
      await this.ctx.storage.project.set("base", {
        ...base,
        fileShas: { ...base.fileShas, [rel]: await blobSha(await textus.files.read(root + "/" + rel)) },
      });
      await this.runSync("push");
    }
  }

  async disconnect() {
    await this.ctx.storage.project.delete("config");
    await this.ctx.storage.project.delete("base");
    await this.ctx.secrets.delete("pat");
    this.state = {
      ...this.state,
      configured: false,
      connected: false,
      config: null,
      login: null,
      conflicts: null,
      ahead: 0,
      behind: 0,
    };
    this.broadcast();
  }

  errorText(e) {
    if (e.kind === "auth") return this.t("error.auth");
    if (e.kind === "rateLimit") return this.t("error.rateLimit");
    if (e.kind === "notFound") return this.t("error.repo");
    if (e.kind === "nonFastForward") return this.t("error.nonFastForward");
    if (e instanceof ApiError) return this.t("error.unknown", e.message);
    return this.t("error.network");
  }
}

// A small debounce + interval scheduler, modeled on the cloud-sync plugin's
// Pacer: a save arms a settle timer; a quiet spell fires the push.
class Pacer {
  constructor(controller, settleMs, pullMinutes) {
    this.controller = controller;
    this.settleMs = settleMs;
    this.timer = null;
    this.since = null;
  }

  saved() {
    this.since = Date.now();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.settleMs);
  }

  async fire() {
    this.timer = null;
    const config = this.controller.state.config;
    if (!config || !config.autoPush) return;
    if (this.controller.busy) return;
    await this.controller.runSync("push");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

exports.activate = function (ctx) {
  const controller = new Controller(ctx);
  ctx.subscriptions.push({ dispose: () => controller.pacer.timer && clearTimeout(controller.pacer.timer) });
  return controller.activate();
};
