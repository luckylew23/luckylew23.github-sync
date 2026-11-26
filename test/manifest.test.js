// The manifest as Textus itself reads it: `parseManifest` in the app accepts
// a plugin only when every field has the type its reader wants, and a plugin
// whose manifest it rejects shows up nowhere - no tab, no status item, no
// word anywhere but the plugins page. The plugins repository's `check` is
// looser than that, so this test holds the types the app insists on.
const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "textus-plugin.json"), "utf8"));

test("the manifest's id is publisher.name, lowercase", () => {
  assert.match(manifest.id, /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/);
});

test("the manifest's version is a version", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

test("who wrote it is a line of text, not an object", () => {
  // The app: `text(m.author, "author", true)`. An object throws there, and a
  // plugin that fails to parse is turned off before it says a word.
  assert.equal(typeof manifest.author, "string");
  assert.equal(typeof manifest.repository, "string");
  assert.equal(typeof manifest.license, "string");
  assert.equal(typeof manifest.main, "string");
});

test("what the app is told to load is here", () => {
  for (const file of [manifest.main, manifest.icon]) {
    assert.ok(existsSync(join(root, file)), `${file} is missing`);
  }
});

test("every language it names is there, and so is every string it uses", () => {
  const languages = Object.keys(manifest.l10n ?? {});
  assert.ok(languages.includes("en") && languages.includes("zh"));
  for (const [language, strings] of Object.entries(manifest.l10n)) {
    for (const key of ["name", "description", "tab.title", "status.tooltip"]) {
      assert.equal(typeof strings[key], "string", `${language}: ${key}`);
    }
  }
});