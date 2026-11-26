// The panel is a plain page: one state object, one render call. Everything
// it shows comes from host.js through `state` messages, so the UI never
// decides what the sync should do - it only asks.
(function () {
  "use strict";

  const api = acquireTextusApi();
  const byId = (id) => document.getElementById(id);

  let state = null;
  let repos = [];
  let connected = false;

  function t(key, ...args) {
    return api.t(key, ...args);
  }

  function mb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
  }

  function when(ms) {
    return ms ? new Date(ms).toLocaleString() : t("sync.never");
  }

  // Text nodes are filled from l10n keys so a language change needs no
  // rebuild of the page - the same keys are listed in textus-plugin.json.
  function applyL10n() {
    for (const node of document.querySelectorAll("[data-i18n]")) {
      node.textContent = t(node.getAttribute("data-i18n"));
    }
    for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
      node.setAttribute("placeholder", t(node.getAttribute("data-i18n-placeholder")));
    }
  }

  function show(section) {
    for (const id of ["setup", "first", "main"]) byId(id).hidden = id !== section;
  }

  function render() {
    if (!state) return;
    // "configured" means owner + repo are known; until then the panel only
    // asks for a token and a repository, in that order.
    show(state.configured ? "main" : "setup");
    byId("token-step").hidden = state.connected;
    byId("repo-step").hidden = !state.connected;
    if (state.configured) renderMain();
    else renderSetup();
  }

  function renderSetup() {
    byId("setup-error").textContent = state.error || "";
    byId("who").textContent = state.login ? t("state.connected", state.login) : "";
    const select = byId("repos");
    const current = select.value;
    select.textContent = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = t("setup.repo.pick");
    select.append(blank);
    for (const repo of repos) {
      const option = document.createElement("option");
      option.value = repo.fullName;
      option.textContent = repo.fullName + (repo.private ? " " + t("setup.repo.privateTag") : "");
      select.append(option);
    }
    if (current) select.value = current;
  }

  function renderMain() {
    const config = state.config || {};
    byId("repo-name").textContent = (config.owner || "") + "/" + (config.repo || "");
    byId("quota").textContent = state.quota && state.quota.left !== null ? t("sync.quota", state.quota.left) : "";
    byId("last-sync").textContent = state.last
      ? t("sync.last", when(state.last.at), state.last.pushed, state.last.pulled)
      : t("sync.never");
    byId("message").textContent = state.message || "";

    const error = byId("main-error");
    error.hidden = !state.error;
    error.textContent = state.error || "";

    const busy = state.busy;
    for (const id of ["sync", "push", "pull"]) byId(id).disabled = busy;

    const progress = byId("progress");
    progress.hidden = !state.progress;
    if (state.progress) {
      const { stage, done, total } = state.progress;
      byId("progress-label").textContent = t("progress." + stage, done, total);
      byId("progress-bar").style.width = total ? Math.round((done / total) * 100) + "%" : "0%";
    }

    renderConflicts();
    renderSettings(config);
  }

  function renderConflicts() {
    const list = byId("conflicts");
    const items = state.conflicts || [];
    list.hidden = items.length === 0;
    if (!items.length) return;
    const ul = byId("conflict-list");
    ul.textContent = "";
    for (const conflict of items) {
      const li = document.createElement("li");
      const name = document.createElement("code");
      name.textContent = conflict.path;
      const kind = document.createElement("span");
      kind.className = "hint";
      kind.textContent = t("conflict.kind." + conflict.kind);
      const row = document.createElement("div");
      row.className = "row";
      for (const choice of ["local", "remote", "both"]) {
        const button = document.createElement("button");
        button.textContent = t("conflict." + choice);
        button.onclick = () => api.postMessage({ type: "resolve", path: conflict.path, choice });
        row.append(button);
      }
      li.append(name, kind, row);
      ul.append(li);
    }
  }

  function renderSettings(config) {
    byId("auto-push").checked = Boolean(config.autoPush);
    byId("auto-pull").checked = Boolean(config.autoPull);
    byId("pull-minutes").value = config.pullMinutes || 5;
    byId("settle-seconds").value = config.settleSeconds || 5;
    byId("sync-on-open").checked = Boolean(config.syncOnOpen);
    byId("mode").value = config.mode || "merge";
    byId("on-remote-delete").value = config.onRemoteDelete || "restore";
    byId("conflict-policy").value = config.conflictPolicy || "ask";
    byId("max-size").value = Math.round((config.maxFileSize || 0) / (1024 * 1024)) || 20;
    // Only replace the rules while the user is not typing in them, or the
    // text jumps back to the saved version under the cursor.
    if (document.activeElement !== byId("rules")) byId("rules").value = config.rules || "";

    const skipped = byId("skipped");
    const large = state.tooLarge || [];
    const lines = [];
    if (large.length) {
      lines.push(t("settings.tooLarge", large.length));
      for (const item of large.slice(0, 5)) lines.push(item.rel + " (" + mb(item.size) + " MB)");
    }
    if (state.excluded) lines.push(t("settings.excluded", state.excluded));
    skipped.hidden = lines.length === 0;
    skipped.textContent = lines.join("\n");
  }

  // --- messages ----------------------------------------------------------

  api.onDidReceiveMessage((message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "state") {
      state = message.state;
      render();
    } else if (message.type === "repos") {
      repos = message.repos || [];
      renderSetup();
    } else if (message.type === "created") {
      byId("new-repo").value = "";
      byId("create-box").hidden = true;
      const [owner, repo] = String(message.fullName || "").split("/");
      byId("owner").value = owner || "";
      byId("repo").value = repo || "";
      api.postMessage({ type: "repos" });
    } else if (message.type === "firstChoice") {
      byId("first-body").textContent = t("first.body", message.local, message.remote, message.differs);
      show("first");
    } else if (message.type === "progress") {
      state = { ...state, progress: message.progress, busy: true };
      renderMain();
    }
  });

  // --- setup ---------------------------------------------------------------

  byId("connect").onclick = () => {
    const token = byId("token").value.trim();
    if (!token) return;
    byId("setup-error").textContent = "";
    api.postMessage({ type: "connect", token });
  };

  byId("token").addEventListener("keydown", (event) => {
    if (event.key === "Enter") byId("connect").click();
  });

  byId("repos").onchange = () => {
    const value = byId("repos").value;
    if (!value) return;
    const [owner, repo] = value.split("/");
    byId("owner").value = owner;
    byId("repo").value = repo;
  };

  byId("create-toggle").onclick = () => {
    const box = byId("create-box");
    box.hidden = !box.hidden;
  };

  byId("create").onclick = () => {
    const name = byId("new-repo").value.trim();
    if (!name) return;
    api.postMessage({ type: "createRepo", name, private: byId("new-private").checked });
  };

  byId("finish").onclick = () => {
    const owner = byId("owner").value.trim();
    const repo = byId("repo").value.trim();
    if (!owner || !repo) {
      byId("setup-error").textContent = t("error.repoMissing");
      return;
    }
    api.postMessage({ type: "setup", owner, repo, branch: byId("branch").value.trim() || "main" });
  };

  byId("first-push").onclick = () => api.postMessage({ type: "first", choice: "push" });
  byId("first-pull").onclick = () => api.postMessage({ type: "first", choice: "pull" });

  // --- main ----------------------------------------------------------------

  byId("sync").onclick = () => api.postMessage({ type: "sync", mode: byId("mode").value });
  byId("push").onclick = () => api.postMessage({ type: "sync", mode: "push" });
  byId("pull").onclick = () => api.postMessage({ type: "sync", mode: "pull" });

  byId("save-settings").onclick = () => {
    api.postMessage({
      type: "settings",
      autoPush: byId("auto-push").checked,
      autoPull: byId("auto-pull").checked,
      pullMinutes: Number(byId("pull-minutes").value),
      settleSeconds: Number(byId("settle-seconds").value),
      syncOnOpen: byId("sync-on-open").checked,
      mode: byId("mode").value,
      onRemoteDelete: byId("on-remote-delete").value,
      conflictPolicy: byId("conflict-policy").value,
      maxFileSizeMb: Number(byId("max-size").value),
      rules: byId("rules").value,
      commitMessage: byId("commit-message").value,
    });
  };

  byId("disconnect").onclick = () => {
    if (api.confirm && !api.confirm(t("action.disconnect.confirm"))) return;
    api.postMessage({ type: "disconnect" });
  };

  // --- boot ----------------------------------------------------------------

  applyL10n();
  api.postMessage({ type: "ready" });
})();