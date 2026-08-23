"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  TrickplayStore,
  cleanupStaleTrickplayFiles,
  normalizeTrickplayMetadata,
} = require("../build/main/playback/trickplay-store");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "noktus-trickplay-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const metadata = {
  count: 2,
  intervalMs: 10_000,
  width: 2,
  height: 1,
  first: 3,
  total: 10,
};

test("normalizes bounded trickplay windows", () => {
  assert.deepEqual(normalizeTrickplayMetadata(metadata), metadata);
  assert.throws(
    () =>
      normalizeTrickplayMetadata({
        ...metadata,
        width: 1920,
        height: 1080,
        count: 4,
      }),
    /budget/,
  );
  assert.throws(() => normalizeTrickplayMetadata({ ...metadata, first: 9 }), /beyond/);
});

test("publishes only complete BGRA generations", async (t) => {
  const directory = temporaryDirectory(t);
  const messages = [];
  const store = new TrickplayStore(
    async (message) => messages.push(message),
    directory,
  );
  const id = await store.begin(metadata);
  await store.append(id, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
  await store.append(id, Uint8Array.from([9, 10, 11, 12, 13, 14, 15, 16]));
  await store.commit(id);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].slice(0, 6), [
    "script-message",
    "shim-trickplay-bif",
    "2",
    "10000",
    "2",
    "1",
  ]);
  assert.deepEqual(messages[0].slice(7), ["3", "10"]);
  assert.deepEqual(
    [...fs.readFileSync(messages[0][6])],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  );

  await store.clear();
  assert.deepEqual(messages.at(-1), ["script-message", "shim-trickplay-clear"]);
  assert.equal(fs.existsSync(messages[0][6]), true);
  await store.clear(false);
  assert.equal(fs.existsSync(messages[0][6]), false);
});

test("rejects and removes an incomplete generation", async (t) => {
  const directory = temporaryDirectory(t);
  const messages = [];
  const store = new TrickplayStore(
    async (message) => messages.push(message),
    directory,
  );
  const id = await store.begin(metadata);
  await store.append(id, Uint8Array.from([1, 2, 3, 4]));

  await assert.rejects(() => store.commit(id), /incomplete/);
  assert.deepEqual(messages, []);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("keeps one retired generation until a later publish", async (t) => {
  const directory = temporaryDirectory(t);
  const paths = [];
  const store = new TrickplayStore(
    async (message) => paths.push(message[6]),
    directory,
  );

  for (let generation = 0; generation < 3; generation += 1) {
    const id = await store.begin({ ...metadata, count: 1, first: generation });
    await store.append(id, new Uint8Array(8));
    await store.commit(id);
    if (generation === 1) assert.equal(fs.existsSync(paths[0]), true);
  }

  assert.equal(fs.existsSync(paths[0]), false);
  assert.equal(fs.existsSync(paths[1]), true);
  assert.equal(fs.existsSync(paths[2]), true);
  await store.clear(false);
  assert.equal(fs.existsSync(paths[1]), false);
  assert.equal(fs.existsSync(paths[2]), false);
});

test("removes only stale Noktus trickplay files", async (t) => {
  const directory = temporaryDirectory(t);
  const stale = path.join(directory, "noktus-trickplay-old.bgra");
  const recent = path.join(directory, "noktus-trickplay-recent.bgra");
  const unrelated = path.join(directory, "other.bgra");
  fs.writeFileSync(stale, "old");
  fs.writeFileSync(recent, "recent");
  fs.writeFileSync(unrelated, "other");
  fs.utimesSync(stale, new Date(0), new Date(0));

  await cleanupStaleTrickplayFiles(directory, Date.now());

  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(unrelated), true);
});
