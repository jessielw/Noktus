export type PlaybackMode = "web" | "mpv";
export type MpvPresentation = "jellyfin" | "user";
export type MpvProvider = "mpv" | "mpv.net" | "unknown";
export type MpvExecutableSource =
  "command-line" | "environment" | "settings" | "path" | "common" | "unresolved";

export interface MpvDiagnostic {
  available: boolean;
  supported: boolean;
  provider: MpvProvider;
  executable: string;
  source: MpvExecutableSource;
  version: string | null;
  versionLine: string | null;
  reason: string;
  configuredPathIgnored: boolean;
}

export interface ServerProfile {
  id: string;
  name: string;
  displayName?: string;
  url: string;
  version?: string;
}

export type ServerConnectionState = "saved" | "checking" | "online" | "offline";

export interface ServerConnectionStatus {
  state: ServerConnectionState;
  message?: string;
}

export interface AppSettings {
  version: number;
  discordRichPresenceEnabled: boolean;
  playbackMode: PlaybackMode;
  startMpvFullscreen: boolean;
  mpvPresentation: MpvPresentation;
  servers: ServerProfile[];
  activeServerId?: string;
  mpvPath?: string;
  mpvProfile?: string;
  seriesTrackRules: SeriesTrackRule[];
}

export interface SettingsSnapshot {
  discordRichPresenceEnabled: boolean;
  discordPresenceConnection:
    "disabled" | "unconfigured" | "connecting" | "connected" | "unavailable";
  playbackMode: PlaybackMode;
  startMpvFullscreen: boolean;
  mpvPresentation: MpvPresentation;
  mpvPath: string;
  mpvProfile: string;
  mpvDiagnostic: MpvDiagnostic;
  appVersion: string;
}

export interface MpvProfileSummary {
  name: string;
  description: string;
}

export interface MpvProfileDiscovery {
  profiles: MpvProfileSummary[];
  reason: string;
}

export type SeriesTrackType = "Audio" | "Subtitle";

export interface SeriesTrackDescriptor {
  index: number;
  type: SeriesTrackType;
  language: string;
  title: string;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
  isCommentary: boolean;
  isExternal: boolean;
}

export interface SeriesTrackFingerprint {
  language: string;
  normalizedTitle: string;
  forced: boolean;
  hearingImpaired: boolean;
  commentary: boolean;
  descriptive: boolean;
  signs: boolean;
}

export interface SeriesTrackRule {
  serverId: string;
  userId: string;
  seriesId: string;
  seriesName: string;
  audio?: SeriesTrackFingerprint;
  subtitle: SeriesTrackFingerprint | "off";
  updatedAt: string;
}

export interface SeriesTrackContextInput {
  userId: string;
  seriesId: string;
  seriesName: string;
  audioStreamIndex: number;
  subtitleStreamIndex: number;
  tracks: SeriesTrackDescriptor[];
}

export interface SeriesTrackContext extends SeriesTrackContextInput {
  serverId: string;
}

export interface SeriesTrackResolution {
  audioStreamIndex: number;
  subtitleStreamIndex: number;
  matched: boolean;
}

export interface ServerManagerSnapshot {
  servers: ServerProfile[];
  serverStates: Record<string, ServerConnectionStatus>;
  canClose: boolean;
  activeServerId?: string;
  connectionError?: string;
  statusMessage?: string;
  appVersion: string;
}

export interface SaveServerRequest {
  url: string;
  displayName?: string;
  replacingId?: string;
}

export interface MpvLoadRequest {
  url: string;
  startSeconds: number;
  title: string;
  fullscreen: boolean;
  audioTrack: number;
  externalAudioUrl: string | null;
  subtitleStreamIndex: number;
  subtitleTracks: MpvSubtitleTrack[];
}

export interface MpvSubtitleTrack {
  jellyfinIndex: number;
  mpvTrack: number;
  externalUrl: string | null;
  title: string;
  language: string;
}

export type MpvSegmentType = "Intro" | "Outro" | "Recap" | "Preview" | "Commercial";

export interface MpvSegment {
  type: MpvSegmentType;
  startSeconds: number;
  endSeconds: number;
}

export interface MpvNavigationState {
  previous: boolean;
  next: boolean;
}

export interface MpvStatus {
  backend: PlaybackMode;
  provider: MpvProvider;
  available: boolean;
  ready: boolean;
  executable: string;
  presentation: MpvPresentation;
  reason: string;
  source?: MpvExecutableSource;
  version?: string | null;
  startFullscreen?: boolean;
}

export type MpvEventName =
  | "ready"
  | "loaded"
  | "paused"
  | "position"
  | "duration"
  | "volume"
  | "muted"
  | "rate"
  | "fullscreen"
  | "audioTrack"
  | "subtitleTrack"
  | "next"
  | "previous"
  | "trickplayNeed"
  | "ended"
  | "quit"
  | "failed"
  | "shutdown"
  | "mode";

export type MpvEventPayload = Record<string, unknown>;

export interface DesktopBridge {
  status(): Promise<MpvStatus>;
  load(request: unknown): Promise<boolean>;
  play(): Promise<boolean>;
  pause(): Promise<boolean>;
  stop(): Promise<boolean>;
  seek(seconds: number): Promise<boolean>;
  setVolume(volume: number): Promise<boolean>;
  setMuted(muted: boolean): Promise<boolean>;
  setRate(rate: number): Promise<boolean>;
  setAudioTrack(track: number): Promise<boolean>;
  setSubtitleTrack(streamIndex: number): Promise<boolean>;
  setSegments(segments: unknown): Promise<boolean>;
  setNavigation(navigation: unknown): Promise<boolean>;
  beginTrickplay(metadata: unknown): Promise<string | null>;
  appendTrickplay(id: string, chunk: ArrayBuffer): Promise<boolean>;
  commitTrickplay(id: string): Promise<boolean>;
  abortTrickplay(id: string): Promise<boolean>;
  clearTrickplay(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<boolean>;
  resolveSeriesTracks(context: unknown): Promise<SeriesTrackResolution>;
  rememberSeriesTracks(context: unknown): Promise<boolean>;
  clearSeriesTrackContext(): Promise<boolean>;
  shutdownReady(requestId: string): Promise<boolean>;
  focusApp(): Promise<boolean>;
  playHere(url: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  updatePresence(activity: unknown): Promise<boolean>;
  clearPresence(): Promise<boolean>;
  onPresenceSync(callback: () => void): void;
  on(name: MpvEventName, callback: (payload: MpvEventPayload) => void): void;
}

export interface SettingsBridge {
  load(): Promise<SettingsSnapshot>;
  save(settings: unknown): Promise<SettingsSnapshot>;
  browseMpv(): Promise<string | null>;
  testMpv(path: string): Promise<MpvDiagnostic>;
  listMpvProfiles(path: string): Promise<MpvProfileDiscovery>;
}

export interface ServerManagerBridge {
  load(): Promise<ServerManagerSnapshot>;
  save(request: unknown): Promise<ServerManagerSnapshot>;
  activate(serverId: string): Promise<ServerManagerSnapshot>;
  remove(serverId: string): Promise<ServerManagerSnapshot>;
  forgetLogin(serverId: string): Promise<ServerManagerSnapshot>;
  onChanged(callback: (snapshot: ServerManagerSnapshot) => void): void;
}
