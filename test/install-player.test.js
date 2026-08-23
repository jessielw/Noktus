"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const installPlayer = require("../src/preload/install-player");

test("installs Web presence listeners without interrupting the native player bridge", (t) => {
  const eventNames = [];
  const bridge = {
    on() {},
    status: async () => ({ backend: "mpv", startFullscreen: true }),
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = { jellyfinDesktop: bridge };
  global.document = {
    title: "Jellyfin",
    addEventListener(name, callback, capture) {
      assert.equal(typeof callback, "function");
      assert.equal(capture, true);
      eventNames.push(name);
    },
  };
  global.HTMLMediaElement = class HTMLMediaElement {};
  global.HTMLAudioElement = class HTMLAudioElement extends global.HTMLMediaElement {};
  t.after(() => {
    delete global.HTMLAudioElement;
    delete global.HTMLMediaElement;
    delete global.document;
    delete global.location;
    delete global.window;
  });

  const result = installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "contract-test",
  });

  assert.equal(result.installed, true);
  assert.equal(typeof global.window.jellyfinDcMpvPlayer, "function");
  assert.deepEqual(eventNames, [
    "play",
    "loadedmetadata",
    "playing",
    "pause",
    "seeked",
    "ended",
    "emptied",
  ]);
});

test("changes native-player eligibility without reinstalling the Jellyfin adapter", async (t) => {
  const listeners = new Map();
  const bridge = {
    status: async () => ({ backend: "web", startFullscreen: true }),
    on: (name, callback) => listeners.set(name, callback),
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = { jellyfinDesktop: bridge };
  global.document = { getElementById: () => null };
  t.after(() => {
    delete global.document;
    delete global.location;
    delete global.window;
  });

  const result = installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "web",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "test",
  });
  assert.equal(result.installed, true);

  const Player = await global.window.jellyfinDcMpvPlayer();
  const player = new Player({
    events: { trigger() {} },
    appSettings: { get: () => 1, set() {} },
    playbackManager: { syncPlayEnabled: false },
  });
  const movie = { MediaType: "Video", RunTimeTicks: 1, Type: "Movie" };

  assert.equal(player.canPlayMediaType("Video"), false);
  assert.equal(player.canPlayItem(movie, {}), false);
  listeners.get("mode")({ value: "mpv" });
  assert.equal(player.canPlayMediaType("Video"), true);
  assert.equal(player.canPlayItem(movie, {}), true);
  listeners.get("mode")({ value: "web" });
  assert.equal(player.canPlayMediaType("Video"), false);
});

test("reports stopped playback before acknowledging native shutdown", async (t) => {
  const listeners = new Map();
  const order = [];
  let acknowledge;
  const acknowledged = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const bridge = {
    status: async () => ({ backend: "mpv", startFullscreen: false }),
    on: (name, callback) => listeners.set(name, callback),
    load: async () => true,
    stop: async () => {
      order.push("native-stop");
      return true;
    },
    shutdownReady: async (requestId) => {
      order.push(`ack:${requestId}`);
      acknowledge();
      return true;
    },
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = { jellyfinDesktop: bridge };
  global.document = { getElementById: () => null };
  t.after(() => {
    delete global.document;
    delete global.location;
    delete global.window;
  });

  installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "test",
  });
  const Player = await global.window.jellyfinDcMpvPlayer();
  const playbackManager = {
    syncPlayEnabled: false,
    async stop(target) {
      order.push("playback-manager-stop");
      await target.stop();
      order.push("playback-manager-done");
    },
  };
  const player = new Player({
    events: {
      trigger(_target, name) {
        if (name === "stopped") order.push("stopped-event");
      },
    },
    appSettings: { get: () => 1, set() {} },
    playbackManager,
  });
  await player.play({
    url: "https://media.example/jellyfin/Videos/1/stream",
    item: { MediaType: "Video", RunTimeTicks: 60_000_000, Type: "Movie" },
    mediaSource: { MediaStreams: [] },
  });

  listeners.get("shutdown")({ requestId: "shutdown-1", reason: "quit" });
  await acknowledged;

  assert.deepEqual(order, [
    "playback-manager-stop",
    "native-stop",
    "stopped-event",
    "playback-manager-done",
    "ack:shutdown-1",
  ]);
  assert.equal(player.currentSrc(), null);
});

