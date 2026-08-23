"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const resourceDirectory = path.resolve("resources", "mpv");

test("bundles the MPV scripts required by the managed trickplay presentation", () => {
  for (const name of [
    "jellyfin_dc.lua",
    "thumbfast.lua",
    "trickplay-osc.lua",
    "README.md",
  ]) {
    assert.equal(fs.existsSync(path.join(resourceDirectory, name)), true, name);
  }
});

test("keeps the attributed patched stock OSC pinned to its reviewed source", () => {
  const contents = fs
    .readFileSync(path.join(resourceDirectory, "trickplay-osc.lua"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.equal(
    crypto.createHash("sha256").update(contents).digest("hex"),
    "7b08e8150c9a7963d7664e6b8090dfc4ef53e3c2b0ae9e136f4344c3db1a8557",
  );
});
