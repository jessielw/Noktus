"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SETTINGS_VERSION,
  loadSettings,
  normalizeSettings,
  removeServer,
  saveSettings,
  updateServerDisplayName,
  upsertServer,
} = require("../build/shared/settings");

test("migrates single-server settings into the server list", () => {
  const legacyId = "legacy:https://media.example/jellyfin";
  assert.deepEqual(
    normalizeSettings({
      serverUrl: "https://media.example/jellyfin/web/",
      playbackMode: "mpv",
      startMpvFullscreen: false,
      mpvPresentation: "user",
      mpvPath: " C:\\tools\\mpv.exe ",
    }),
    {
      version: SETTINGS_VERSION,
      discordRichPresenceEnabled: true,
      playbackMode: "mpv",
      startMpvFullscreen: false,
      mpvPresentation: "user",
      servers: [
        {
          id: legacyId,
          name: "media.example",
          url: "https://media.example/jellyfin",
        },
      ],
      seriesTrackRules: [],
      activeServerId: legacyId,
      mpvPath: "C:\\tools\\mpv.exe",
    },
  );
});

test("uses safe defaults for missing or unsupported settings", () => {
  assert.deepEqual(normalizeSettings({ playbackMode: "broken" }), {
    version: SETTINGS_VERSION,
    discordRichPresenceEnabled: true,
    playbackMode: "web",
    startMpvFullscreen: true,
    mpvPresentation: "jellyfin",
    servers: [],
    seriesTrackRules: [],
  });
});

test("upserts, activates, and removes server profiles", () => {
  const first = upsertServer(normalizeSettings(), {
    id: "one",
    name: "Home",
    displayName: "Living room",
    url: "https://home.example",
    version: "10.11.0",
  });
  const second = upsertServer(first, {
    id: "two",
    name: "Family",
    url: "https://family.example",
  });
  assert.equal(second.servers.length, 2);
  assert.equal(second.activeServerId, "two");
  assert.equal(second.servers[0].displayName, "Living room");

  const removed = removeServer(second, "two");
  assert.deepEqual(
    removed.servers.map((server) => server.id),
    ["one"],
  );
  assert.equal(removed.activeServerId, "one");
});

test("migrates optional local display names without changing server identity", () => {
  const settings = normalizeSettings({
    version: 1,
    servers: [
      {
        id: "home-id",
        name: "Jellyfin",
        displayName: " Home theater ",
        url: "https://home.example/jellyfin",
      },
    ],
  });

  assert.equal(settings.version, SETTINGS_VERSION);
  assert.deepEqual(settings.servers[0], {
    id: "home-id",
    name: "Jellyfin",
    displayName: "Home theater",
    url: "https://home.example/jellyfin",
  });
});

test("updates a local display name without activating or changing its server", () => {
  const settings = normalizeSettings({
    servers: [
      { id: "one", name: "One", url: "https://one.example" },
      { id: "two", name: "Two", url: "https://two.example" },
    ],
    activeServerId: "one",
  });
  const renamed = updateServerDisplayName(settings, "two", " Den ");

  assert.equal(renamed.activeServerId, "one");
  assert.equal(renamed.servers[1].displayName, "Den");
  assert.equal(renamed.servers[1].url, "https://two.example");
});

test("replaces a migrated URL profile with Jellyfin's stable server ID", () => {
  const migrated = normalizeSettings({
    serverUrl: "https://media.example/jellyfin",
  });
  const upgraded = upsertServer(
    migrated,
    {
      id: "stable-server-id",
      name: "Media",
      url: "https://media.example/jellyfin",
      version: "10.11.0",
    },
    migrated.activeServerId,
  );

  assert.equal(upgraded.servers.length, 1);
  assert.equal(upgraded.servers[0].id, "stable-server-id");
  assert.equal(upgraded.activeServerId, "stable-server-id");
});

test("refreshing a saved server does not reorder the picker", () => {
  const settings = normalizeSettings({
    servers: [
      { id: "one", name: "One", url: "https://one.example" },
      { id: "two", name: "Two", url: "https://two.example" },
    ],
    activeServerId: "two",
  });
  const refreshed = upsertServer(settings, {
    id: "one",
    name: "One renamed",
    url: "https://one.example",
  });

  assert.deepEqual(
    refreshed.servers.map((server) => server.id),
    ["one", "two"],
  );
  assert.equal(refreshed.activeServerId, "one");
});

test("round trips settings through the versioned JSON file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jellyfin-dc-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "settings.json");

  saveSettings(filePath, {
    servers: [
      {
        id: "local-server",
        name: "Local",
        displayName: "Upstairs",
        url: "http://127.0.0.1:8096",
      },
    ],
    activeServerId: "local-server",
    playbackMode: "mpv",
    startMpvFullscreen: false,
  });

  assert.deepEqual(loadSettings(filePath), {
    version: SETTINGS_VERSION,
    discordRichPresenceEnabled: true,
    playbackMode: "mpv",
    startMpvFullscreen: false,
    mpvPresentation: "jellyfin",
    servers: [
      {
        id: "local-server",
        name: "Local",
        displayName: "Upstairs",
        url: "http://127.0.0.1:8096",
      },
    ],
    activeServerId: "local-server",
    seriesTrackRules: [],
  });
});

test("normalizes one named MPV profile", () => {
  assert.equal(
    normalizeSettings({ mpvProfile: " high-quality " }).mpvProfile,
    "high-quality",
  );
  assert.equal(normalizeSettings({ mpvProfile: "bad,other" }).mpvProfile, undefined);
});

test("removing a server removes its local series track rules", () => {
  const settings = normalizeSettings({
    servers: [{ id: "one", name: "One", url: "https://one.example" }],
    seriesTrackRules: [
      {
        serverId: "one",
        userId: "user",
        seriesId: "series",
        seriesName: "Example",
        subtitle: "off",
        updatedAt: "2026-08-02T12:00:00.000Z",
      },
    ],
  });
  assert.equal(settings.seriesTrackRules.length, 1);
  assert.deepEqual(removeServer(settings, "one").seriesTrackRules, []);
});

test("recovers from malformed settings without failing startup", (t) => {
  const warnings = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jellyfin-dc-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "settings.json");
  fs.writeFileSync(filePath, "{invalid", "utf8");

  assert.equal(
    loadSettings(filePath, {
      logger: { warn: (...values) => warnings.push(values) },
    }).playbackMode,
    "web",
  );
  assert.equal(warnings.length, 1);
});