test("acknowledges shutdown immediately when MPV has no active item", async (t) => {
  const listeners = new Map();
  let acknowledgedRequest = null;
  const bridge = {
    status: async () => ({ backend: "mpv", startFullscreen: true }),
    on: (name, callback) => listeners.set(name, callback),
    shutdownReady: async (requestId) => {
      acknowledgedRequest = requestId;
      return true;
    },
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = { jellyfinDesktop: bridge };
  t.after(() => {
    delete global.location;
    delete global.window;
  });

  installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "test",
  });
  listeners.get("shutdown")({
    requestId: "shutdown-idle",
    reason: "window-close",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(acknowledgedRequest, "shutdown-idle");
});

test("passes authenticated Jellyfin MediaSegments to native playback", async (t) => {
  const listeners = new Map();
  const nativeCalls = [];
  const bridge = {
    status: async () => ({ backend: "mpv", startFullscreen: false }),
    on: (name, callback) => listeners.set(name, callback),
    load: async () => true,
    setSegments: async (segments) => nativeCalls.push(segments),
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = {
    jellyfinDesktop: bridge,
    ApiClient: {
      getUrl(path) {
        return `https://media.example/jellyfin/${path}`;
      },
      async getJSON(url) {
        assert.match(url, /MediaSegments\/movie-id/);
        assert.match(url, /includeSegmentTypes=Intro/);
        assert.match(url, /includeSegmentTypes=Outro/);
        return {
          Items: [
            { Type: "Intro", StartTicks: 10000000, EndTicks: 30000000 },
            { Type: "Outro", StartTicks: 90000000, EndTicks: 120000000 },
            { Type: "Commercial", StartTicks: 40000000, EndTicks: 50000000 },
          ],
        };
      },
    },
  };
  global.document = { getElementById: () => null };
  t.after(() => {
    delete global.document;
    delete global.location;
    delete global.window;
  });

  installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "test",
  });
  const Player = await global.window.jellyfinDcMpvPlayer();
  const player = new Player({
    events: { trigger() {} },
    appSettings: { get: () => 1, set() {} },
    playbackManager: { syncPlayEnabled: false },
  });

  const options = {
    url: "https://media.example/jellyfin/Videos/movie-id/stream",
    item: {
      Id: "movie-id",
      MediaType: "Video",
      RunTimeTicks: 120000000,
      Type: "Movie",
    },
    mediaSource: { MediaStreams: [] },
  };
  await player.play(options);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(nativeCalls, [
    [
      { type: "Intro", startSeconds: 1, endSeconds: 3 },
      { type: "Outro", startSeconds: 9, endSeconds: 12 },
    ],
  ]);
  listeners.get("ended")?.({});
});

