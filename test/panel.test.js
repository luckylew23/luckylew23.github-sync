// The panel is one document serving two pages: the sidebar tab and the
// plugin's page in Settings. Which one is rendered comes from `data-place`,
// which host.js sets on <body>; a page that loses it would show the other
// page's form or buttons. Strings are checked here too, because a key that
// is missing from the manifest's l10n shows up in the interface as the key.
const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const html = readFileSync(join(root, "panel.html"), "utf8");
const script = readFileSync(join(root, "panel.js"), "utf8");
const host = readFileSync(join(root, "host.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "textus-plugin.json"), "utf8"));

test("the Settings page carries the form and the sidebar does not", () => {
  assert.match(html, /id="settings-page"/);
  assert.match(html, /id="settings-page"[\s\S]*id="token"/);
  assert.match(html, /id="settings-page"[\s\S]*id="rules"/);
});

test("the panel reads data-place and the host sets it", () => {
  assert.match(script, /dataset\.place/);
  assert.match(host, /data-place="settings"/);
});

test("every string the panel uses exists in every language", () => {
  const used = new Set([
    ...[...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map((match) => match[1]),
    // `t("progress." + stage)` and the like are prefixes, not keys.
    ...[...script.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]).filter((key) => !key.endsWith(".")),
  ]);
  for (const [language, strings] of Object.entries(manifest.l10n)) {
    for (const key of used) {
      assert.equal(typeof strings[key], "string", `${language}: ${key}`);
    }
  }
});
