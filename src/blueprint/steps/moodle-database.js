/**
 * Database restore step: restoreDatabase.
 *
 * Replaces the runtime database with a playground SQLite database (.sq3) from a
 * URL, for example a demo site exported by mchef. The rest of the blueprint then
 * runs against the restored site.
 *
 * 1. Download. In the browser first (a native fetch, much faster than PHP over
 *    tcpOverFetch, as in restoreCourse), then in PHP if that fails. The file must
 *    start with the SQLite header before the live database is touched.
 * 2. Swap. Move the file over context.dbFile, copy the blueprint checkpoint row
 *    across (ADR-0035), and point wwwroot, dirroot and dataroot at this runtime.
 * 3. Purge caches, re-run the config normalizer, and compile the theme CSS.
 *
 * Every failure throws, before or after the swap. A failure after the swap
 * leaves the step unfinished in the checkpoint, so the site shows red and a
 * reload reports it instead of passing as a finished step.
 *
 * The .sq3 must come from the same SQLite driver patches as this runtime
 * (mchef's export uses them). A MySQL or PostgreSQL dump does not work.
 */

import { MOODLE_ROOT } from "../../runtime/config-template.js";
import { escapePhp, phpPurgeMoodleCaches } from "../php/helpers.js";

// Outside Moodle's tempdir (/tmp/moodle), so Moodle's temp cleanup cannot race it.
const RESTORE_TMP_PATH = "/tmp/playground-restore-db.sq3";

// Larger databases are downloaded in PHP, which writes to MEMFS without a
// second copy in JS memory.
const MAX_BROWSER_DATABASE_BYTES = 100 * 1024 * 1024;

const SQLITE_HEADER = "SQLite format 3\u0000";

export function registerMoodleDatabaseSteps(register) {
  register("restoreDatabase", handleRestoreDatabase);
}

async function handleRestoreDatabase(step, context) {
  const { php, publish, dbFile } = context;

  const url = typeof step.url === "string" ? step.url.trim() : "";
  if (!url) {
    throw new Error("restoreDatabase: 'url' is required.");
  }
  if (!/^https?:\/\//iu.test(url)) {
    throw new Error("restoreDatabase: 'url' must be an http(s) URL.");
  }
  if (!dbFile) {
    throw new Error("restoreDatabase: the runtime did not pass dbFile.");
  }

  publish?.("Downloading database snapshot...", 0.921);
  const bytes = await downloadDatabase(url, context);

  publish?.(`Restoring database (${bytes} bytes)...`, 0.922);
  let swap = null;
  try {
    swap = await runJsonPhp(php, buildSwapPhp(dbFile));
  } catch (error) {
    throw new Error(
      `restoreDatabase: the swap crashed, the database may already be replaced: ${error.message || error}`,
    );
  }
  if (!swap) {
    throw new Error(
      "restoreDatabase: the swap gave no result (a PHP fatal), the database may already be replaced.",
    );
  }
  if (!swap.ok) {
    const where = swap.swapped
      ? "the database was replaced, but"
      : "the database was not replaced:";
    throw new Error(
      `restoreDatabase: ${where} ${swap.error?.message || "unknown error"}`,
    );
  }

  await runAfterSwap(context);
  publish?.("Database restored.", 0.928);
}

/**
 * Downloads the database to RESTORE_TMP_PATH and returns its size in bytes.
 */
async function downloadDatabase(url, context) {
  const { php, publish } = context;
  try {
    return await downloadInBrowser(url, context);
  } catch (error) {
    if (error.final) {
      throw error;
    }
    publish?.(
      `Browser download unavailable (${String(error.message || error).slice(0, 120)}), downloading in PHP.`,
      0.921,
    );
  }

  let download = null;
  try {
    download = await runJsonPhp(php, buildDownloadPhp(url));
  } catch (error) {
    throw new Error(
      `restoreDatabase: the download crashed: ${error.message || error}`,
    );
  }
  if (!download?.ok) {
    throw new Error(
      `restoreDatabase: could not download '${url}': ${
        download?.error?.message || "the download gave no result"
      }`,
    );
  }
  return download.bytes;
}

