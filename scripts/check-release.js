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
import { pathToFileURL } from "node:url";

export const ADDON_ID = "zotero-ai-agent@cantikapf.github.io";

/** Version-chain rules. Pure: no fs, no network, so a test can call it directly. */
export function inspect({ pkg, manifest, updates }) {
  const fail = [];
  const ok = [];

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

  return { ok, fail, updateUrl };
}

/**
 * Compares the published copy and the asset it points at.
 * `fetchImpl` is injected so a test can answer without touching the network.
 */
export async function inspectRemote({ pkg, updateUrl, fetchImpl = fetch }) {
  const bust = `?cb=${Date.now()}`;
  const published = await fetchImpl(updateUrl + bust, { redirect: "follow" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((e) => ({ error: e.message }));
  if (published.error) {
    return { ok: [], fail: [`published updates.json unreachable: ${published.error}`] };
  }

  const remote = published.addons?.[ADDON_ID]?.updates?.[0];
  if (remote?.version !== pkg.version) {
    return {
      ok: [],
      fail: [`published updates.json advertises ${remote?.version ?? "nothing"}, local is ${pkg.version}`]
    };
  }

  const asset = await fetchImpl(remote.update_link + bust, { method: "HEAD", redirect: "follow" })
    .then((r) => r.status)
    .catch(() => 0);
  return asset === 200
    ? { ok: ["published updates.json matches", "release asset responds 200"], fail: [] }
    : { ok: ["published updates.json matches"], fail: [`release asset HTTP ${asset} at ${remote.update_link}`] };
}

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

// Only run as a CLI: importing this module must not read the repo or exit the process, or the
// test that imports it would take `node --test` down with it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = read("package.json");
  const { ok, fail, updateUrl } = inspect({
    pkg,
    manifest: read("manifest.json"),
    updates: read("updates.json")
  });

  if (process.argv.includes("--remote") && updateUrl) {
    const remote = await inspectRemote({ pkg, updateUrl });
    ok.push(...remote.ok);
    fail.push(...remote.fail);
  }

  for (const line of ok) console.log(`  ok   ${line}`);
  for (const line of fail) console.log(`  FAIL ${line}`);
  console.log(fail.length ? `\n${fail.length} problem(s)` : `\nrelease chain consistent at ${pkg.version}`);
  process.exit(fail.length ? 1 : 0);
}
