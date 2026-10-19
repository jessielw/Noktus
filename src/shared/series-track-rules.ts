import type {
  SeriesTrackContext,
  SeriesTrackContextInput,
  SeriesTrackDescriptor,
  SeriesTrackFingerprint,
  SeriesTrackResolution,
  SeriesTrackRule,
  SeriesTrackType,
} from "./types";

const MAX_TRACKS = 200;
const MAX_RULES = 500;
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ar: "ara",
  cs: "ces",
  da: "dan",
  de: "deu",
  en: "eng",
  es: "spa",
  fi: "fin",
  fr: "fra",
  he: "heb",
  hi: "hin",
  hu: "hun",
  it: "ita",
  ja: "jpn",
  ko: "kor",
  nl: "nld",
  no: "nor",
  pl: "pol",
  pt: "por",
  ro: "ron",
  ru: "rus",
  sv: "swe",
  tr: "tur",
  uk: "ukr",
  zh: "zho",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = 256): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeLanguage(value: unknown): string {
  const language = boundedString(value, 64).toLowerCase().split("-")[0] || "";
  return LANGUAGE_ALIASES[language] || language;
}

function streamIndex(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < -1 ||
    value > 999
  ) {
    throw new Error(`${field} must be an integer between -1 and 999`);
  }
  return value;
}

function normalizeTrackType(value: unknown): SeriesTrackType | null {
  return value === "Audio" || value === "Subtitle" ? value : null;
}

function normalizeTrack(value: unknown): SeriesTrackDescriptor | null {
  if (!isRecord(value)) return null;
  const type = normalizeTrackType(value.type);
  if (!type) return null;
  let index: number;
  try {
    index = streamIndex(value.index, "track index");
  } catch {
    return null;
  }
  if (index < 0) return null;
  return {
    index,
    type,
    language: normalizeLanguage(value.language),
    title: boundedString(value.title),
    isDefault: value.isDefault === true,
    isForced: value.isForced === true,
    isHearingImpaired: value.isHearingImpaired === true,
    isCommentary: value.isCommentary === true,
    isExternal: value.isExternal === true,
  };
}

export function normalizeSeriesTrackContextInput(
  value: unknown,
): SeriesTrackContextInput {
  if (!isRecord(value)) throw new Error("Series track context must be an object");
  const userId = boundedString(value.userId, 128);
  const seriesId = boundedString(value.seriesId, 128);
  if (!userId || !seriesId) {
    throw new Error("A Jellyfin user and series are required");
  }
  const rawTracks = Array.isArray(value.tracks) ? value.tracks : [];
  const byIdentity = new Map<string, SeriesTrackDescriptor>();
  for (const candidate of rawTracks.slice(0, MAX_TRACKS)) {
    const track = normalizeTrack(candidate);
    if (track) byIdentity.set(`${track.type}:${track.index}`, track);
  }
  return {
    userId,
    seriesId,
    seriesName: boundedString(value.seriesName, 256) || "Series",
    audioStreamIndex: streamIndex(value.audioStreamIndex, "audioStreamIndex"),
    subtitleStreamIndex: streamIndex(value.subtitleStreamIndex, "subtitleStreamIndex"),
    tracks: [...byIdentity.values()],
  };
}

function normalizedTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 256);
}

function hasAny(title: string, values: readonly string[]): boolean {
  return values.some((value) => title.includes(value));
}

export function fingerprintTrack(track: SeriesTrackDescriptor): SeriesTrackFingerprint {
  const title = normalizedTitle(track.title);
  const words = new Set(title.split(" ").filter(Boolean));
  return {
    language: normalizeLanguage(track.language),
    normalizedTitle: title,
    forced: track.isForced || words.has("forced") || title.includes("dialogue only"),
    hearingImpaired:
      track.isHearingImpaired ||
      words.has("sdh") ||
      words.has("cc") ||
      hasAny(title, ["hearing impaired", "closed captions"]),
    commentary:
      track.isCommentary ||
      words.has("commentary") ||
      title.includes("director comments"),
    descriptive: hasAny(title, [
      "audio description",
      "descriptive audio",
      "described video",
    ]),
    signs: words.has("signs") || words.has("songs") || title.includes("sign song"),
  };
}

function normalizeFingerprint(value: unknown): SeriesTrackFingerprint | null {
  if (!isRecord(value)) return null;
  const language = normalizeLanguage(value.language);
  const normalized = boundedString(value.normalizedTitle);
  return {
    language,
    normalizedTitle: normalizedTitle(normalized),
    forced: value.forced === true,
    hearingImpaired: value.hearingImpaired === true,
    commentary: value.commentary === true,
    descriptive: value.descriptive === true,
    signs: value.signs === true,
  };
}

function normalizeRule(value: unknown): SeriesTrackRule | null {
  if (!isRecord(value)) return null;
  const serverId = boundedString(value.serverId, 128);
  const userId = boundedString(value.userId, 128);
  const seriesId = boundedString(value.seriesId, 128);
  if (!serverId || !userId || !seriesId) return null;
  const audio = normalizeFingerprint(value.audio);
  const subtitle =
    value.subtitle === "off" ? "off" : normalizeFingerprint(value.subtitle);
  if (!subtitle) return null;
  const rule: SeriesTrackRule = {
    serverId,
    userId,
    seriesId,
    seriesName: boundedString(value.seriesName, 256) || "Series",
    subtitle,
    updatedAt:
      typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
        ? new Date(value.updatedAt).toISOString()
        : new Date(0).toISOString(),
  };
  if (audio) rule.audio = audio;
  return rule;
}