test("decodes Jellyfin trickplay tiles into bounded BGRA windows", async (t) => {
  const listeners = new Map();
  const appended = [];
  let beginMetadata = null;
  let tileUrl = null;
  let tileAuthorization = null;
  let committed;
  const committedPromise = new Promise((resolve) => {
    committed = resolve;
  });
  const bridge = {
    status: async () => ({
      backend: "mpv",
      startFullscreen: false,
      presentation: "jellyfin",
    }),
    on: (name, callback) => listeners.set(name, callback),
    load: async () => true,
    beginTrickplay: async (metadata) => {
      beginMetadata = metadata;
      return "generation-1";
    },
    appendTrickplay: async (id, chunk) => {
      assert.equal(id, "generation-1");
      appended.push(...new Uint8Array(chunk));
      return true;
    },
    commitTrickplay: async (id) => {
      assert.equal(id, "generation-1");
      committed();
      return true;
    },
    abortTrickplay: async () => true,
    openExternal: async () => true,
  };
  const apiClient = {
    accessToken: () => "tile token",
    getCurrentUserId: () => "user-id",
    getUrl: (value) => `https://media.example/jellyfin/${value}`,
    async getJSON(url) {
      if (url.includes("MediaSegments")) return { Items: [] };
      assert.match(url, /Users\/user-id\/Items\/movie-id/);
      assert.match(url, /Fields=Trickplay/);
      return {
        Trickplay: {
          "other-source": {
            1: {
              Width: 1,
              Height: 1,
              Interval: 5_000,
              ThumbnailCount: 1,
              TileWidth: 1,
              TileHeight: 1,
            },
          },
          "source-id": {
            2: {
              Width: 2,
              Height: 1,
              Interval: 10_000,
              ThumbnailCount: 2,
              TileWidth: 2,
              TileHeight: 1,
            },
          },
        },
      };
    },
  };
  let sourceX = 0;
  const context = {
    clearRect() {},
    drawImage(_bitmap, x) {
      sourceX = x;
    },
    getImageData() {
      const red = sourceX === 0 ? 10 : 40;
      const blue = sourceX === 0 ? 30 : 60;
      return {
        data: new Uint8ClampedArray([red, 20, blue, 255, red + 1, 21, blue + 1, 255]),
      };
    },
  };

  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = { jellyfinDesktop: bridge, ApiClient: apiClient };
  global.document = {
    getElementById: () => null,
    createElement(name) {
      assert.equal(name, "canvas");
      return { width: 0, height: 0, getContext: () => context };
    },
  };
  global.fetch = async (url, init) => {
    tileUrl = String(url);
    tileAuthorization = init.headers.Authorization;
    return { ok: true, blob: async () => ({}) };
  };
  global.createImageBitmap = async () => ({ width: 4, height: 1, close() {} });
  t.after(() => {
    delete global.createImageBitmap;
    delete global.fetch;
    delete global.document;
    delete global.location;
    delete global.window;
  });

  installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "test",
  });
  const Player = await global.window.jellyfinDcMpvPlayer();
  const player = new Player({
    events: { trigger() {} },
    appSettings: { get: () => 1, set() {} },
    playbackManager: { syncPlayEnabled: false },
  });
  await player.play({
    url: "https://media.example/jellyfin/Videos/movie-id/stream",
    item: {
      Id: "movie-id",
      MediaType: "Video",
      RunTimeTicks: 200_000_000,
      Type: "Movie",
    },
    mediaSource: { Id: "source-id", MediaStreams: [] },
  });
  await committedPromise;

  assert.deepEqual(beginMetadata, {
    count: 2,
    intervalMs: 10_000,
    width: 2,
    height: 1,
    first: 0,
    total: 2,
  });
  assert.match(tileUrl, /Trickplay\/2\/0\.jpg/);
  assert.match(tileUrl, /MediaSourceId=source-id/);
  assert.match(tileAuthorization, /Token="tile%20token"/);
  assert.deepEqual(
    appended,
    [30, 20, 10, 255, 31, 21, 11, 255, 60, 20, 40, 255, 61, 21, 41, 255],
  );
});

