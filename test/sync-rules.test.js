// The sync table in README.md, checked without a network or a Textus window.
//
// host.js is a single file with no build step - that is a rule of the plugin
// catalog - so the pure parts are exported at its end and exercised here with
// node --test. Run: node --test
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseRules, isExcluded, hardExcluded, plan, applyPolicy, trashPath, blobSha } = require("../host.js");

const rules = (text) => parseRules(text);
const excluded = (path, text, isDir = false) => isExcluded(path, isDir, rules(text));

test("a bare name is excluded at any depth, as in git", () => {
  assert.equal(excluded(".DS_Store", ".DS_Store"), true);
  assert.equal(excluded("a/b/.DS_Store", ".DS_Store"), true);
  assert.equal(excluded("a/b/.DS_Store.md", ".DS_Store"), false);
});

test("a folder rule takes everything under it", () => {
  assert.equal(excluded("node_modules/pkg/index.js", "node_modules/"), true);
  assert.equal(excluded("deep/node_modules/pkg/index.js", "node_modules/"), true);
  assert.equal(excluded("node_modules.md", "node_modules/"), false);
});

test("a leading slash pins the rule to the top of the folder", () => {
  assert.equal(excluded("secret.md", "/secret.md"), true);
  assert.equal(excluded("notes/secret.md", "/secret.md"), false);
  assert.equal(excluded("docs/x.md", "docs/x.md"), true);
  assert.equal(excluded("old/docs/x.md", "docs/x.md"), false);
});

test("a leading ! puts back what an earlier rule excluded", () => {
  const text = "*.tmp\n!keep.tmp";
  assert.equal(excluded("draft.tmp", text), true);
  assert.equal(excluded("keep.tmp", text), false);
  assert.equal(excluded("a/keep.tmp", text), false);
});

test("comments, blank lines and glob pieces are understood", () => {
  assert.equal(excluded("draft-1.part", "# a comment\n\n*.part"), true);
  assert.equal(excluded("draft-1.part", "# a comment"), false);
  assert.equal(excluded("logs/deep/a.log", "logs/**"), true);
  assert.equal(excluded("a1.md", "a[0-9].md"), true);
  assert.equal(excluded("aB.md", "a[!0-9].md"), true);
  assert.equal(excluded("a1.md", "a[!0-9].md"), false);
});

// A rule can put things back, so the two hard exclusions are checked first
// and no rule can undo them.
const skipped = (path, text) => hardExcluded(path) || isExcluded(path, false, rules(text));

test(".git and .textus are never synced, whatever the rules say", () => {
  assert.equal(skipped(".git/config", ""), true);
  assert.equal(skipped(".git/config", "!.git/\n!.git/config"), true);
  assert.equal(skipped(".textus/plugins/x/y.json", ""), true);
  assert.equal(skipped("notes/a.md", ""), false);
});

// --- the table ----------------------------------------------------------
//
// local: what this folder holds now; remote: what the branch holds now;
// base: the hashes both sides agreed on at the last sync. Every row of the
// README table is one of these.

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
// One fixed moment, so a .trash folder name is predictable: 20261126-040506.
const NOW = Date.UTC(2026, 10, 26, 4, 5, 6);

function entry(sha) {
  return { sha, size: 10 };
}

function run({ local = {}, remote = {}, base = {}, first = false, mode = "merge", onRemoteDelete = "restore", now = NOW } = {}) {
  const toMap = (object) => new Map(Object.entries(object).map(([path, sha]) => [path, entry(sha)]));
  return plan({ local: toMap(local), remote: toMap(remote), base, first, mode, onRemoteDelete, now });
}

const paths = (items) => items.map((item) => item.local ?? item.remote).sort();

test("added here only: it is sent", () => {
  const result = run({ local: { "new.md": A } });
  assert.deepEqual(paths(result.pushes), ["new.md"]);
  assert.equal(result.conflicts.length, 0);
});

test("added on GitHub only: it is received", () => {
  const result = run({ remote: { "new.md": A } });
  assert.deepEqual(result.pulls.map((pull) => pull.local), ["new.md"]);
});

test("changed here only: it is sent", () => {
  const result = run({ local: { "a.md": B }, remote: { "a.md": A }, base: { "a.md": A } });
  assert.deepEqual(paths(result.pushes), ["a.md"]);
});

