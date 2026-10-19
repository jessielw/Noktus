"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  findSeriesTrackRule,
  normalizeSeriesTrackContextInput,
  removeSeriesTrackRule,
  resolveSeriesTracks,
  saveSeriesTrackRule,
} = require("../build/shared/series-track-rules");

function track(index, type, language, title, extra = {}) {
  return {
    index,
    type,
    language,
    title,
    isDefault: false,
    isForced: false,
    isHearingImpaired: false,
    isCommentary: false,
    isExternal: false,
    ...extra,
  };
}

function context(overrides = {}) {
  return {
    serverId: "server-one",
    userId: "user-one",
    seriesId: "series-one",
    seriesName: "Example Show",
    audioStreamIndex: 1,
    subtitleStreamIndex: 4,
    tracks: [
      track(1, "Audio", "eng", "English"),
      track(2, "Audio", "jpn", "Japanese"),
      track(4, "Subtitle", "eng", "English Forced Signs", {
        isForced: true,
        isExternal: true,
      }),
      track(5, "Subtitle", "eng", "English SDH", {
        isHearingImpaired: true,
      }),
    ],
    ...overrides,
  };
}

test("matches semantic tracks when episode stream indices and language codes change", () => {
  const rules = saveSeriesTrackRule([], context(), "2026-08-02T12:00:00.000Z");
  const nextEpisode = context({
    audioStreamIndex: 7,
    subtitleStreamIndex: -1,
    tracks: [
      track(3, "Audio", "en-US", "English", { isDefault: true }),
      track(7, "Audio", "jpn", "Japanese"),
      track(8, "Subtitle", "eng", "English SDH", {
        isHearingImpaired: true,
      }),
      track(9, "Subtitle", "en", "Signs & Songs - Forced", {
        isForced: true,
      }),
    ],
  });

  assert.deepEqual(resolveSeriesTracks(rules, nextEpisode), {
    audioStreamIndex: 3,
    subtitleStreamIndex: 9,
    matched: true,
  });
});

test("stores subtitles disabled as an explicit series preference", () => {
  const rules = saveSeriesTrackRule([], context({ subtitleStreamIndex: -1 }));
  const result = resolveSeriesTracks(rules, context({ subtitleStreamIndex: 5 }));
  assert.equal(result.subtitleStreamIndex, -1);
  assert.equal(result.audioStreamIndex, 1);
});

test("falls back independently when a compatible track is unavailable", () => {
  const rules = saveSeriesTrackRule([], context());
  const result = resolveSeriesTracks(
    rules,
    context({
      audioStreamIndex: 10,
      subtitleStreamIndex: 11,
      tracks: [
        track(10, "Audio", "fra", "French"),
        track(11, "Subtitle", "fra", "French"),
      ],
    }),
  );
  assert.deepEqual(result, {
    audioStreamIndex: 10,
    subtitleStreamIndex: 11,
    matched: false,
  });
});

test("does not turn an unknown selected subtitle into a disabled preference", () => {
  assert.throws(
    () => saveSeriesTrackRule([], context({ subtitleStreamIndex: 99 })),
    /subtitle track is unavailable/,
  );
});

test("isolates and removes rules by server, user, and series", () => {
  const rules = saveSeriesTrackRule([], context());
  assert.ok(findSeriesTrackRule(rules, context()));
  assert.equal(findSeriesTrackRule(rules, context({ userId: "another-user" })), null);
  assert.deepEqual(removeSeriesTrackRule(rules, context()), []);
});

test("normalizes the untrusted renderer context", () => {
  const normalized = normalizeSeriesTrackContextInput({
    ...context(),
    tracks: [
      track(1, "Audio", "EN-us", "English"),
      track(1, "Audio", "en", "Replacement"),
      { index: -1, type: "Subtitle" },
      { index: 2, type: "Video" },
    ],
  });
  assert.equal(normalized.tracks.length, 1);
  assert.equal(normalized.tracks[0].language, "eng");
  assert.equal(normalized.tracks[0].title, "Replacement");
  assert.throws(
    () => normalizeSeriesTrackContextInput({ seriesId: "series" }),
    /user and series/,
  );
});

test("resets only the selected server, account, and series from Settings", () => {
  let rules = [];
  const contexts = [
    context(),
    context({ userId: "user-two" }),
    context({ serverId: "server-two" }),
    context({ seriesId: "series-two" }),
  ];
  for (const entry of contexts) rules = saveSeriesTrackRule(rules, entry);
  const remaining = removeSeriesTrackRule(rules, {
    serverId: "server-one",
    userId: "user-one",
    seriesId: "series-one",
  });
  assert.equal(remaining.length, 3);
  assert.equal(findSeriesTrackRule(remaining, context()), null);
  for (const entry of contexts.slice(1))
    assert.ok(findSeriesTrackRule(remaining, entry));
  for (const value of [
    null,
    {},
    { serverId: "server-one" },
    { ...context(), userId: " " },
    { ...context(), seriesId: 1 },
  ]) {
    assert.throws(
      () => removeSeriesTrackRule(rules, value),
      /server, user, and series/,
    );
  }
});
