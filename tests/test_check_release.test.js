/**
 * Release-chain rules. These exist because updates.json once advertised 0.7.7 while release
 * v0.7.7 did not exist: the channel pointed every client at a 404 and nothing noticed.
 *
 * The rules are pure, so they are tested against fabricated inputs; the shipped files are checked
 * too, so a real drift is caught here rather than by a user's update poll.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADDON_ID, inspect, inspectRemote } from "../scripts/check-release.js";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const happy = () => ({
  pkg: { version: "1.2.3" },
  manifest: { version: "1.2.3", applications: { zotero: { update_url: "https://example.test/updates.json" } } },
  updates: {
    addons: {
      [ADDON_ID]: {
        updates: [
          {
            version: "1.2.3",
            update_link: "https://github.test/releases/download/v1.2.3/zotero-ai-agent-1.2.3.xpi"
          }
        ]
      }
    }
  }
});

describe("inspect", () => {
  it("accepts a consistent chain", () => {
    const { fail, updateUrl } = inspect(happy());
    assert.deepEqual(fail, []);
    assert.equal(updateUrl, "https://example.test/updates.json");
  });

  it("rejects updates.json advertising a version that was never built", () => {
    // The exact regression: local build 1.2.3, channel promises 1.4.0.
    const input = happy();
    input.updates.addons[ADDON_ID].updates[0].version = "1.4.0";
    const { fail } = inspect(input);
    assert.equal(fail.length, 1);
    assert.match(fail[0], /updates\.json advertises 1\.4\.0, package\.json is 1\.2\.3/);
  });

  it("rejects an update_link built from a different version", () => {
    const input = happy();
    input.updates.addons[ADDON_ID].updates[0].update_link = "https://github.test/releases/download/v1.0.0/x.xpi";
    assert.match(inspect(input).fail[0], /update_link does not point at/);
  });

  it("rejects a package/manifest version split", () => {
    const input = happy();
    input.manifest.version = "9.9.9";
    assert.match(inspect(input).fail[0], /package\.json 1\.2\.3 != manifest\.json 9\.9\.9/);
  });

  it("rejects an add-on entry missing from updates.json", () => {
    const { fail } = inspect({ ...happy(), updates: { addons: {} } });
    assert.match(fail[0], /no entry for/);
  });

  it("rejects a manifest with no update_url", () => {
    const input = happy();
    delete input.manifest.applications.zotero.update_url;
    assert.match(inspect(input).fail[0], /declares no update_url/);
  });
});

describe("inspectRemote", () => {
  const fakeFetch = (responses) => async (url, opts = {}) => {
    const hit = responses.find((r) => url.startsWith(r.url));
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    return {
      ok: hit.status === 200,
      status: hit.status,
      json: async () => hit.body,
      method: opts.method
    };
  };

  const entry = (version) => ({
    addons: {
      [ADDON_ID]: {
        updates: [{ version, update_link: "https://github.test/releases/download/v1.2.3/zotero-ai-agent-1.2.3.xpi" }]
      }
    }
  });

  it("passes when the published copy and the asset agree", async () => {
    const { fail, ok } = await inspectRemote({
      pkg: { version: "1.2.3" },
      updateUrl: "https://example.test/updates.json",
      fetchImpl: fakeFetch([
        { url: "https://example.test/updates.json", status: 200, body: entry("1.2.3") },
        { url: "https://github.test/releases/download/v1.2.3/", status: 200, body: {} }
      ])
    });
    assert.deepEqual(fail, []);
    assert.equal(ok.length, 2);
  });

  it("fails when the asset 404s", async () => {
    const { fail } = await inspectRemote({
      pkg: { version: "1.2.3" },
      updateUrl: "https://example.test/updates.json",
      fetchImpl: fakeFetch([
        { url: "https://example.test/updates.json", status: 200, body: entry("1.2.3") },
        { url: "https://github.test/releases/download/v1.2.3/", status: 404, body: {} }
      ])
    });
    assert.match(fail[0], /release asset HTTP 404/);
  });

  it("fails when the published copy lags the local build", async () => {
    const { fail } = await inspectRemote({
      pkg: { version: "1.2.3" },
      updateUrl: "https://example.test/updates.json",
      fetchImpl: fakeFetch([{ url: "https://example.test/updates.json", status: 200, body: entry("1.2.2") }])
    });
    assert.match(fail[0], /advertises 1\.2\.2, local is 1\.2\.3/);
  });

  it("fails when the published copy is unreachable", async () => {
    const { fail } = await inspectRemote({
      pkg: { version: "1.2.3" },
      updateUrl: "https://example.test/updates.json",
      fetchImpl: fakeFetch([{ url: "https://example.test/updates.json", status: 404, body: {} }])
    });
    assert.match(fail[0], /unreachable/);
  });
});

describe("the repository's own release chain", () => {
  it("is consistent right now", () => {
    const { fail } = inspect({
      pkg: read("package.json"),
      manifest: read("manifest.json"),
      updates: read("updates.json")
    });
    assert.deepEqual(fail, [], "bump package.json, manifest.json and updates.json together");
  });
});
