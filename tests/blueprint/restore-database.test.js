import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStepHandler } from "../../src/blueprint/steps/index.js";
import { __testables } from "../../src/blueprint/steps/moodle-database.js";

const { RESTORE_TMP_PATH, MAX_BROWSER_DATABASE_BYTES } = __testables;
const URL = "https://raw.githubusercontent.com/owner/repo/0123abc/demo.sq3";
const DB_FILE = "/persist/moodledata/moodle_s1_php83.sq3.php";

function sqliteBytes(size = 4096) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("SQLite format 3\u0000"));
  return bytes;
}

function fetchReturning(bytes, { ok = true, status = 200, length } = {}) {
  return async () => ({
    ok,
    status,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-length"
          ? String(length ?? bytes.length)
          : null,
    },
    async arrayBuffer() {
      return bytes.buffer;
    },
  });
}

const failingFetch = async () => {
  throw new Error("network down");
};

/**
 * A php mock that answers each script by what it contains. `answers` overrides
 * the JSON a script kind returns: download, swap, purge.
 */
function createContext(answers = {}, extra = {}) {
  const runs = [];
  const writes = [];
  const published = [];
  const hooks = { normalizer: 0, warmup: 0 };
  const reply = (kind, fallback) =>
    kind in answers ? answers[kind] : JSON.stringify(fallback);
  const context = {
    dbFile: DB_FILE,
    publish: (detail) => published.push(detail),
    runConfigNormalizer: async () => {
      hooks.normalizer++;
      return answers.normalizer ?? { ok: true };
    },
    runThemeCssWarmup: async () => {
      hooks.warmup++;
      return answers.warmup ?? { ok: true };
    },
    php: {
      async run(code) {
        runs.push(code);
        if (code.includes("download_file_content(")) {
          return { text: reply("download", { ok: true, bytes: 8192 }) };
        }
        if (code.includes("rename($tmp, $db)")) {
          return { text: reply("swap", { ok: true, swapped: true }) };
        }
        return { text: reply("purge", { ok: true }) };
      },
      async writeFile(path, data) {
        writes.push([path, data]);
      },
    },
    ...extra,
  };
  return { context, runs, writes, published, hooks };
}

