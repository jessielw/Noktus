"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  MpvController,
  buildMpvArguments,
  normalizeLoadRequest,
  normalizeMpvPresentation,
} = require("../build/main/playback/mpv-controller");

test("normalizes a constrained MPV load request", () => {
  const request = normalizeLoadRequest(
    {
      url: "https://media.example/jellyfin/Videos/1/stream?api_key=secret",
      startSeconds: 12.5,
      title: "Example",
      fullscreen: false,
      audioTrack: 2,
      subtitleStreamIndex: 4,
      subtitleTracks: [
        {
          jellyfinIndex: 4,
          mpvTrack: 0,
          externalUrl: "https://media.example/jellyfin/Videos/1/Subtitles/4/Stream.srt",
          title: "English (SRT)",
          language: "eng",
        },
      ],
    },
    "https://media.example/jellyfin",
  );

  assert.equal(request.startSeconds, 12.5);
  assert.equal(request.audioTrack, 2);
  assert.equal(request.fullscreen, false);
  assert.equal(request.subtitleStreamIndex, 4);
  assert.equal(request.subtitleTracks[0].language, "eng");
});

test("rejects unsafe MPV input", () => {
  assert.throws(
    () => normalizeLoadRequest({ url: "file:///etc/passwd" }, "https://media.example"),
    /outside/,
  );
  assert.throws(
    () =>
      normalizeLoadRequest(
        {
          url: "https://media.example/Videos/1/stream",
          startSeconds: -1,
        },
        "https://media.example",
      ),
    /startSeconds/,
  );
});

test("forwards observed MPV fullscreen state", () => {
  const events = [];
  const controller = new MpvController({
    serverUrl: "https://media.example",
    eventSink: (name, payload) => events.push({ name, payload }),
  });
  controller.onMessage({
    event: "property-change",
    name: "fullscreen",
    data: true,
  });

  assert.deepEqual(events, [{ name: "fullscreen", payload: { value: true } }]);
});

test("distinguishes natural completion and user quit", () => {
  const events = [];
  const controller = new MpvController({
    serverUrl: "https://media.example",
    eventSink: (name, payload) => events.push({ name, payload }),
  });

  controller.current = true;
  controller.onMessage({ event: "end-file", reason: "eof" });
  controller.current = true;
  controller.onMessage({ event: "end-file", reason: "quit" });

  assert.deepEqual(events, [
    { name: "ended", payload: {} },
    { name: "quit", payload: {} },
  ]);
});

test("reports an unexpected MPV process exit as a failure", () => {
  const events = [];
  const controller = new MpvController({
    serverUrl: "https://media.example",
    eventSink: (name, payload) => events.push({ name, payload }),
  });
  const child = {};
  controller.child = child;
  controller.current = true;

  controller.onProcessExit(child, 7, null);

  assert.deepEqual(events, [
    { name: "ready", payload: { ready: false } },
    {
      name: "failed",
      payload: { code: "process", message: "MPV exited unexpectedly (7)" },
    },
  ]);
});

test("forwards Jellyfin controls and native track changes from MPV", () => {
  const events = [];
  const controller = new MpvController({
    serverUrl: "https://media.example",
    eventSink: (name, payload) => events.push({ name, payload }),
  });
  controller.pendingNavigation = { previous: false, next: true };

  controller.onMessage({
    event: "client-message",
    args: ["jellyfin-dc-control", "next"],
  });
  controller.onMessage({ event: "property-change", name: "aid", data: 2 });
  controller.onMessage({ event: "property-change", name: "sid", data: false });

  assert.deepEqual(events, [
    { name: "next", payload: {} },
    { name: "audioTrack", payload: { value: 2 } },
    {
      name: "subtitleTrack",
      payload: { value: false, jellyfinIndex: -1 },
    },
  ]);
});

test("forwards bounded trickplay window requests from the Lua provider", () => {
  const events = [];
  const controller = new MpvController({
    serverUrl: "https://media.example",
    eventSink: (name, payload) => events.push({ name, payload }),
  });

  controller.onMessage({
    event: "client-message",
    args: ["shim-trickplay-need", "123.5"],
  });
  controller.onMessage({
    event: "client-message",
    args: ["shim-trickplay-need", "not-a-number"],
  });

  assert.deepEqual(events, [{ name: "trickplayNeed", payload: { seconds: 123.5 } }]);
});