test("uses one standard MediaBrowser Authorization header for fallback API calls", async (t) => {
  const listeners = new Map();
  let request = null;
  const previousFetch = global.fetch;
  global.fetch = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      async json() {
        return { Items: [] };
      },
    };
  };
  const bridge = {
    status: async () => ({ backend: "mpv", startFullscreen: false }),
    on: (name, callback) => listeners.set(name, callback),
    load: async () => true,
    setSegments: async () => true,
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = {
    jellyfinDesktop: bridge,
    ApiClient: {
      deviceId: "electron-user-device",
      accessToken: () => "secret-token",
      getUrl(path) {
        return `https://media.example/jellyfin/${path}`;
      },
    },
  };
  global.document = { getElementById: () => null };
  t.after(() => {
    global.fetch = previousFetch;
    delete global.document;
    delete global.location;
    delete global.window;
  });

  installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus Desktop",
    appVersion: "1.2.3",
    deviceName: "Electron Test",
  });
  const Player = await global.window.jellyfinDcMpvPlayer();
  const player = new Player({
    events: { trigger() {} },
    appSettings: { get: () => 1, set() {} },
    playbackManager: { syncPlayEnabled: false },
  });

  await player.play({
    url: "https://media.example/jellyfin/Videos/movie-id/stream",
    item: {
      Id: "movie-id",
      MediaType: "Video",
      RunTimeTicks: 60_000_000,
      Type: "Movie",
    },
    mediaSource: { MediaStreams: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(request);
  assert.match(
    request.init.headers.Authorization,
    /^MediaBrowser Token="secret-token", Client="Noktus%20Desktop", Version="1\.2\.3", Device="Electron%20Test", DeviceId="electron-user-device"$/,
  );
  assert.equal(request.init.headers["X-Emby-Token"], undefined);
  listeners.get("ended")?.({});
});

test("offers every Jellyfin external subtitle in MPV before one is selected", async (t) => {
  const listeners = new Map();
  const loads = [];
  const subtitleSelections = [];
  const bridge = {
    status: async () => ({ backend: "mpv", startFullscreen: false }),
    on: (name, callback) => listeners.set(name, callback),
    load: async (request) => {
      loads.push(request);
      return true;
    },
    setSubtitleTrack: async (index) => {
      subtitleSelections.push(index);
      return true;
    },
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = { jellyfinDesktop: bridge };
  global.document = { getElementById: () => null };
  t.after(() => {
    delete global.document;
    delete global.location;
    delete global.window;
  });

  installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "test",
  });
  const Player = await global.window.jellyfinDcMpvPlayer();
  const player = new Player({
    events: { trigger() {} },
    appSettings: { get: () => 1, set() {} },
    playbackManager: { syncPlayEnabled: false },
  });

  await player.play({
    url: "https://media.example/jellyfin/Videos/movie-id/stream",
    item: {
      Id: "movie-id",
      MediaType: "Video",
      RunTimeTicks: 60_000_000,
      Type: "Movie",
    },
    mediaSource: {
      DefaultSubtitleStreamIndex: -1,
      MediaStreams: [
        {
          Index: 2,
          Type: "Subtitle",
          DisplayTitle: "English (ASS)",
          Language: "eng",
        },
        {
          Index: 4,
          Type: "Subtitle",
          IsExternal: true,
          DeliveryMethod: "External",
          DeliveryUrl:
            "https://media.example/jellyfin/Videos/movie-id/Subtitles/4/Stream.srt",
          DisplayTitle: "Spanish (SRT)",
          Language: "spa",
        },
        {
          Index: 5,
          Type: "Subtitle",
          IsExternal: true,
          DeliveryMethod: "External",
          DeliveryUrl:
            "https://media.example/jellyfin/Videos/movie-id/Subtitles/5/Stream.vtt",
          DisplayTitle: "French (VTT)",
          Language: "fra",
        },
      ],
    },
  });

  assert.equal(loads[0].subtitleStreamIndex, -1);
  assert.deepEqual(loads[0].subtitleTracks, [
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
      externalUrl:
        "https://media.example/jellyfin/Videos/movie-id/Subtitles/4/Stream.srt",
      title: "Spanish (SRT)",
      language: "spa",
    },
    {
      jellyfinIndex: 5,
      mpvTrack: 0,
      externalUrl:
        "https://media.example/jellyfin/Videos/movie-id/Subtitles/5/Stream.vtt",
      title: "French (VTT)",
      language: "fra",
    },
  ]);

  player.setSubtitleStreamIndex(4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(subtitleSelections, [4]);

  listeners.get("subtitleTrack")({ value: 2, jellyfinIndex: 5 });
  assert.equal(player.getSubtitleStreamIndex(), 5);
});

