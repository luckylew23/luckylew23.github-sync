// GitHub Sync panel. Talks to host.js over the Textus webview channel:
// postMessage up, onDidReceiveMessage down. All strings come from the
// manifest's l10n through textus's own t(), so the panel has no hardcoded
// copy.

const api = acquireTextusApi();

const $ = (id) => document.getElementById(id);

// The current state broadcast from the host; kept to render conflicts and
// to enable/disable buttons.
let state = null;

// --- l10n ---------------------------------------------------------------

function applyL10n() {
  const t = (key) => api.t(key);
  $("setup-title").textContent = t("setup.title");
  $("token-label").textContent = t("setup.token");
  $("token-hint").textContent = t("setup.token.hint");
  $("token").placeholder = t("setup.token.placeholder");
  $("connect").textContent = t("setup.connect");
  $("repo-label").textContent = t("setup.repo");
  $("repo-input").placeholder = t("setup.repo.placeholder");
  $("branch-label").textContent = t("setup.branch");
  $("branch-input").placeholder = t("setup.branch.placeholder");
  $("finish").textContent = t("setup.finish");
  $("repo-input").dataset.create = t("setup.repo.create");
  $("first-push").textContent = t("setup.first.push");
  $("first-pull").textContent = t("setup.first.pull");
  $("first-cancel").textContent = t("setup.first.cancel");
  $("sync").textContent = t("action.sync");
  $("push").textContent = t("action.push");
  $("pull").textContent = t("action.pull");
  $("commit-message").placeholder = t("commit.placeholder");
  $("bound").textContent = t("platform.github");
  $("save-settings").textContent = t("action.saveSettings");
  $("disconnect").textContent = t("action.disconnect");
  $("conflicts-title").textContent = t("conflict.title");
  $("settings-title").textContent = t("action.settings");
  $("auto-push-label").textContent = t("settings.autoPush");
  $("auto-push-hint").textContent = t("settings.autoPush.hint");
  $("auto-pull-label").textContent = t("settings.autoPull");
  $("auto-pull-hint").textContent = t("settings.autoPull.hint");
  $("auto-sync-on-open-label").textContent = t("settings.autoSyncOnOpen");
  $("pull-minutes-label").textContent = t("settings.autoPullEvery");
  $("sync-mode-label").textContent = t("settings.syncMode");
  $("conflict-policy-label").textContent = t("settings.conflictPolicy");
  $("exclude-label").textContent = t("settings.exclude");
  $("exclude-hint").textContent = t("settings.exclude.hint");
  $("max-size-label").textContent = t("settings.maxSize");
  for (const [id, keys] of [
    ["pull-minutes", [5, 10, 15, 30, 60]],
    ["sync-mode", ["both", "push", "pull"]],
    ["conflict-policy", ["ask", "local", "remote", "both"]],
  ]) {
    const select = $(id);
    select.textContent = "";
    for (const key of keys) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = typeof key === "number"
        ? api.t("settings.minutes", key)
        : api.t("settings." + id.replace(/-/g, "") + "." + key);
      select.append(option);
    }
  }
}

// --- phases -------------------------------------------------------------

function show(phase) {
  $("setup").hidden = phase !== "setup";
  $("first").hidden = phase !== "first";
  $("main").hidden = phase !== "main";
}

// --- main view ----------------------------------------------------------

function render(state) {
  if (state.configured) {
    show("main");
    $("repo-name").textContent = state.config.owner + "/" + state.config.repo;
    renderStatus(state);
    renderConflicts(state);
    renderSettings(state);
  } else if (state.connected) {
    show("setup");
    $("step-repo").hidden = false;
  } else {
    show("setup");
    $("step-token").hidden = false;
  }
  setBusy(state.syncing);
}

function renderStatus(state) {
  const last = $("last-sync");
  const pushed = state.lastPush ? api.t("sync.last", new Date(state.lastPush).toLocaleString()) : "";
  const pulled = state.lastPull ? api.t("sync.last", new Date(state.lastPull).toLocaleString()) : "";
  last.textContent = [
    api.t("sync.lastPush") + " " + (pushed || api.t("sync.never")),
    api.t("sync.lastPull") + " " + (pulled || api.t("sync.never")),
  ].join("   ");
  const bits = [];
  if (state.ahead) bits.push(api.t("sync.ahead", state.ahead));
  if (state.behind) bits.push(api.t("sync.behind", state.behind));
  if (state.conflicts) bits.push(api.t("sync.conflicts", state.conflicts.length));

  const message = $("message");
  if (state.syncing && state.progress) {
    message.hidden = false;
    message.textContent = state.progress.message || "";
    const bar = $("progress-bar");
    $("progress").hidden = false;
    bar.style.width = Math.round((state.progress.fraction || 0) * 100) + "%";
  } else if (bits.length) {
    message.hidden = false;
    message.textContent = bits.join(" · ");
    $("progress").hidden = true;
  } else {
    message.hidden = true;
    $("progress").hidden = true;
  }

  const error = $("main-error");
  error.hidden = !state.error;
  error.textContent = state.error || "";
}

