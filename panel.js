// The panel is a plain page: one state object, one render call. Everything
// it shows comes from host.js through `state` messages, so the UI never
// decides what the sync should do - it only asks.
//
// One document serves both of the plugin's pages: the sidebar tab (status
// and buttons) and its page in Settings (everything that can be changed).
// host.js sets `data-place` on <body> when it loads the page, and each side
// renders only the sections that exist there.
(function () {
  "use strict";

  const api = acquireTextusApi();
  const byId = (id) => document.getElementById(id);
  const place = document.body.dataset.place === "settings" ? "settings" : "sidebar";

  let state = null;
  let repos = [];

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

  // A place has only its own elements: the sidebar has no form, the
  // Settings page has no sync buttons. Nothing here may throw on the other
  // page's ids.
  function add(id, event, handler) {
    const node = byId(id);
    if (node) node.addEventListener(event, handler);
  }

  function show(section) {
    for (const id of ["setup", "first", "main", "settings-page"]) {
      const node = byId(id);
      if (node) node.hidden = id !== section;
    }
  }

  // A field waits for the user to leave it before it is written again, or
  // a broadcast arriving while someone types would undo the edit.
  function fill(id, value) {
    const node = byId(id);
    if (node && document.activeElement !== node) node.value = value;
  }

  function render() {
    if (!state) return;
    if (place === "settings") {
      show("settings-page");
      renderForm(state.config || {});
      return;
    }
    // The first sync asks which side wins. The question travels in the
    // state, so a sidebar opened for it after the ask still sees it.
    if (state.firstChoice && byId("first-body")) {
      const { local, remote, differs } = state.firstChoice;
      byId("first-body").textContent = t("first.body", local, remote, differs);
      show("first");
      return;
    }
    // "configured" means owner + repo are known; until then the sidebar
    // only points at the Settings page, where the token and the repository
    // are chosen.
    show(state.configured ? "main" : "setup");
    if (state.configured) renderMain();
  }

  // --- sidebar ------------------------------------------------------------

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

  // --- the plugin's page in Settings ---------------------------------------

  function renderForm(config) {
    byId("who").textContent = state.login ? t("state.account", state.login) : t("state.disconnected");

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
    select.value = current || (config.owner && config.repo ? config.owner + "/" + config.repo : "");

    fill("owner", config.owner || "");
    fill("repo", config.repo || "");
    fill("branch", config.branch || "main");

    byId("mode").value = config.mode || "merge";
    byId("auto-push").checked = Boolean(config.autoPush);
    byId("auto-pull").checked = Boolean(config.autoPull);
    fill("pull-minutes", String(config.pullMinutes || 5));
    fill("settle-seconds", String(config.settleSeconds || 5));
    byId("sync-on-open").checked = Boolean(config.syncOnOpen);
    byId("on-remote-delete").value = config.onRemoteDelete || "restore";
    byId("conflict-policy").value = config.conflictPolicy || "ask";
    fill("max-size", String(Math.round((config.maxFileSize || 0) / (1024 * 1024)) || 20));
    // The rules are the one field a broadcast must never touch mid-typing:
    // the text would jump back to the saved version under the cursor.
    fill("rules", config.rules || "");
    fill("commit-message", config.commitMessage || "");

    byId("settings-error").textContent = state.error || "";

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

  // --- messages ------------------------------------------------------------

  api.onDidReceiveMessage((message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "state") {
      state = message.state;
      render();
    } else if (message.type === "repos") {
      repos = message.repos || [];
      render();
    } else if (message.type === "created") {
      byId("new-repo").value = "";
      byId("create-box").hidden = true;
      byId("owner").value = String(message.fullName || "").split("/")[0] || "";
      byId("repo").value = String(message.fullName || "").split("/")[1] || "";
      api.postMessage({ type: "repos" });
    } else if (message.type === "progress" && byId("progress")) {
      state = { ...state, progress: message.progress, busy: true };
      renderMain();
    }
  });

  // --- the sidebar's buttons and the Settings page's form ------------------

  for (const button of document.querySelectorAll(".open-settings")) {
    button.onclick = () => api.postMessage({ type: "openSettings" });
  }
  for (const button of document.querySelectorAll(".open-tab")) {
    button.onclick = () => api.postMessage({ type: "openTab" });
  }

  add("first-push", "click", () => api.postMessage({ type: "first", choice: "push" }));
  add("first-pull", "click", () => api.postMessage({ type: "first", choice: "pull" }));

  add("sync", "click", () =>
    api.postMessage({ type: "sync", mode: (state && state.config && state.config.mode) || "merge" }),
  );
  add("push", "click", () => api.postMessage({ type: "sync", mode: "push" }));
  add("pull", "click", () => api.postMessage({ type: "sync", mode: "pull" }));

  add("connect", "click", () => {
    const token = byId("token").value.trim();
    if (!token) return;
    byId("settings-error").textContent = "";
    api.postMessage({ type: "connect", token });
  });

  add("token", "keydown", (event) => {
    if (event.key === "Enter") byId("connect").click();
  });

  add("repos", "change", () => {
    const value = byId("repos").value;
    if (!value) return;
    const [owner, repo] = value.split("/");
    byId("owner").value = owner;
    byId("repo").value = repo;
  });

  add("create-toggle", "click", () => {
    const box = byId("create-box");
    box.hidden = !box.hidden;
  });

  add("create", "click", () => {
    const name = byId("new-repo").value.trim();
    if (!name) return;
    api.postMessage({ type: "createRepo", name, private: byId("new-private").checked });
  });

  add("finish", "click", () => {
    const owner = byId("owner").value.trim();
    const repo = byId("repo").value.trim();
    if (!owner || !repo) {
      byId("settings-error").textContent = t("error.repoMissing");
      return;
    }
    api.postMessage({ type: "setup", owner, repo, branch: byId("branch").value.trim() || "main" });
  });

  add("save-settings", "click", () => {
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
  });

  add("disconnect", "click", () => {
    if (api.confirm && !api.confirm(t("action.disconnect.confirm"))) return;
    api.postMessage({ type: "disconnect" });
  });

  // --- boot ----------------------------------------------------------------

  applyL10n();
  api.postMessage({ type: "ready" });
})();