test("adds the Jellyfin OSC preset without discarding other MPV script options", () => {
  const args = buildMpvArguments("test-ipc", "jellyfin", "jellyfin_dc.lua");

  assert.ok(args.includes("--force-window=immediate"));
  assert.ok(!args.includes("--force-window=no"));
  assert.ok(args.includes("--osc=no"));
  assert.ok(args.includes("--osd-on-seek=msg-bar"));
  assert.ok(
    args.some((argument) => argument.startsWith("--script-opts-append=osc-layout=")),
  );
  assert.ok(args.includes("--script-opts-append=osc-timetotal=yes"));
  assert.ok(
    !args.some((argument) => argument.includes("osc-custom_button")),
    "skip controls should only be rendered for an active media segment",
  );
  assert.equal(
    args.filter((argument) => argument.startsWith("--script-opts-append=")).length,
    7,
  );
  // `osc-fadein` postdates the OSC revision this fork is based on; passing it only
  // produced a "script-opts: unknown key fadein" warning on every launch.
  assert.ok(!args.some((argument) => argument.includes("osc-fadein")));
  assert.ok(!args.some((argument) => argument.startsWith("--script-opts=")));
  assert.ok(args.includes(`--script=${path.join(".", "thumbfast.lua")}`));
  assert.ok(args.includes(`--script=${path.join(".", "osc.lua")}`));
  assert.ok(args.includes("--script=jellyfin_dc.lua"));
});

test("leaves mpv.net in charge of its own OSC and loads scripts as one list", () => {
  const args = buildMpvArguments("test-ipc", "jellyfin", "jellyfin_dc.lua", "mpv.net");

  assert.ok(args.includes("--process-instance=multi"));
  assert.ok(!args.includes("--force-window=immediate"));
  assert.ok(!args.includes("--no-terminal"));
  assert.ok(args.includes("--input-ipc-server=test-ipc"));
  // mpv.net cannot load our patched OSC, so replacing its own would leave no
  // seekbar at all (jessielw/Noktus#8). Its OSC preference is left entirely alone.
  assert.ok(!args.some((argument) => argument.startsWith("--osc=")));
  assert.ok(!args.some((argument) => argument.includes("thumbfast.lua")));
  assert.ok(!args.some((argument) => argument.includes("osc.lua")));
  assert.ok(!args.some((argument) => argument.startsWith("--script-opts-append=osc-")));
  // mpv.net replaces `scripts` on every `--script=`, so only the last one would load.
  assert.ok(!args.some((argument) => argument.startsWith("--script=")));
  assert.ok(args.includes("--scripts=jellyfin_dc.lua"));
  assert.equal(
    new MpvController({
      serverUrl: "https://media.example",
      executable: "C:\\tools\\mpvnet.exe",
    }).status().provider,
    "mpv.net",
  );
});

test("applies one named video profile before Noktus mandatory arguments", () => {
  const args = buildMpvArguments(
    "test-ipc",
    "jellyfin",
    "jellyfin_dc.lua",
    "mpv",
    "high-quality",
  );
  const profileIndex = args.indexOf("--profile=high-quality");
  assert.ok(profileIndex >= 0);
  assert.ok(profileIndex < args.indexOf("--input-ipc-server=test-ipc"));
  assert.ok(profileIndex < args.indexOf("--osc=no"));
  assert.throws(
    () => buildMpvArguments("test-ipc", "jellyfin", null, "mpv", "one,two"),
    /unsupported/,
  );
});

test("falls back to the pre-0.38 loadfile arguments and remembers the capability", async () => {
  const controller = new MpvController({
    serverUrl: "https://media.example",
    executable: "C:\\tools\\mpvnet.exe",
  });
  const commands = [];
  controller.ensureStarted = async () => {};
  controller.command = async (command) => {
    commands.push(command);
    if (command[0] === "loadfile" && command[3] === -1) {
      throw new Error("MPV loadfile command failed: invalid parameter");
    }
  };
  const request = {
    url: "https://media.example/Videos/1/stream",
    startSeconds: 12.5,
    title: "Example",
    fullscreen: false,
    audioTrack: 0,
    externalAudioUrl: null,
    subtitleStreamIndex: -1,
    subtitleTracks: [],
  };

  await controller.loadRequest(request);
  assert.deepEqual(
    commands.filter((command) => command[0] === "loadfile"),
    [
      [
        "loadfile",
        "https://media.example/Videos/1/stream",
        "replace",
        -1,
        "start=12.500",
      ],
      ["loadfile", "https://media.example/Videos/1/stream", "replace", "start=12.500"],
    ],
  );

  commands.length = 0;
  await controller.loadRequest({ ...request, startSeconds: 20 });
  assert.deepEqual(
    commands.filter((command) => command[0] === "loadfile"),
    [["loadfile", "https://media.example/Videos/1/stream", "replace", "start=20.000"]],
  );
});