function renderConflicts(state) {
  const box = $("conflicts");
  if (!state.conflicts || !state.conflicts.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const list = $("conflict-list");
  list.textContent = "";
  for (const conflict of state.conflicts) {
    const li = document.createElement("li");
    li.className = "conflict";
    const file = document.createElement("div");
    file.className = "file";
    file.textContent = conflict.rel;
    const resolve = document.createElement("div");
    resolve.className = "resolve";
    resolve.append(
      button(api.t("conflict.local"), () => resolve_(conflict.rel, "local")),
      button(api.t("conflict.remote"), () => resolve_(conflict.rel, "remote")),
      button(api.t("conflict.both"), () => resolve_(conflict.rel, "both")),
    );
    li.append(file, resolve);
    list.append(li);
  }
}

function renderSettings(state) {
  const config = state.config || {};
  $("auto-push").checked = config.autoPush !== false;
  $("auto-pull").checked = config.autoPull !== false;
  $("auto-sync-on-open").checked = config.autoSyncOnOpen === true;
  $("pull-minutes").value = String(config.autoPullMinutes || 5);
  $("sync-mode").value = config.syncMode || "both";
  $("conflict-policy").value = config.conflictPolicy || "ask";
  $("exclude").value = (config.exclude || []).join("\n");
  $("max-size").value = String(Math.round((config.maxFileSize || 10 * 1024 * 1024) / (1024 * 1024)));
  if (document.activeElement !== $("commit-message")) {
    $("commit-message").value = config.commitMessage || "";
  }
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function setBusy(busy) {
  for (const id of ["sync", "push", "pull", "connect", "finish", "save-settings"]) {
    $(id).disabled = busy;
  }
}

// The commit line travels with the button press, so the click can never
// race a separate settings save that has not reached the host yet.
function syncMessage(type) {
  return { type, commitMessage: $("commit-message").value.trim() };
}

// --- events -------------------------------------------------------------

$("connect").addEventListener("click", () => {
  const token = $("token").value.trim();
  if (!token) return;
  $("connect").disabled = true;
  $("connect").textContent = api.t("setup.connecting");
  api.postMessage({ type: "connect", token });
});

$("finish").addEventListener("click", () => {
  const repo = $("repo-input").value.trim();
  if (!repo.includes("/")) return;
  const [owner, name] = repo.split("/");
  $("finish").disabled = true;
  $("finish").textContent = api.t("setup.finishing");
  api.postMessage({
    type: "setup",
    owner,
    repo: name,
    branch: $("branch-input").value.trim() || "main",
  });
});

// Typing an owner picks the repo; typing a name offers to create it.
$("repo-input").addEventListener("input", () => {
  const value = $("repo-input").value.trim();
  const list = $("repo-list");
  if (!value.includes("/") && window.repos) {
    list.hidden = false;
    list.textContent = "";
    const needle = value.toLowerCase();
    for (const repo of window.repos) {
      if (!repo.full_name.toLowerCase().includes(needle)) continue;
      const b = document.createElement("button");
      b.textContent = repo.full_name;
      b.addEventListener("click", () => {
        $("repo-input").value = repo.full_name;
        list.hidden = true;
      });
      list.append(b);
    }
  } else {
    list.hidden = true;
  }
});

$("sync").addEventListener("click", () => api.postMessage(syncMessage("sync")));
$("push").addEventListener("click", () => api.postMessage(syncMessage("push")));
$("pull").addEventListener("click", () => api.postMessage(syncMessage("pull")));
$("first-push").addEventListener("click", () => api.postMessage({ type: "firstSync", choice: "push" }));
$("first-pull").addEventListener("click", () => api.postMessage({ type: "firstSync", choice: "pull" }));
$("first-cancel").addEventListener("click", () => api.postMessage({ type: "setupCancel" }));
$("disconnect").addEventListener("click", () => api.postMessage({ type: "disconnect" }));
$("save-settings").addEventListener("click", () => api.postMessage({
  type: "settings",
  autoPush: $("auto-push").checked,
  autoPull: $("auto-pull").checked,
  autoSyncOnOpen: $("auto-sync-on-open").checked,
  autoPullMinutes: Number($("pull-minutes").value) || 5,
  syncMode: $("sync-mode").value,
  conflictPolicy: $("conflict-policy").value,
  exclude: $("exclude").value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
  maxFileSize: (Number($("max-size").value) || 10) * 1024 * 1024,
  commitMessage: $("commit-message").value.trim(),
}));

function resolve_(rel, choice) {
  api.postMessage({ type: "resolveConflict", rel, choice });
}

// --- host messages ------------------------------------------------------

api.onDidReceiveMessage((msg) => {
  if (msg.type === "state") {
    state = msg.state;
    render(state);
  } else if (msg.type === "repos") {
    window.repos = msg.repos;
    if (state && !state.configured) $("step-repo").hidden = false;
  } else if (msg.type === "repoCreated") {
    $("repo-input").value = msg.fullName;
  } else if (msg.type === "firstChoice") {
    show("first");
  }
});

applyL10n();
api.postMessage({ type: "ready" });
