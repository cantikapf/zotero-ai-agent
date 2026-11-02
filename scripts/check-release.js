#!/usr/bin/env node
/**
 * Release consistency check.
 *
 * Written because this exact failure shipped once: `updates.json` advertised 0.7.7 while release
 * v0.7.7 did not exist, so every client that polled the channel got a 404 on `update_link`. The
 * version numbers live in three files plus a git tag, and nothing compared them.
 *
 * Offline by default. `--remote` also fetches the published `updates.json` and the asset it points
 * at, which is the only way to catch a push that never reached the branch the manifest names.
 */

import { readFileSync } from "node:fs";

const ADDON_ID = "zotero-ai-agent@cantikapf.github.io";
const fail = [];
const ok = [];

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

const pkg = read("package.json");
const manifest = read("manifest.json");
const updates = read("updates.json");

if (pkg.version !== manifest.version) {
  fail.push(`package.json ${pkg.version} != manifest.json ${manifest.version}`);
} else {
  ok.push(`version ${pkg.version} in package.json + manifest.json`);
}

const entry = updates.addons?.[ADDON_ID]?.updates?.[0];
if (!entry) {
  fail.push(`updates.json has no entry for ${ADDON_ID}`);
} else if (entry.version !== pkg.version) {
  // The dangerous direction is updates.json ahead of the build: clients then chase a missing file.
  fail.push(`updates.json advertises ${entry.version}, package.json is ${pkg.version}`);
} else {
  ok.push(`updates.json advertises ${entry.version}`);
  const expected = `releases/download/v${pkg.version}/zotero-ai-agent-${pkg.version}.xpi`;
  if (!String(entry.update_link || "").includes(expected)) {
    fail.push(`update_link does not point at ${expected}`);
  } else {
    ok.push("update_link matches the version");
  }
}

const updateUrl = manifest.applications?.zotero?.update_url || "";
if (!updateUrl) {
  fail.push("manifest.json declares no update_url");
} else {
  ok.push(`update_url ${updateUrl}`);
}

if (process.argv.includes("--remote")) {
  const bust = `?cb=${Date.now()}`;
  const published = await fetch(updateUrl + bust, { redirect: "follow" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((e) => {
      fail.push(`published updates.json unreachable: ${e.message}`);
      return null;
    });
  if (published) {
    const remote = published.addons?.[ADDON_ID]?.updates?.[0];
    if (remote?.version !== pkg.version) {
      fail.push(`published updates.json advertises ${remote?.version ?? "nothing"}, local is ${pkg.version}`);
    } else {
      ok.push("published updates.json matches");
      const asset = await fetch(remote.update_link + bust, { method: "HEAD", redirect: "follow" })
        .then((r) => r.status)
        .catch(() => 0);
      if (asset !== 200) fail.push(`release asset HTTP ${asset} at ${remote.update_link}`);
      else ok.push("release asset responds 200");
    }
  }
}

for (const line of ok) console.log(`  ok   ${line}`);
for (const line of fail) console.log(`  FAIL ${line}`);
console.log(fail.length ? `\n${fail.length} problem(s)` : `\nrelease chain consistent at ${pkg.version}`);
process.exit(fail.length ? 1 : 0);