function ruleKey(
  rule: Pick<SeriesTrackRule, "serverId" | "userId" | "seriesId">,
): string {
  return `${rule.serverId}\u0000${rule.userId}\u0000${rule.seriesId}`;
}

export function normalizeSeriesTrackRules(value: unknown): SeriesTrackRule[] {
  if (!Array.isArray(value)) return [];
  const rules = new Map<string, SeriesTrackRule>();
  for (const candidate of value.slice(-MAX_RULES)) {
    const rule = normalizeRule(candidate);
    if (rule) rules.set(ruleKey(rule), rule);
  }
  return [...rules.values()]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .slice(-MAX_RULES);
}

function traitsEqual(
  left: SeriesTrackFingerprint,
  right: SeriesTrackFingerprint,
): boolean {
  return (
    left.forced === right.forced &&
    left.hearingImpaired === right.hearingImpaired &&
    left.commentary === right.commentary &&
    left.descriptive === right.descriptive &&
    left.signs === right.signs
  );
}

function matchingTrack(
  tracks: SeriesTrackDescriptor[],
  type: SeriesTrackType,
  preference: SeriesTrackFingerprint,
): SeriesTrackDescriptor | null {
  const candidates = tracks
    .filter((track) => track.type === type)
    .filter((track) => {
      const fingerprint = fingerprintTrack(track);
      return (
        (!preference.language || fingerprint.language === preference.language) &&
        traitsEqual(fingerprint, preference)
      );
    })
    .sort((left, right) => {
      const leftFingerprint = fingerprintTrack(left);
      const rightFingerprint = fingerprintTrack(right);
      const leftTitle =
        preference.normalizedTitle &&
        leftFingerprint.normalizedTitle === preference.normalizedTitle;
      const rightTitle =
        preference.normalizedTitle &&
        rightFingerprint.normalizedTitle === preference.normalizedTitle;
      if (leftTitle !== rightTitle) return leftTitle ? -1 : 1;
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.index - right.index;
    });
  return candidates[0] || null;
}

export function findSeriesTrackRule(
  rules: SeriesTrackRule[],
  context: Pick<SeriesTrackContext, "serverId" | "userId" | "seriesId">,
): SeriesTrackRule | null {
  const key = ruleKey(context);
  return rules.find((rule) => ruleKey(rule) === key) || null;
}

export function resolveSeriesTracks(
  rules: SeriesTrackRule[],
  context: SeriesTrackContext,
): SeriesTrackResolution {
  const rule = findSeriesTrackRule(rules, context);
  if (!rule) {
    return {
      audioStreamIndex: context.audioStreamIndex,
      subtitleStreamIndex: context.subtitleStreamIndex,
      matched: false,
    };
  }
  const audio = rule.audio ? matchingTrack(context.tracks, "Audio", rule.audio) : null;
  const subtitle =
    rule.subtitle === "off"
      ? "off"
      : matchingTrack(context.tracks, "Subtitle", rule.subtitle);
  return {
    audioStreamIndex: audio?.index ?? context.audioStreamIndex,
    subtitleStreamIndex:
      subtitle === "off" ? -1 : (subtitle?.index ?? context.subtitleStreamIndex),
    matched: Boolean(audio || subtitle === "off" || subtitle),
  };
}

export function saveSeriesTrackRule(
  rules: SeriesTrackRule[],
  context: SeriesTrackContext,
  updatedAt = new Date().toISOString(),
): SeriesTrackRule[] {
  const audio = context.tracks.find(
    (track) => track.type === "Audio" && track.index === context.audioStreamIndex,
  );
  const subtitle = context.tracks.find(
    (track) => track.type === "Subtitle" && track.index === context.subtitleStreamIndex,
  );
  if (context.audioStreamIndex >= 0 && !audio) {
    throw new Error("The selected Jellyfin audio track is unavailable");
  }
  if (context.subtitleStreamIndex >= 0 && !subtitle) {
    throw new Error("The selected Jellyfin subtitle track is unavailable");
  }
  const next: SeriesTrackRule = {
    serverId: context.serverId,
    userId: context.userId,
    seriesId: context.seriesId,
    seriesName: context.seriesName,
    subtitle: context.subtitleStreamIndex < 0 ? "off" : fingerprintTrack(subtitle!),
    updatedAt: new Date(updatedAt).toISOString(),
  };
  if (audio) next.audio = fingerprintTrack(audio);
  return normalizeSeriesTrackRules([
    ...rules.filter((rule) => ruleKey(rule) !== ruleKey(next)),
    next,
  ]);
}

export function removeSeriesTrackRule(
  rules: SeriesTrackRule[],
  context: unknown,
): SeriesTrackRule[] {
  if (
    !isRecord(context) ||
    ![context.serverId, context.userId, context.seriesId].every(
      (value) =>
        typeof value === "string" && value.trim().length > 0 && value.length <= 128,
    )
  ) {
    throw new Error("A saved server, user, and series are required");
  }
  const key = ruleKey(
    context as Pick<SeriesTrackContext, "serverId" | "userId" | "seriesId">,
  );
  return rules.filter((rule) => ruleKey(rule) !== key);
}