test("changed on GitHub only: it is received", () => {
  const result = run({ local: { "a.md": A }, remote: { "a.md": B }, base: { "a.md": A } });
  assert.deepEqual(result.pulls.map((pull) => pull.local), ["a.md"]);
});

test("both changed: a conflict, and nothing moves until it is answered", () => {
  const result = run({ local: { "a.md": B }, remote: { "a.md": C }, base: { "a.md": A } });
  assert.deepEqual(result.conflicts.map((conflict) => conflict.kind), ["bothChanged"]);
  assert.equal(result.pushes.length, 0);
  assert.equal(result.pulls.length, 0);
});

test("deleted on GitHub, untouched here: it comes back", () => {
  const restored = run({ local: { "a.md": A }, base: { "a.md": A } });
  assert.deepEqual(paths(restored.pushes), ["a.md"]);

  const deleted = run({ local: { "a.md": A }, base: { "a.md": A }, onRemoteDelete: "delete" });
  assert.deepEqual(deleted.localDeletes.map((item) => item.local), ["a.md"]);
  assert.equal(deleted.pushes.length, 0);
});

test("deleted here, untouched on GitHub: the deletion is sent", () => {
  const result = run({ remote: { "a.md": A }, base: { "a.md": A } });
  assert.deepEqual(result.pushes, [{ local: null, remote: "a.md" }]);
});

test("deleted here, changed on GitHub: a conflict", () => {
  const result = run({ remote: { "a.md": B }, base: { "a.md": A } });
  assert.deepEqual(result.conflicts.map((conflict) => conflict.kind), ["deletedHereChangedThere"]);
});

test("changed here, deleted on GitHub: a conflict", () => {
  const result = run({ local: { "a.md": B }, base: { "a.md": A } });
  assert.deepEqual(result.conflicts.map((conflict) => conflict.kind), ["changedHereDeletedThere"]);
});

test("both sides deleted: the record of the file is dropped", () => {
  const result = run({ base: { "a.md": A } });
  assert.deepEqual(result.dropBase, ["a.md"]);
});

test("unchanged files cost nothing", () => {
  const result = run({ local: { "a.md": A }, remote: { "a.md": A }, base: { "a.md": A } });
  assert.equal(result.unchanged, 1);
  assert.equal(result.pushes.length + result.pulls.length + result.localDeletes.length, 0);
});

test("first connection: the chosen side decides, and a merge asks", () => {
  const same = run({ local: { "a.md": A }, remote: { "a.md": A }, first: true });
  assert.equal(same.unchanged, 1);

  const pushWins = run({ local: { "a.md": B }, remote: { "a.md": C }, first: true, mode: "push" });
  assert.deepEqual(paths(pushWins.pushes), ["a.md"]);

  const pullWins = run({ local: { "a.md": B }, remote: { "a.md": C }, first: true, mode: "pull" });
  assert.deepEqual(pullWins.pulls.map((pull) => pull.local), ["a.md"]);

  const ask = run({ local: { "a.md": B }, remote: { "a.md": C }, first: true });
  assert.deepEqual(ask.conflicts.map((conflict) => conflict.kind), ["bothAdded"]);

  // Only one side has it: nothing to decide.
  assert.deepEqual(paths(run({ local: { "mine.md": A }, remote: { "theirs.md": B }, first: true }).pushes), ["mine.md"]);
  assert.deepEqual(run({ local: { "mine.md": A }, remote: { "theirs.md": B }, first: true }).pulls.map((pull) => pull.local), ["theirs.md"]);
});

// --- policies -----------------------------------------------------------

test("policy local keeps this folder's version", () => {
  const result = applyPolicy(run({ local: { "a.md": B }, remote: { "a.md": C }, base: { "a.md": A } }), "local");
  assert.deepEqual(result.pushes, [{ local: "a.md", remote: "a.md" }]);
  assert.equal(result.conflicts.length, 0);
});

test("policy remote takes GitHub's version", () => {
  const result = applyPolicy(run({ local: { "a.md": B }, remote: { "a.md": C }, base: { "a.md": A } }), "remote");
  assert.deepEqual(result.pulls.map((pull) => pull.local), ["a.md"]);
  assert.equal(result.pulls[0].sha, C);
});

