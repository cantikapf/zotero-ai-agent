/**
 * Preferences pane + Tools menu contract.
 * The pane registers against verified Zotero 7 APIs only; a wrong shape here fails silently at
 * runtime (the pane just never appears), so the shapes are pinned in tests.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const bootstrap = readFileSync("src/bootstrap.ts", "utf8");
const pane = readFileSync("addon/preferences.xhtml", "utf8");
const prefs = readFileSync("addon/prefs.js", "utf8");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

test("pane registers via Zotero.PreferencePanes.register with pluginID + src", () => {
  assert.match(bootstrap, /Zotero\.PreferencePanes\?\.register/);
  assert.match(bootstrap, /pluginID: options\.pluginID/);
  assert.match(bootstrap, /src: options\.rootURI \+ PREF_PANE_SRC/);
  // Pane is auto-unregistered on plugin shutdown by Zotero itself — calling it again throws.
  assert.doesNotMatch(bootstrap, /PreferencePanes\.unregister/);
});

test("pane fragment carries no XML prolog and no page-level namespaces", () => {
  // parseXULToFragment wraps the fragment in its own <div xmlns=...>; a prolog or a second
  // root namespace declaration makes it not well-formed ("not well-formed XHTML" at load).
  assert.doesNotMatch(pane, /^<\?xml/);
  assert.doesNotMatch(pane, /xmlns:/);
  assert.match(pane, /\n<vbox>/);
});

test("every input binds a full pref key that prefs.js also declares", () => {
  const bound = [...pane.matchAll(/preference="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((key) => key.startsWith("extensions."));
  assert.deepEqual(bound, [
    "extensions.zotero-ai-agent.baseUrl",
    "extensions.zotero-ai-agent.model",
    "extensions.zotero-ai-agent.apiKey",
    "extensions.zotero-ai-agent.answerLanguage",
    "extensions.zotero-ai-agent.contextChars",
    "extensions.zotero-ai-agent.useExternalSources",
    "extensions.zotero-ai-agent.obsidianExportDir",
    "extensions.zotero-ai-agent.bridgeToken"
  ]);
  const declared = [...prefs.matchAll(/pref\("([^"]+)"/g)].map((m) => m[1]);
  for (const key of bound) assert.ok(declared.includes(key), `${key} missing from prefs.js`);
});

test("api key field is masked", () => {
  assert.match(pane, /id="zaa-apiKey" type="password"/);
  assert.doesNotMatch(prefs, /pref\("extensions\.zotero-ai-agent\.apiKey",\s*"[^"]+"/);
});

test("Tools menu item is injected into menu_ToolsPopup and removed on shutdown", () => {
  assert.match(bootstrap, /getElementById\("menu_ToolsPopup"\)/);
  assert.match(bootstrap, /createXULElement\("menuitem"\)/);
  assert.ok(bootstrap.indexOf("addToolsMenuItem(win)") > 0);
  // shutdown must sweep open windows, otherwise disabling leaves a dead menu entry.
  const shutdown = bootstrap.slice(bootstrap.indexOf("export function shutdown"));
  assert.match(shutdown, /removeToolsMenuItem\(win\)/);
});

test("window hooks are published to the sandbox scope", () => {
  assert.match(
    bootstrap,
    /Object\.assign\(scope, \{[^}]*onMainWindowLoad[^}]*onMainWindowUnload[^}]*\}/
  );
});

test("xpi staging includes addon assets", () => {
  const build = readFileSync("scripts/build.js", "utf8");
  assert.match(build, /cpSync\(join\(root, "addon"\), stage/);
});

test("version is in sync across package.json and manifest.json", () => {
  assert.equal(pkg.version, manifest.version);
});

test("readers restored from the last session get injected at startup", () => {
  // renderToolbar never fires for tabs restored on launch: the reader's React toolbar mounts
  // before the plugin listener exists. Startup must sweep Zotero.Reader._readers and retry
  // while the reader document is still mounting.
  assert.match(bootstrap, /function injectOpenReaders/);
  assert.match(bootstrap, /Zotero\.Reader\?\._readers/);
  assert.match(bootstrap, /doc\.querySelector\("\.toolbar \.end"\)/);
  assert.match(bootstrap, /setTimeout\(\(\) => injectOpenReaders\(attempt \+ 1\)/);
  const startupBody = bootstrap.slice(bootstrap.indexOf("export async function startup"));
  assert.match(startupBody, /injectOpenReaders\(\)/);
});