test("resolves preferences before load and remembers later track changes", async (t) => {
  const listeners = new Map();
  const loads = [];
  const contexts = [];
  let cleared = 0;
  const bridge = {
    status: async () => ({ backend: "mpv", startFullscreen: false }),
    on: (name, callback) => listeners.set(name, callback),
    resolveSeriesTracks: async (context) => {
      contexts.push({ kind: "resolve", context });
      return { audioStreamIndex: 2, subtitleStreamIndex: 4, matched: true };
    },
    rememberSeriesTracks: async (context) => {
      contexts.push({ kind: "remember", context });
      return true;
    },
    clearSeriesTrackContext: async () => {
      cleared += 1;
      return true;
    },
    load: async (request) => {
      loads.push(request);
      return true;
    },
    setSubtitleTrack: async () => true,
    stop: async () => true,
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = {
    jellyfinDesktop: bridge,
    ApiClient: {
      getCurrentUserId: () => "user-id",
      getUrl: (path) => `https://media.example/jellyfin/${path}`,
      getJSON: async () => ({ Items: [] }),
    },
  };
  global.document = { getElementById: () => null };
  t.after(() => {
    delete global.document;
    delete global.location;
    delete global.window;
  });

  installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "test",
  });
  const Player = await global.window.jellyfinDcMpvPlayer();
  const player = new Player({
    events: { trigger() {} },
    appSettings: { get: () => 1, set() {} },
    playbackManager: { syncPlayEnabled: false },
  });
  const mediaSource = {
    DefaultAudioStreamIndex: 1,
    DefaultSubtitleStreamIndex: 3,
    MediaStreams: [
      { Index: 1, Type: "Audio", Language: "eng", DisplayTitle: "English" },
      { Index: 2, Type: "Audio", Language: "jpn", DisplayTitle: "Japanese" },
      { Index: 3, Type: "Subtitle", Language: "eng", DisplayTitle: "English" },
      { Index: 4, Type: "Subtitle", Language: "spa", DisplayTitle: "Spanish" },
    ],
  };

  await player.play({
    url: "https://media.example/jellyfin/Videos/episode/stream",
    item: {
      Id: "episode",
      Type: "Episode",
      MediaType: "Video",
      SeriesId: "series-id",
      SeriesName: "Example Show",
      RunTimeTicks: 60_000_000,
    },
    mediaSource,
  });

  assert.equal(contexts[0].context.userId, "user-id");
  assert.equal(contexts[0].context.seriesId, "series-id");
  assert.equal(loads[0].audioTrack, 2);
  assert.equal(loads[0].subtitleStreamIndex, 4);
  assert.equal(player.getAudioStreamIndex(), 2);
  assert.equal(player.getSubtitleStreamIndex(), 4);

  listeners.get("subtitleTrack")({ value: 2, jellyfinIndex: 4 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(contexts.length, 1);

  listeners.get("loaded")();
  player.setSubtitleStreamIndex(3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(contexts.at(-1).kind, "remember");
  assert.equal(contexts.at(-1).context.subtitleStreamIndex, 3);

  await player.stop();
  assert.equal(cleared, 1);
});

test("only enables MPV queue controls for explicit adjacent playlist items", async (t) => {
  const listeners = new Map();
  const navigationCalls = [];
  const playbackCalls = [];
  let playlist = [];
  const bridge = {
    status: async () => ({ backend: "mpv", startFullscreen: false }),
    on: (name, callback) => listeners.set(name, callback),
    load: async () => true,
    setNavigation: async (navigation) => navigationCalls.push(navigation),
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = { jellyfinDesktop: bridge };
  global.document = { getElementById: () => null };
  t.after(() => {
    delete global.document;
    delete global.location;
    delete global.window;
  });

  installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "test",
  });
  const Player = await global.window.jellyfinDcMpvPlayer();
  const playbackManager = {
    syncPlayEnabled: false,
    async getPlaylist() {
      return playlist;
    },
    async nextTrack() {
      playbackCalls.push("next");
    },
    async previousTrack() {
      playbackCalls.push("previous");
    },
  };
  const player = new Player({
    events: { trigger() {} },
    appSettings: { get: () => 1, set() {} },
    playbackManager,
  });
  const mediaSource = { MediaStreams: [] };
  const movie = {
    Id: "movie-id",
    MediaType: "Video",
    RunTimeTicks: 60_000_000,
    Type: "Movie",
  };

  playlist = [movie];
  await player.play({
    url: "https://media.example/jellyfin/Videos/movie-id/stream",
    item: movie,
    mediaSource,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(navigationCalls.at(-1), {
    previous: false,
    next: false,
  });
  listeners.get("next")({});
  listeners.get("previous")({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(playbackCalls, []);

  const previousEpisode = {
    Id: "episode-1",
    PlaylistItemId: "queue-1",
  };
  const currentEpisode = {
    Id: "episode-2",
    PlaylistItemId: "queue-2",
    MediaType: "Video",
    RunTimeTicks: 60_000_000,
    Type: "Episode",
  };
  const nextEpisode = {
    Id: "episode-3",
    PlaylistItemId: "queue-3",
  };
  playlist = [previousEpisode, currentEpisode, nextEpisode];
  await player.play({
    url: "https://media.example/jellyfin/Videos/episode-2/stream",
    item: currentEpisode,
    mediaSource,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(navigationCalls.at(-1), {
    previous: true,
    next: true,
  });
  listeners.get("next")({});
  listeners.get("previous")({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(playbackCalls, ["next", "previous"]);
});

test("fails closed when a repeated item id makes queue position ambiguous", async (t) => {
  const listeners = new Map();
  const navigationCalls = [];
  const bridge = {
    status: async () => ({ backend: "mpv", startFullscreen: false }),
    on: (name, callback) => listeners.set(name, callback),
    load: async () => true,
    setNavigation: async (navigation) => navigationCalls.push(navigation),
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = { jellyfinDesktop: bridge };
  global.document = { getElementById: () => null };
  t.after(() => {
    delete global.document;
    delete global.location;
    delete global.window;
  });

  installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "test",
  });
  const Player = await global.window.jellyfinDcMpvPlayer();
  const item = {
    Id: "repeated-id",
    MediaType: "Video",
    RunTimeTicks: 60_000_000,
    Type: "Episode",
  };
  const player = new Player({
    events: { trigger() {} },
    appSettings: { get: () => 1, set() {} },
    playbackManager: {
      syncPlayEnabled: false,
      async getPlaylist() {
        return [item, item];
      },
    },
  });

  await player.play({
    url: "https://media.example/jellyfin/Videos/repeated-id/stream",
    item,
    mediaSource: { MediaStreams: [] },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(navigationCalls, [{ previous: false, next: false }]);
});

test("refreshes navigation after Jellyfin establishes the initial series queue", async (t) => {
  const listeners = new Map();
  const queueListeners = new Map();
  const navigationCalls = [];
  let playlist = [];
  let currentIndex = -1;
  const bridge = {
    status: async () => ({ backend: "mpv", startFullscreen: false }),
    on: (name, callback) => listeners.set(name, callback),
    load: async () => true,
    setNavigation: async (navigation) => navigationCalls.push(navigation),
    openExternal: async () => true,
  };
  global.location = new URL("https://media.example/jellyfin/web/");
  global.window = { jellyfinDesktop: bridge };
  global.document = { getElementById: () => null };
  t.after(() => {
    delete global.document;
    delete global.location;
    delete global.window;
  });

  installPlayer({
    serverUrl: "https://media.example/jellyfin",
    backend: "mpv",
    appName: "Noktus",
    appVersion: "test",
    deviceName: "test",
  });
  const Player = await global.window.jellyfinDcMpvPlayer();
  const events = {
    trigger() {},
    on(_target, name, callback) {
      queueListeners.set(name, callback);
    },
  };
  const playbackManager = {
    syncPlayEnabled: false,
    async getPlaylist() {
      return playlist;
    },
    getCurrentPlaylistIndex() {
      return currentIndex;
    },
  };
  const player = new Player({
    events,
    appSettings: { get: () => 1, set() {} },
    playbackManager,
  });
  const firstEpisode = {
    Id: "episode-1",
    PlaylistItemId: "queue-1",
    MediaType: "Video",
    RunTimeTicks: 60_000_000,
    Type: "Episode",
  };
  const secondEpisode = {
    Id: "episode-2",
    PlaylistItemId: "queue-2",
  };

  await player.play({
    url: "https://media.example/jellyfin/Videos/episode-1/stream",
    item: firstEpisode,
    mediaSource: { MediaStreams: [] },
  });

  // Jellyfin Web sets its local playlist immediately after player.play()
  // resolves, so the native adapter must read it on the following task.
  playlist = [firstEpisode, secondEpisode];
  currentIndex = 0;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(navigationCalls.at(-1), {
    previous: false,
    next: true,
  });

  currentIndex = 1;
  queueListeners.get("playlistitemmove")();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(navigationCalls.at(-1), {
    previous: true,
    next: false,
  });
});