test("policy both keeps GitHub's version in the .trash folder", () => {
  const result = applyPolicy(run({ local: { "notes/a.md": B }, remote: { "notes/a.md": C }, base: { "notes/a.md": A } }), "both", NOW);
  assert.deepEqual(result.pulls, [{ remote: "notes/a.md", local: ".trash/20261126-040506/notes/a.md", sha: C }]);
  assert.deepEqual(result.pushes, [{ local: "notes/a.md", remote: "notes/a.md" }]);
});

test("policy both with a deletion on one side keeps the survivor only", () => {
  // Deleted here, changed on GitHub: the GitHub copy is kept in .trash and
  // the deletion still reaches the branch.
  const deleted = applyPolicy(run({ remote: { "a.md": B }, base: { "a.md": A } }), "both", NOW);
  assert.deepEqual(deleted.pulls.map((pull) => pull.local), [".trash/20261126-040506/a.md"]);
  assert.deepEqual(deleted.pushes, [{ local: null, remote: "a.md" }]);

  // Changed here, deleted on GitHub: there is no second copy to keep.
  const gone = applyPolicy(run({ local: { "a.md": B }, base: { "a.md": A } }), "both", NOW);
  assert.deepEqual(gone.pushes, [{ local: "a.md", remote: "a.md" }]);
  assert.equal(gone.pulls.length, 0);
});

test("a version that loses a conflict goes to the trash, not into the void", () => {
  const local = applyPolicy(run({ local: { "a.md": B }, remote: { "a.md": C }, base: { "a.md": A } }), "local", NOW);
  assert.deepEqual(local.trash, [{ path: ".trash/20261126-040506/a.md", sha: C }]);

  const remote = applyPolicy(run({ local: { "a.md": B }, remote: { "a.md": C }, base: { "a.md": A } }), "remote", NOW);
  assert.deepEqual(remote.trashLocal, [{ from: "a.md", to: ".trash/20261126-040506/a.md" }]);
  assert.deepEqual(remote.pulls.map((pull) => pull.local), ["a.md"]);
});

test("a deletion keeps the copy of the side that loses it", () => {
  // Deleted here, untouched on GitHub: the copy kept is the one GitHub had.
  const gone = run({ remote: { "a.md": A }, base: { "a.md": A } });
  assert.deepEqual(gone.pushes, [{ local: null, remote: "a.md" }]);
  assert.deepEqual(gone.trash, [{ path: ".trash/20261126-040506/a.md", sha: A }]);

  // Deleted on GitHub and the deletion wins: this machine's copy is kept.
  const deleted = run({ local: { "a.md": A }, base: { "a.md": A }, onRemoteDelete: "delete" });
  assert.deepEqual(deleted.trashLocal, [{ from: "a.md", to: ".trash/20261126-040506/a.md" }]);
});

test("a trash path keeps the folder, the extension and a readable time", () => {
  assert.equal(trashPath("Essays/draft.final.md", NOW), ".trash/20261126-040506/Essays/draft.final.md");
  assert.equal(trashPath("README", Date.UTC(2026, 0, 2, 3, 4, 5)), ".trash/20260102-030405/README");
});

test(".trash never syncs back, whatever the rules say", () => {
  assert.equal(skipped(".trash/20261126-040506/a.md", ""), true);
  assert.equal(skipped(".trash/20261126-040506/a.md", "!.trash/\n!.trash/**"), true);
});

// --- hashes -------------------------------------------------------------

test("a blob hash is the one git computes", async () => {
  const bytes = new TextEncoder().encode("hello");
  assert.equal(await blobSha(bytes), "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
});
// --- the entry Textus calls ---------------------------------------------

// Textus loads host.js as a CommonJS module and calls module.exports.activate
// (src/plugins/host/runtime/host-handlers.js, $activate). Anything here that
// replaces module.exports or forgets activate leaves the plugin loaded but
// doing nothing at all - no tab, no command, no message.
test("the module Textus loads still activates", () => {
  const host = require("../host.js");
  assert.equal(typeof host.activate, "function");
  assert.equal(host.activate.length, 1);
});