describe("restoreDatabase: handler", () => {
  const handler = getStepHandler("restoreDatabase");

  it("is registered", () => {
    assert.strictEqual(typeof handler, "function");
  });

  it("refuses a missing or non-http url before running PHP", async () => {
    const { context, runs } = createContext();
    await assert.rejects(() => handler({}, context), /'url' is required/u);
    await assert.rejects(
      () => handler({ url: "file:///etc/passwd" }, context),
      /must be an http\(s\) URL/u,
    );
    assert.strictEqual(runs.length, 0);
  });

  it("refuses to run without the runtime's dbFile", async () => {
    const { context, runs } = createContext({}, { dbFile: undefined });
    await assert.rejects(
      () =>
        handler(
          { url: URL },
          { ...context, fetch: fetchReturning(sqliteBytes()) },
        ),
      /did not pass dbFile/u,
    );
    assert.strictEqual(runs.length, 0);
  });

  it("downloads in the browser, then swaps over context.dbFile", async () => {
    const bytes = sqliteBytes();
    const { context, runs, writes, hooks, published } = createContext();
    await handler({ url: URL }, { ...context, fetch: fetchReturning(bytes) });
    assert.deepStrictEqual(writes, [[RESTORE_TMP_PATH, bytes]]);
    assert.ok(!runs.some((code) => code.includes("download_file_content(")));
    const swap = runs.find((code) => code.includes("rename($tmp, $db)"));
    assert.ok(swap.includes(`$db = '${DB_FILE}';`));
    assert.strictEqual(hooks.normalizer, 1);
    assert.strictEqual(hooks.warmup, 1);
    assert.ok(published.includes("Database restored."));
  });

  it("downloads in PHP when the browser fetch fails", async () => {
    const { context, runs, writes } = createContext();
    await handler({ url: URL }, { ...context, fetch: failingFetch });
    assert.strictEqual(writes.length, 0);
    assert.ok(runs[0].includes("download_file_content("));
    assert.ok(runs[0].includes(URL));
  });

  it("downloads in PHP when the browser fetch gets an HTTP error", async () => {
    const { context, runs } = createContext();
    await handler(
      { url: URL },
      {
        ...context,
        fetch: fetchReturning(sqliteBytes(), { ok: false, status: 404 }),
      },
    );
    assert.ok(runs[0].includes("download_file_content("));
  });

  it("downloads in PHP when the database is over the browser budget", async () => {
    const { context, runs, writes } = createContext();
    await handler(
      { url: URL },
      {
        ...context,
        fetch: fetchReturning(sqliteBytes(), {
          length: MAX_BROWSER_DATABASE_BYTES + 1,
        }),
      },
    );
    assert.strictEqual(writes.length, 0);
    assert.ok(runs[0].includes("download_file_content("));
  });

  it("refuses a browser download that is not SQLite, without trying PHP", async () => {
    const html = new TextEncoder().encode(`<html>${"x".repeat(2000)}</html>`);
    const { context, runs, writes } = createContext();
    await assert.rejects(
      () => handler({ url: URL }, { ...context, fetch: fetchReturning(html) }),
      /not a SQLite database/u,
    );
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(runs.length, 0);
  });

  it("refuses a browser download that is too small", async () => {
    const { context, runs } = createContext();
    await assert.rejects(
      () =>
        handler(
          { url: URL },
          { ...context, fetch: fetchReturning(sqliteBytes(100)) },
        ),
      /too small/u,
    );
    assert.strictEqual(runs.length, 0);
  });

  it("throws when the PHP download fails, before any swap", async () => {
    const { context, runs } = createContext({
      download: JSON.stringify({ ok: false, error: { message: "HTTP 404" } }),
    });
    await assert.rejects(
      () => handler({ url: URL }, { ...context, fetch: failingFetch }),
      /could not download .*HTTP 404/u,
    );
    assert.ok(!runs.some((code) => code.includes("rename($tmp, $db)")));
  });

  it("throws when the swap failed before replacing the database", async () => {
    const { context, hooks } = createContext({
      swap: JSON.stringify({
        ok: false,
        swapped: false,
        error: { message: "missing" },
      }),
    });
    await assert.rejects(
      () =>
        handler(
          { url: URL },
          { ...context, fetch: fetchReturning(sqliteBytes()) },
        ),
      /was not replaced: missing/u,
    );
    assert.strictEqual(hooks.normalizer, 0);
  });

  // A failure after the swap must not pass as a finished step.
  it("throws when the swap failed after replacing the database", async () => {
    const { context } = createContext({
      swap: JSON.stringify({
        ok: false,
        swapped: true,
        error: { message: "set_config" },
      }),
    });
    await assert.rejects(
      () =>
        handler(
          { url: URL },
          { ...context, fetch: fetchReturning(sqliteBytes()) },
        ),
      /was replaced, but set_config/u,
    );
  });

  it("throws when the swap gives no result", async () => {
    const { context } = createContext({ swap: "Fatal error: out of memory" });
    await assert.rejects(
      () =>
        handler(
          { url: URL },
          { ...context, fetch: fetchReturning(sqliteBytes()) },
        ),
      /gave no result/u,
    );
  });

  it("throws when the swap crashes", async () => {
    const { context } = createContext();
    const run = context.php.run;
    context.php.run = async (code) => {
      if (code.includes("rename($tmp, $db)")) throw new Error("wasm trap");
      return run(code);
    };
    await assert.rejects(
      () =>
        handler(
          { url: URL },
          { ...context, fetch: fetchReturning(sqliteBytes()) },
        ),
      /swap crashed.*wasm trap/u,
    );
  });

  it("throws when the cache purge fails after the swap", async () => {
    const { context, hooks } = createContext({
      purge: JSON.stringify({ ok: false, error: "purge broke" }),
    });
    await assert.rejects(
      () =>
        handler(
          { url: URL },
          { ...context, fetch: fetchReturning(sqliteBytes()) },
        ),
      /cache purge failed: purge broke/u,
    );
    assert.strictEqual(hooks.normalizer, 0);
  });

  it("throws when the config normalizer fails after the swap", async () => {
    const { context } = createContext({
      normalizer: { ok: false, error: { message: "no config" } },
    });
    await assert.rejects(
      () =>
        handler(
          { url: URL },
          { ...context, fetch: fetchReturning(sqliteBytes()) },
        ),
      /config normalizer failed: no config/u,
    );
  });

  it("throws when the runtime passed no config normalizer", async () => {
    const { context, runs } = createContext(
      {},
      { runConfigNormalizer: undefined },
    );
    await assert.rejects(
      () =>
        handler(
          { url: URL },
          { ...context, fetch: fetchReturning(sqliteBytes()) },
        ),
      /no config normalizer/u,
    );
    // The purge would blank allversionshash with nothing to set it again.
    assert.strictEqual(runs.length, 1);
  });

  it("only reports a failed theme warmup", async () => {
    const { context, published } = createContext({
      warmup: { ok: false, error: { message: "scss" } },
    });
    await handler(
      { url: URL },
      { ...context, fetch: fetchReturning(sqliteBytes()) },
    );
    assert.ok(
      published.some((line) => /theme CSS warmup failed \(scss\)/u.test(line)),
    );
    assert.ok(published.includes("Database restored."));
  });
});

describe("restoreDatabase: generated PHP", () => {
  const { buildDownloadPhp, buildSwapPhp } = __testables;

  it("escapes the url and the database path", () => {
    assert.ok(buildDownloadPhp("https://x.test/a'b.sq3").includes("a\\'b.sq3"));
    assert.ok(
      buildSwapPhp("/persist/o'k.sq3.php").includes(
        "$db = '/persist/o\\'k.sq3.php';",
      ),
    );
  });

  it("reads the checkpoint before the rename and writes it after", () => {
    const code = buildSwapPhp(DB_FILE);
    const read = code.indexOf(
      "SELECT value FROM mdl_config WHERE name = 'playground_blueprint_checkpoint'",
    );
    const rename = code.indexOf("rename($tmp, $db)");
    const remove = code.indexOf(
      "DELETE FROM mdl_config WHERE name = 'playground_blueprint_checkpoint'",
    );
    const insert = code.indexOf(
      "INSERT INTO mdl_config (name, value) VALUES ('playground_blueprint_checkpoint', ?)",
    );
    assert.ok(read > 0 && read < rename && rename < remove && remove < insert);
  });

  it("swaps before config.php loads", () => {
    const code = buildSwapPhp(DB_FILE);
    assert.ok(code.indexOf("rename($tmp, $db)") < code.indexOf("config.php"));
    assert.ok(
      code.indexOf("PLAYGROUND_SKIP_INITIALISE_CFG") <
        code.indexOf("config.php"),
    );
  });
});
