// Checks a built site before it is published, and the live site after.
// Usage:
//   node .github/ucl/check-release.mjs built <site-dir>
//   node .github/ucl/check-release.mjs live <site-url>
// Expected values come from the release workflow's environment:
//   MOODLE_REF, MOODLE_COMMIT, ADDON_PROXY_URL
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [mode, target] = process.argv.slice(2);
const expected = {
  ref: process.env.MOODLE_REF,
  commit: process.env.MOODLE_COMMIT,
  proxy: process.env.ADDON_PROXY_URL,
};
if (!["built", "live"].includes(mode) || !target || !expected.commit || !expected.proxy) {
  console.error(
    "Usage: MOODLE_REF=… MOODLE_COMMIT=… ADDON_PROXY_URL=… node check-release.mjs built|live <site-dir|site-url>",
  );
  process.exit(2);
}

const problems = [];

function checkConfig(config) {
  if ("sentry" in config) problems.push("the config still has a sentry key");
  if ("phpCorsProxyUrl" in config) problems.push("the config still has phpCorsProxyUrl");
  if (config.addonProxyUrl !== expected.proxy)
    problems.push(`addonProxyUrl is ${JSON.stringify(config.addonProxyUrl)}, expected ${expected.proxy}`);
  if (config.strictSetupChecks !== true) problems.push("strictSetupChecks is not true");
}

if (mode === "built") {
  const manifest = JSON.parse(
    readFileSync(join(target, "assets/manifests/MOODLE_405_STABLE.json"), "utf8"),
  );
  // The site's Moodle release: the commit the bundle was built from.
  const commit = String(manifest.source?.url ?? "").split("/").pop();
  if (commit !== expected.commit)
    problems.push(
      `the Moodle bundle is ${manifest.release} at commit ${commit}, expected ${expected.ref} at ${expected.commit}`,
    );
  // The install snapshot and its localcache seed must be in the site, or every
  // preview runs a full Moodle install in the browser.
  for (const [label, entry] of [
    ["install snapshot", manifest.snapshot],
    ["localcache seed", manifest.snapshot?.localcache],
  ]) {
    if (!entry?.path) problems.push(`the 4.5 manifest has no ${label}`);
    else if (!existsSync(join(target, "assets/manifests", entry.path)))
      problems.push(`the ${label} is missing from the site (${entry.path})`);
  }
  // One bundle only: a leftover from an earlier build would be published too.
  const bundles = readdirSync(join(target, "assets/moodle/MOODLE_405_STABLE")).filter((name) =>
    name.startsWith("moodle-core-"),
  );
  const releases = new Set(bundles.map((name) => name.replace(/\.part-\d+$/, "")));
  if (releases.size !== 1)
    problems.push(`expected one Moodle bundle, found ${[...releases].join(", ") || "none"}`);
  checkConfig(JSON.parse(readFileSync(join(target, "playground.config.json"), "utf8")));
} else {
  // GitHub Pages caches files for up to 10 minutes; ask past the cache and retry.
  const attempts = Number(process.env.LIVE_CHECK_ATTEMPTS) || 20;
  const waitMs = Number(process.env.LIVE_CHECK_WAIT_MS) || 30_000;
  const url = new URL("playground.config.json", target.endsWith("/") ? target : `${target}/`);
  let config = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    url.searchParams.set("check", `${Date.now()}`);
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        config = await response.json();
        const before = problems.length;
        checkConfig(config);
        if (problems.length === before) break;
        problems.length = before;
      }
    } catch {
      // Not deployed yet, or a network hiccup: try again.
    }
    if (attempt < attempts - 1) await new Promise((done) => setTimeout(done, waitMs));
  }
  if (!config) problems.push(`could not read ${url.origin}${url.pathname}`);
  else checkConfig(config);
}

if (problems.length) {
  console.error(`Release check (${mode}) FAILED:`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`Release check (${mode}) passed.`);