test("does not remember legacy loadfile arguments when the retry also fails", async () => {
  const controller = new MpvController({
    serverUrl: "https://media.example",
  });
  controller.ensureStarted = async () => {};
  controller.command = async (command) => {
    if (command[0] === "loadfile") {
      throw new Error("MPV loadfile command failed: invalid parameter");
    }
  };

  await assert.rejects(
    controller.loadRequest({
      url: "https://media.example/Videos/1/stream",
      startSeconds: 0,
      title: "Example",
      fullscreen: false,
      audioTrack: 0,
      externalAudioUrl: null,
      subtitleStreamIndex: -1,
      subtitleTracks: [],
    }),
    /invalid parameter/,
  );
  assert.equal(controller.legacyLoadfileArguments, false);
});

test("cleans up a lost MPV IPC connection before another load", () => {
  const controller = new MpvController({ serverUrl: "https://media.example" });
  const child = { exitCode: null, kill: () => {} };
  const socket = { destroy: () => {}, destroyed: false };
  controller.child = child;
  controller.socket = socket;

  controller.onSocketFailure(socket, new Error("MPV IPC failed: write EPIPE"));

  assert.equal(controller.child, null);
  assert.equal(controller.socket, null);
  assert.match(controller.status().reason, /EPIPE/);
});

test("restarts MPV once when a load loses its IPC connection", async () => {
  const controller = new MpvController({ serverUrl: "https://media.example" });
  const request = {
    url: "https://media.example/Videos/1/stream",
    startSeconds: 0,
    title: "Example",
    fullscreen: false,
    audioTrack: 0,
    subtitleStreamIndex: -1,
    subtitleTracks: [],
  };
  let attempts = 0;
  let teardownCalls = 0;
  controller.loadRequest = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("write EPIPE");
    return true;
  };
  controller.teardownConnection = () => {
    teardownCalls += 1;
  };

  await controller.load(request);

  assert.equal(attempts, 2);
  assert.equal(teardownCalls, 1);
});

test("lets user MPV configuration own the presentation", () => {
  const args = buildMpvArguments("test-ipc", "user");

  assert.ok(!args.includes("--osc=yes"));
  assert.ok(!args.includes("--osc=no"));
  assert.ok(!args.some((argument) => argument.endsWith("thumbfast.lua")));
  assert.ok(!args.some((argument) => argument.startsWith("--script-opts")));
  assert.equal(normalizeMpvPresentation("USER"), "user");
  assert.throws(() => normalizeMpvPresentation("overlay"), /mpv-ui/);
});

test("uses OSD-aware commands for remote playback changes", async () => {
  const commands = [];
  const controller = new MpvController({ serverUrl: "https://media.example" });
  controller.ensureStarted = async () => {};
  controller.command = async (command) => {
    commands.push(command);
  };
  controller.current = true;
  controller.fileLoaded = true;

  await controller.execute("seek", 42.5);
  await controller.execute("volume", 73);
  await controller.execute("rate", 1.25);
  await controller.execute("muted", true);
  await controller.execute("subtitleTrack", -1);

  assert.deepEqual(commands, [
    ["osd-auto", "seek", "42.5", "absolute"],
    ["osd-auto", "set", "volume", "73"],
    ["osd-auto", "set", "speed", "1.25"],
    ["osd-auto", "set", "mute", "yes"],
    ["osd-auto", "set", "sid", "no"],
  ]);
});

