"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { PresenceCoordinator } = require("../build/main/presence/coordinator");
const {
  encodeDiscordFrame,
  discordSocketPaths,
  DiscordIpcProvider,
} = require("../build/main/presence/discord-ipc");
const { normalizePresenceActivity } = require("../build/main/presence/types");

class FakeProvider {
  constructor() {
    this.activities = [];
    this.connection = "unavailable";
    this.closed = false;
  }
  async connect() {}
  async setActivity(activity) {
    this.activities.push(activity);
  }
  status() {
    return this.connection;
  }
  close() {
    this.closed = true;
  }
}

test("normalizes only bounded title-only playback activity", () => {
  assert.deepEqual(
    normalizePresenceActivity({
      title: "  Example film  ",
      mediaType: "video",
      playbackState: "playing",
      positionSeconds: 12.5,
      serverUrl: "https://not-retained.example",
    }),
    {
      title: "Example film",
      mediaType: "video",
      playbackState: "playing",
      positionSeconds: 12.5,
    },
  );
  assert.equal(normalizePresenceActivity({ title: "", mediaType: "video" }), null);
  assert.equal(
    normalizePresenceActivity({
      title: "x".repeat(257),
      mediaType: "video",
      playbackState: "playing",
      positionSeconds: 0,
    }),
    null,
  );
});

test("enables Discord Rich Presence unless the user explicitly opts out", () => {
  const { normalizeSettings } = require("../build/shared/settings");
  assert.equal(normalizeSettings().discordRichPresenceEnabled, true);
  assert.equal(
    normalizeSettings({ discordRichPresenceEnabled: false }).discordRichPresenceEnabled,
    false,
  );
});

test("coordinates opt-in publication, deduplication, and clear", async () => {
  const provider = new FakeProvider();
  const coordinator = new PresenceCoordinator(provider);
  const activity = {
    title: "Example",
    mediaType: "video",
    playbackState: "playing",
    positionSeconds: 4,
  };

  coordinator.update(activity);
  assert.deepEqual(provider.activities, []);
  assert.equal(coordinator.status().connection, "disabled");

  coordinator.setEnabled(true);
  coordinator.update(activity);
  coordinator.update(activity);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(provider.activities, [activity]);

  coordinator.clear();
  coordinator.setEnabled(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(provider.activities, [activity, null, null]);
  coordinator.close();
  assert.equal(provider.closed, true);
});

test("encodes Discord IPC frames and leaves an unconfigured app quiet", () => {
  const frame = encodeDiscordFrame(1, { cmd: "SET_ACTIVITY" });
  assert.equal(frame.readUInt32LE(0), 1);
  assert.deepEqual(JSON.parse(frame.subarray(8).toString("utf8")), {
    cmd: "SET_ACTIVITY",
  });
  const provider = new DiscordIpcProvider({
    applicationId: "",
    largeImageKey: "noktus",
  });
  assert.equal(provider.status(), "unconfigured");
  provider.close();
  assert.ok(discordSocketPaths().length >= 10);
});

test("publishes a title-only activity after the Discord IPC handshake", async (t) => {
  const pipePath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\noktus-discord-test-${process.pid}-${Date.now()}`
      : `${require("node:os").tmpdir()}/noktus-discord-test-${process.pid}-${Date.now()}.sock`;
  const frames = [];
  let resolveActivity;
  const activityReceived = new Promise((resolve) => {
    resolveActivity = resolve;
  });
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const opcode = buffer.readUInt32LE(0);
        const length = buffer.readUInt32LE(4);
        if (buffer.length < 8 + length) return;
        const payload = JSON.parse(buffer.subarray(8, 8 + length).toString("utf8"));
        buffer = buffer.subarray(8 + length);
        frames.push({ opcode, payload });
        if (opcode === 0) socket.write(encodeDiscordFrame(1, { evt: "READY" }));
        if (payload.cmd === "SET_ACTIVITY") resolveActivity(payload.args.activity);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  t.after(() => server.close());

  const provider = new DiscordIpcProvider({
    applicationId: "123",
    largeImageKey: "noktus",
    socketPaths: () => [pipePath],
  });
  t.after(() => provider.close());
  await provider.setActivity({
    title: "Example film",
    mediaType: "video",
    playbackState: "playing",
    positionSeconds: 42,
  });
  const published = await activityReceived;

  assert.deepEqual(frames[0].payload, { v: 1, client_id: "123" });
  assert.equal(published.details, "Example film");
  assert.equal(published.type, 3);
  assert.equal(published.assets.large_image, "noktus");
  assert.equal(published.state, "Watching");
  assert.ok(Number.isInteger(published.timestamps.start));
});
