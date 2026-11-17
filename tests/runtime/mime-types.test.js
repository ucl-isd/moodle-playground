// Tests the real MIME table in php-compat.js, which serves every static file.
// (php-compat.test.js checks a copy of getMimeType, not this one.)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __testing } from "../../src/runtime/php-compat.js";

const { getMimeType } = __testing;

describe("getMimeType (real table)", () => {
  it("serves .mjs as JavaScript, so the browser runs PDF.js modules", () => {
    assert.strictEqual(
      getMimeType("/mod/coursework/pdfjs/build/pdf.mjs"),
      "application/javascript; charset=utf-8",
    );
    assert.strictEqual(
      getMimeType("/lib/pdfjs/PDF.WORKER.MJS"),
      "application/javascript; charset=utf-8",
    );
  });

  it("serves .wasm as application/wasm", () => {
    assert.strictEqual(
      getMimeType("/lib/pdfjs/openjpeg.wasm"),
      "application/wasm",
    );
  });

  it("keeps .js and unknown files as before", () => {
    assert.strictEqual(
      getMimeType("/lib/app.js"),
      "application/javascript; charset=utf-8",
    );
    assert.strictEqual(
      getMimeType("/lib/file.xyz"),
      "application/octet-stream",
    );
  });
});
