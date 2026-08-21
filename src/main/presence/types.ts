export type PresenceMediaType = "audio" | "video";
export type PresencePlaybackState = "playing" | "paused";

export interface PresenceActivity {
  title: string;
  mediaType: PresenceMediaType;
  playbackState: PresencePlaybackState;
  positionSeconds: number;
}

export type PresenceConnectionState =
  "disabled" | "unconfigured" | "connecting" | "connected" | "unavailable";

export interface PresenceStatus {
  enabled: boolean;
  provider: "discord";
  connection: PresenceConnectionState;
}

export interface PresenceProvider {
  connect(): Promise<void>;
  setActivity(activity: PresenceActivity | null): Promise<void>;
  status(): PresenceConnectionState;
  close(): void;
}

export function normalizePresenceActivity(value: unknown): PresenceActivity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const title = typeof source.title === "string" ? source.title.trim() : "";
  if (!title) return null;
  if (title.length > 256) return null;
  if (source.mediaType !== "audio" && source.mediaType !== "video") return null;
  if (source.playbackState !== "playing" && source.playbackState !== "paused") {
    return null;
  }
  const positionSeconds = Number(source.positionSeconds);
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return null;
  return {
    title,
    mediaType: source.mediaType,
    playbackState: source.playbackState,
    positionSeconds: Math.min(positionSeconds, 31_536_000),
  };
}
