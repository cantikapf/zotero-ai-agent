/**
 * Build: esbuild bundles src/bootstrap.ts into a single classic-script bootstrap.js, then
 * stages manifest.json + bootstrap.js + addon/ (prefs.js, preferences.xhtml) + install-info.json
 * and zips them into an .xpi.
 *
 * Zotero loads bootstrap.js with Services.scriptloader.loadSubScriptWithOptions into a
 * Cu.Sandbox (chrome/content/zotero/xpcom/plugins.js), so the artifact MUST be a classic
 * script - a plain tsc emit of ES modules would throw on `import` and never start.
 * Type checking stays in `npm run typecheck`; this script only bundles.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const build = join(root, "build");
const stage = join(build, "stage");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(build, `${pkg.name}-${pkg.version}.xpi`);

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

rmSync(build, { recursive: true, force: true });
run(npx, [
  "esbuild",
  "src/bootstrap.ts",
  "--bundle",
  "--format=iife",
  "--platform=browser",
  "--target=firefox115",
  "--outfile=dist/bootstrap.js",
  "--log-level=warning"
]);

mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist", "bootstrap.js"), join(stage, "bootstrap.js"));
cpSync(join(root, "manifest.json"), join(stage, "manifest.json"));
// prefs.js = default prefs, loaded by Zotero's plugin loader (xpcom/plugins.js:setDefaultPrefs
// uses addon.getResourceURI("prefs.js")), so it must sit at the xpi root.
// preferences.xhtml = PreferencePanes fragment, referenced as <rootURI>/preferences.xhtml.
cpSync(join(root, "addon"), stage, { recursive: true });
writeFileSync(
  join(stage, "install-info.json"),
  JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2)
);

// Native archive tool, no dependency: zip(1) when present, PowerShell otherwise.
// PowerShell's Compress-Archive rejects a .xpi extension, so it writes .zip and we rename
// (an .xpi is just a zip).
// stdio: "ignore" so a missing zip(1) on Windows does not spam "not recognized" to stderr.
try {
  execFileSync("zip", ["-qr", out, "."], { cwd: stage, stdio: "ignore" });
} catch {
  const zipPath = out.replace(/\.xpi$/, ".zip");
  run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`
  ]);
  renameSync(zipPath, out);
}

console.log(`built ${out}`);