test("loads and maps every external Jellyfin subtitle for MPV selection", async () => {
  const commands = [];
  const events = [];
  let trackList = [{ id: 1, type: "sub", external: false }];
  const controller = new MpvController({
    serverUrl: "https://media.example/jellyfin",
    presentation: "user",
    eventSink: (name, payload) => events.push({ name, payload }),
  });
  controller.child = { exitCode: null };
  controller.socket = { destroyed: false };
  controller.current = true;
  controller.pendingLoad = {
    url: "https://media.example/jellyfin/Videos/1/stream",
    startSeconds: 0,
    title: "Example",
    fullscreen: false,
    audioTrack: 1,
    externalAudioUrl: null,
    subtitleStreamIndex: 4,
    subtitleTracks: [
      {
        jellyfinIndex: 2,
        mpvTrack: 1,
        externalUrl: null,
        title: "English (ASS)",
        language: "eng",
      },
      {
        jellyfinIndex: 4,
        mpvTrack: 0,
        externalUrl: "https://media.example/jellyfin/Videos/1/Subtitles/4/Stream.srt",
        title: "Spanish (SRT)",
        language: "spa",
      },
    ],
  };
  controller.command = async (command) => {
    commands.push(command);
    if (command[0] === "get_property" && command[1] === "track-list") {
      return trackList;
    }
    if (command[0] === "sub-add") {
      trackList = [...trackList, { id: 2, type: "sub", external: true }];
    }
    return undefined;
  };

  await controller.applySelectedTracks();
  assert.ok(
    commands.some(
      (command) =>
        command[0] === "sub-add" &&
        command[1].endsWith("/Subtitles/4/Stream.srt") &&
        command[2] === "auto" &&
        command[3] === "Spanish (SRT)" &&
        command[4] === "spa",
    ),
  );
  assert.ok(
    commands.some(
      (command) =>
        command[0] === "set_property" && command[1] === "sid" && command[2] === 2,
    ),
  );

  controller.onMessage({
    event: "property-change",
    name: "sid",
    data: 2,
  });
  assert.deepEqual(events.at(-1), {
    name: "subtitleTrack",
    payload: { value: 2, jellyfinIndex: 4 },
  });

  await controller.execute("subtitleTrack", 2);
  assert.deepEqual(commands.at(-1), ["osd-auto", "set", "sid", "1"]);
});

test("passes valid MediaSegments to the integration script", async () => {
  const commands = [];
  const controller = new MpvController({ serverUrl: "https://media.example" });
  controller.ensureStarted = async () => {};
  controller.current = true;
  controller.fileLoaded = true;
  controller.child = { exitCode: null };
  controller.socket = { destroyed: false };
  controller.command = async (command) => {
    commands.push(command);
  };

  await controller.setSegments([
    { type: "Intro", startSeconds: 12, endSeconds: 45 },
    { type: "Outro", startSeconds: 500, endSeconds: 540 },
    { type: "Unknown", startSeconds: 1, endSeconds: 2 },
  ]);

  assert.deepEqual(commands, [
    [
      "script-message",
      "jellyfin-dc-segments",
      JSON.stringify([
        { type: "Intro", startSeconds: 12, endSeconds: 45 },
        { type: "Outro", startSeconds: 500, endSeconds: 540 },
      ]),
    ],
  ]);
});

test("passes validated playlist navigation to the integration script", async () => {
  const commands = [];
  const controller = new MpvController({ serverUrl: "https://media.example" });
  controller.current = true;
  controller.fileLoaded = true;
  controller.child = { exitCode: null };
  controller.socket = { destroyed: false };
  controller.command = async (command) => {
    commands.push(command);
  };

  await controller.setNavigation({ previous: false, next: true });

  assert.deepEqual(commands, [
    [
      "script-message",
      "jellyfin-dc-navigation",
      JSON.stringify({ previous: false, next: true }),
    ],
  ]);
  await assert.rejects(
    controller.setNavigation({ previous: "yes", next: true }),
    /must be booleans/,
  );
});

test("ignores MPV navigation messages that are unavailable", () => {
  const events = [];
  const controller = new MpvController({
    serverUrl: "https://media.example",
    eventSink: (name) => events.push(name),
  });

  controller.onMessage({
    event: "client-message",
    args: ["jellyfin-dc-control", "next"],
  });
  controller.pendingNavigation = { previous: true, next: false };
  controller.onMessage({
    event: "client-message",
    args: ["jellyfin-dc-control", "next"],
  });
  controller.onMessage({
    event: "client-message",
    args: ["jellyfin-dc-control", "previous"],
  });

  assert.deepEqual(events, ["previous"]);
});