async function downloadInBrowser(url, context) {
  const fetchImpl = context.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("no fetch");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let buffer;
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status ?? "error"}`);
    }
    const length = Number(response.headers?.get?.("content-length")) || 0;
    if (length > MAX_BROWSER_DATABASE_BYTES) {
      throw new Error(`${length} bytes is over the browser budget`);
    }
    buffer = await response.arrayBuffer();
  } finally {
    clearTimeout(timeout);
  }
  if (buffer.byteLength > MAX_BROWSER_DATABASE_BYTES) {
    throw new Error(`${buffer.byteLength} bytes is over the browser budget`);
  }
  const bytes = new Uint8Array(buffer);
  const problem = sqliteFileProblem(bytes);
  if (problem) {
    // Not a reason to try PHP: it would download the same file.
    throw Object.assign(new Error(`restoreDatabase: ${problem}`), {
      final: true,
    });
  }
  await context.php.writeFile(RESTORE_TMP_PATH, bytes);
  return bytes.length;
}

/**
 * Returns why the bytes are not a SQLite database, or null when they are.
 */
function sqliteFileProblem(bytes) {
  if (bytes.length < 512) {
    return `the downloaded file is too small to be a SQLite database (${bytes.length} bytes).`;
  }
  const header = String.fromCharCode(...bytes.subarray(0, 16));
  if (header !== SQLITE_HEADER) {
    return "the downloaded file is not a SQLite database (no SQLite header).";
  }
  return null;
}

/**
 * Purges caches built against the old database, re-runs the config normalizer
 * (defaults, cache stores, allversionshash) and recompiles the theme CSS. The
 * hooks come from bootstrap.js.
 */
async function runAfterSwap(context) {
  const { php, publish, runConfigNormalizer, runThemeCssWarmup } = context;

  if (typeof runConfigNormalizer !== "function") {
    // The purge blanks allversionshash, and only the normalizer sets it again.
    // Purging without it would leave the site on the upgrade screen.
    throw new Error(
      "restoreDatabase: the database was replaced, but the runtime passed no config normalizer.",
    );
  }

  const purged = await runJsonPhp(php, phpPurgeMoodleCaches());
  if (!purged?.ok) {
    throw new Error(
      `restoreDatabase: the database was replaced, but the cache purge failed: ${
        purged?.error?.message || purged?.error || "no result"
      }`,
    );
  }

  const normalized = await runConfigNormalizer();
  if (!normalized?.ok) {
    throw new Error(
      `restoreDatabase: the database was replaced, but the config normalizer failed: ${
        normalized?.error?.message || "no result"
      }`,
    );
  }

  if (typeof runThemeCssWarmup === "function") {
    publish?.("Compiling theme CSS for the restored database...", 0.927);
    try {
      const warmed = await runThemeCssWarmup();
      if (!warmed?.ok) {
        publish?.(
          `restoreDatabase: theme CSS warmup failed (${warmed?.error?.message || "no result"}), the first pages may be slow or unstyled.`,
          0.927,
        );
      }
    } catch (error) {
      // Styling only: Moodle compiles the CSS on first use instead.
      publish?.(
        `restoreDatabase: theme CSS warmup crashed (${error.message || error}), the first pages may be slow or unstyled.`,
        0.927,
      );
    }
  }
}

// Runs a generated script and parses the JSON object it echoes. The scripts
// buffer their output, so the first "{" starts the JSON. Returns null when there
// is none (a PHP fatal before the echo).
async function runJsonPhp(php, code) {
  const result = await php.run(code);
  const text = result?.text || "";
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

// The PHP fallback: download_file_content() writes straight to a MEMFS file.
function buildDownloadPhp(url) {
  return `<?php
define('CLI_SCRIPT', true);
ob_start();
$result = ['ok' => false];
try {
    require_once('${MOODLE_ROOT}/config.php');
    // setup.php only loads filelib behind a proxy setting.
    require_once($CFG->libdir . '/filelib.php');

    $tmp = '${RESTORE_TMP_PATH}';
    @unlink($tmp);
    $ok = download_file_content('${escapePhp(url)}', null, null, false, 600, 30, false, $tmp);
    if ($ok === false || !is_file($tmp)) {
        throw new Exception('Could not download the database snapshot.');
    }
    $size = filesize($tmp);
    if ($size < 512) {
        @unlink($tmp);
        throw new Exception('The downloaded file is too small to be a SQLite database (' . $size . ' bytes).');
    }
    $fh = fopen($tmp, 'rb');
    $header = $fh ? fread($fh, 16) : '';
    if ($fh) {
        fclose($fh);
    }
    if ($header !== "SQLite format 3\\x00") {
        @unlink($tmp);
        throw new Exception('The downloaded file is not a SQLite database (no SQLite header).');
    }
    $result['ok'] = true;
    $result['bytes'] = $size;
} catch (Throwable $error) {
    $result['error'] = ['type' => get_class($error), 'message' => $error->getMessage()];
}
$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}
echo json_encode($result, JSON_UNESCAPED_SLASHES);
`;
}

// Moves the downloaded file over the live database, then fixes the values that
// belong to the source site. The rename happens before config.php loads, so
// set_config() writes to the restored database. PLAYGROUND_SKIP_INITIALISE_CFG
// stops the source site's mdl_config from overriding config.php first.
function buildSwapPhp(dbFile) {
  return `<?php
