"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const resourceDirectory = path.resolve("resources", "mpv");

test("bundles the MPV scripts required by the managed trickplay presentation", () => {
  for (const name of ["jellyfin_dc.lua", "thumbfast.lua", "osc.lua", "README.md"]) {
    assert.equal(fs.existsSync(path.join(resourceDirectory, name)), true, name);
  }
});

test("keeps the attributed patched stock OSC pinned to its reviewed source", () => {
  const contents = fs
    .readFileSync(path.join(resourceDirectory, "osc.lua"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.equal(
    crypto.createHash("sha256").update(contents).digest("hex"),
    "76cf0f7fe89e2279b4ba0899d217eb6070a4fc25e0a20d887c772f0b1ddbb24c",
  );
});
