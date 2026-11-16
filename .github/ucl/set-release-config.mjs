// Writes UCL's values into the published site's playground.config.json.
// Usage: node .github/ucl/set-release-config.mjs <site-dir>
// Values come from the release workflow's environment:
//   ADDON_PROXY_URL  the plugin download proxy (must be set: a missing value falls back to exelearning)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const siteDir = process.argv[2];
const proxyUrl = process.env.ADDON_PROXY_URL;
if (!siteDir || !proxyUrl) {
  console.error("Usage: ADDON_PROXY_URL=<url> node set-release-config.mjs <site-dir>");
  process.exit(2);
}

const path = join(siteDir, "playground.config.json");
const config = JSON.parse(readFileSync(path, "utf8"));
// Sentry sends each preview's address to a third party; with no key it is off.
delete config.sentry;
// Our proxy serves plugin zips only, not PHP's own downloads.
delete config.phpCorsProxyUrl;
config.addonProxyUrl = proxyUrl;
// A reload that did not restore the setup shows the red bar.
config.strictSetupChecks = true;
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log(`UCL values written to ${path}`);