define('CLI_SCRIPT', true);
if (!defined('PLAYGROUND_SKIP_INITIALISE_CFG')) {
    define('PLAYGROUND_SKIP_INITIALISE_CFG', true);
}
if (!defined('CACHE_DISABLE_ALL')) {
    define('CACHE_DISABLE_ALL', true);
}
ob_start();
$result = ['ok' => false, 'swapped' => false];
try {
    $tmp = '${RESTORE_TMP_PATH}';
    $db = '${escapePhp(dbFile)}';
    if (!is_file($tmp)) {
        throw new Exception('The downloaded database is missing: ' . $tmp);
    }

    // The blueprint checkpoint lives in mdl_config (ADR-0035). Carry it across,
    // or a reload before the next checkpoint save finds none and skips every
    // step, plugins included.
    $checkpoint = false;
    if (is_file($db)) {
        $old = new PDO('sqlite:' . $db);
        $old->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $checkpoint = $old->query("SELECT value FROM mdl_config WHERE name = 'playground_blueprint_checkpoint'")->fetchColumn();
        $old = null;
    }

    if (!@rename($tmp, $db)) {
        throw new Exception('Could not move the database into place at ' . $db);
    }
    $result['swapped'] = true;

    $pdo = new PDO('sqlite:' . $db);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    // Saving the checkpoint needs the unique index on mdl_config.name. Some
    // exports lack it, and then every checkpoint save stops the boot.
    $unique = false;
    foreach ($pdo->query('PRAGMA index_list(mdl_config)')->fetchAll() as $index) {
        if ($index['unique']) {
            $columns = $pdo->query('PRAGMA index_info("' . $index['name'] . '")')->fetchAll(PDO::FETCH_COLUMN, 2);
            $unique = $unique || $columns === ['name'];
        }
    }
    if (!$unique) {
        $pdo->exec('CREATE UNIQUE INDEX mdl_conf_nam_uix ON mdl_config (name)');
    }
    // A checkpoint row inside the snapshot belongs to another blueprint.
    $pdo->exec("DELETE FROM mdl_config WHERE name = 'playground_blueprint_checkpoint'");
    if ($checkpoint !== false) {
        $insert = $pdo->prepare("INSERT INTO mdl_config (name, value) VALUES ('playground_blueprint_checkpoint', ?)");
        $insert->execute([$checkpoint]);
    }
    $pdo = null;

    require_once('${MOODLE_ROOT}/config.php');
    require_once($CFG->libdir . '/moodlelib.php');
    set_config('wwwroot', $CFG->wwwroot);
    set_config('dirroot', $CFG->dirroot);
    set_config('dataroot', $CFG->dataroot);
    // The current code's hash, as the boot normalizer sets it. An empty hash
    // would send the site to the upgrade screen.
    set_config('allversionshash', core_component::get_all_versions_hash());
    // Left set, it causes redirect loops.
    if (!empty($CFG->adminsetuppending)) {
        unset_config('adminsetuppending');
    }

    $result['ok'] = true;
} catch (Throwable $error) {
    $result['error'] = [
        'type' => get_class($error),
        'message' => $error->getMessage(),
        'file' => $error->getFile(),
        'line' => $error->getLine(),
    ];
}
$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}
echo json_encode($result, JSON_UNESCAPED_SLASHES);
`;
}

export const __testables = {
  buildDownloadPhp,
  buildSwapPhp,
  sqliteFileProblem,
  RESTORE_TMP_PATH,
  MAX_BROWSER_DATABASE_BYTES,
};
