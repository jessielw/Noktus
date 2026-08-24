"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTrickplayStatus,
  trickplayLogLine,
} = require("../build/main/playback/trickplay-status");

test("accepts every reportable trickplay state and tidies the detail", () => {
  for (const state of ["off", "unsupported", "no-manifest", "error", "ready"]) {
    assert.deepEqual(normalizeTrickplayStatus({ state }), { state, detail: "" });
  }
  assert.deepEqual(
    normalizeTrickplayStatus({
      state: "ready",
      detail: "  12 previews\n at 320x180.  ",
    }),
    { state: "ready", detail: "12 previews at 320x180." },
  );
  assert.equal(
    normalizeTrickplayStatus({ state: "error", detail: "x".repeat(500) }).detail.length,
    300,
  );
});

test("rejects trickplay reports that the injected page script could not have produced", () => {
  assert.throws(() => normalizeTrickplayStatus(null), /must be an object/);
  assert.throws(() => normalizeTrickplayStatus([]), /must be an object/);
  assert.throws(() => normalizeTrickplayStatus({ state: "broken" }), /must be one of/);
  assert.throws(
    () => normalizeTrickplayStatus({ state: "ready", detail: 12 }),
    /must be a string/,
  );
});

test("writes a log line that names the state and the reason", () => {
  assert.equal(
    trickplayLogLine({ state: "no-manifest", detail: "This server has no trickplay." }),
    "Trickplay no-manifest: This server has no trickplay.",
  );
  assert.equal(trickplayLogLine({ state: "off", detail: "" }), "Trickplay off");
});
