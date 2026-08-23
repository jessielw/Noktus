import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { validateMediaUrl } from "../../shared/url-policy";
import { normalizeMpvProfile } from "../../shared/mpv-profile";
import type {
  MpvEventName,
  MpvEventPayload,
  MpvLoadRequest,
  MpvNavigationState,
  MpvPresentation,
  MpvProvider,
  MpvSegment,
  MpvSegmentType,
  MpvStatus,
  MpvSubtitleTrack,
} from "../../shared/types";
import { detectMpvProvider, isMpvProvider } from "./mpv-provider";
import { TrickplayStore } from "./trickplay-store";

const COMMAND_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 5000;
const DEFAULT_INTEGRATION_SCRIPT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "resources",
  "mpv",
  "jellyfin_dc.lua",
);
const JELLYFIN_OSC_OPTIONS = [
  "osc-layout=bottombar",
  "osc-seekbarstyle=bar",
  "osc-boxalpha=55",
  "osc-hidetimeout=1200",
  "osc-fadeduration=180",
  "osc-fadein=yes",
  "osc-timetotal=yes",
  "osc-scalefullscreen=1.1",
];

type MpvCommandPart = string | number | boolean;
type MpvCommand = MpvCommandPart[];
type MpvEventSink = (event: MpvEventName, payload: MpvEventPayload) => void;

interface PendingCommand {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: NodeJS.Timeout;
  commandName: string;
}

interface MpvControllerOptions {
  serverUrl: string;
  executable?: string;
  provider?: MpvProvider;
  presentation?: MpvPresentation;
  profile?: string;
  integrationScript?: string | null;
  eventSink?: MpvEventSink;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function canRetryLoad(error: unknown): boolean {
  const message = errorMessage(error);
  return [
    "MPV is not ready",
    "MPV IPC failed",
    "MPV IPC closed",
    "MPV exited",
    "write EPIPE",
  ].some((needle) => message.includes(needle));
}

function isInvalidParameterError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("invalid parameter");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function numberInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function trackNumber(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 999
  ) {
    throw new Error(`${field} must be an integer between 0 and 999`);
  }
  return value;
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

const MPV_SEGMENT_TYPES: readonly MpvSegmentType[] = [
  "Intro",
  "Outro",
  "Recap",
  "Preview",
  "Commercial",
];

function normalizeSegments(value: unknown): MpvSegment[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("segments must be an array");

  return value
    .slice(0, 100)
    .flatMap((candidate): MpvSegment[] => {
      if (!isRecord(candidate)) return [];
      const type = candidate.type;
      const startSeconds = candidate.startSeconds;
      const endSeconds = candidate.endSeconds;
      if (
        typeof type !== "string" ||
        !MPV_SEGMENT_TYPES.includes(type as MpvSegmentType) ||
        typeof startSeconds !== "number" ||
        !Number.isFinite(startSeconds) ||
        typeof endSeconds !== "number" ||
        !Number.isFinite(endSeconds) ||
        startSeconds < 0 ||
        endSeconds <= startSeconds ||
        endSeconds > 315360000
      ) {
        return [];
      }
      return [
        {
          type: type as MpvSegmentType,
          startSeconds,
          endSeconds,
        },
      ];
    })
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

function normalizeNavigation(value: unknown): MpvNavigationState {
  if (!isRecord(value)) {
    throw new Error("navigation must be an object");
  }
  if (typeof value.previous !== "boolean" || typeof value.next !== "boolean") {
    throw new Error("navigation previous and next must be booleans");
  }
  return {
    previous: value.previous,
    next: value.next,
  };
}

const EMPTY_NAVIGATION: Readonly<MpvNavigationState> = {
  previous: false,
  next: false,
};

export function normalizeMpvPresentation(value: unknown = "jellyfin"): MpvPresentation {
  const normalized = String(value).toLowerCase();
  if (normalized !== "jellyfin" && normalized !== "user") {
    throw new Error("--mpv-ui must be either jellyfin or user");
  }
  return normalized;
}

export function buildMpvArguments(
  ipcPath: string,
  presentation: MpvPresentation = "jellyfin",
  integrationScript: string | null = null,
  provider: MpvProvider = "mpv",
  profile?: string,
): string[] {
  const args: string[] = [];
  const normalizedProfile = normalizeMpvProfile(profile);
  if (normalizedProfile) args.push(`--profile=${normalizedProfile}`);
  args.push("--idle=yes", "--keep-open=no", `--input-ipc-server=${ipcPath}`);
  if (provider === "mpv") {
    args.push(
      "--input-default-bindings=yes",
      "--force-window=immediate",
      "--no-terminal",
    );
  } else if (provider === "mpv.net") {
    args.push("--input-default-bindings=yes", "--process-instance=multi");
  }
  if (normalizeMpvPresentation(presentation) === "jellyfin") {
    args.push(
      "--osc=no",
      "--osd-on-seek=msg-bar",
      "--osd-duration=1800",
      ...JELLYFIN_OSC_OPTIONS.map((option) => `--script-opts-append=${option}`),
    );
    if (integrationScript) {
      const scriptDirectory = path.dirname(integrationScript);
      args.push(
        `--script=${path.join(scriptDirectory, "thumbfast.lua")}`,
        `--script=${path.join(scriptDirectory, "trickplay-osc.lua")}`,
      );
    }
  }
  if (integrationScript) args.push(`--script=${integrationScript}`);
  return args;
}

export function normalizeLoadRequest(
  value: unknown,
  serverUrl: string,
): MpvLoadRequest {
  if (!isRecord(value)) {
    throw new Error("The MPV load request must be an object");
  }
  const title = value.title ?? "";
  if (typeof title !== "string") throw new Error("title must be a string");
  const fullscreen = value.fullscreen ?? true;
  if (typeof fullscreen !== "boolean") {
    throw new Error("fullscreen must be a boolean");
  }

  const optionalUrl = (field: string): string | null => {
    const rawUrl = value[field];
    if (rawUrl == null || rawUrl === "") return null;
    return validateMediaUrl(rawUrl, serverUrl);
  };
  const rawSubtitleTracks = value.subtitleTracks ?? [];
  if (!Array.isArray(rawSubtitleTracks)) {
    throw new Error("subtitleTracks must be an array");
  }
  const seenSubtitleIndexes = new Set<number>();
  const subtitleTracks = rawSubtitleTracks
    .slice(0, 100)
    .map((candidate, position): MpvSubtitleTrack => {
      if (!isRecord(candidate)) {
        throw new Error(`subtitleTracks[${position}] must be an object`);
      }
      const jellyfinIndex = streamIndex(
        candidate.jellyfinIndex,
        `subtitleTracks[${position}].jellyfinIndex`,
      );
      if (jellyfinIndex < 0) {
        throw new Error(
          `subtitleTracks[${position}].jellyfinIndex must not be negative`,
        );
      }
      if (seenSubtitleIndexes.has(jellyfinIndex)) {
        throw new Error(`subtitleTracks contains duplicate Jellyfin indexes`);
      }
      seenSubtitleIndexes.add(jellyfinIndex);

      const mpvTrack = trackNumber(
        candidate.mpvTrack,
        `subtitleTracks[${position}].mpvTrack`,
      );
      const externalUrl =
        candidate.externalUrl == null || candidate.externalUrl === ""
          ? null
          : validateMediaUrl(candidate.externalUrl, serverUrl);
      if ((externalUrl && mpvTrack !== 0) || (!externalUrl && mpvTrack === 0)) {
        throw new Error(
          `subtitleTracks[${position}] must describe either an embedded or external track`,
        );
      }
      if (
        typeof candidate.title !== "string" ||
        typeof candidate.language !== "string"
      ) {
        throw new Error(
          `subtitleTracks[${position}] title and language must be strings`,
        );
      }
      return {
        jellyfinIndex,
        mpvTrack,
        externalUrl,
        title: candidate.title.slice(0, 256),
        language: candidate.language.slice(0, 64),
      };
    });

  return {
    url: validateMediaUrl(value.url, serverUrl),
    startSeconds: numberInRange(value.startSeconds ?? 0, "startSeconds", 0, 315360000),
    title: title.slice(0, 512),
    fullscreen,
    audioTrack: trackNumber(value.audioTrack ?? 0, "audioTrack"),
    externalAudioUrl: optionalUrl("externalAudioUrl"),
    subtitleStreamIndex: streamIndex(
      value.subtitleStreamIndex ?? -1,
      "subtitleStreamIndex",
    ),
    subtitleTracks,
  };
}

function connectOnce(ipcPath: string, timeoutMs = 250): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(ipcPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out connecting to MPV IPC"));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

export class MpvController {
  readonly serverUrl: string;
  readonly executable: string;
  readonly provider: MpvProvider;
  readonly presentation: MpvPresentation;
  readonly profile: string | undefined;
  readonly integrationScript: string | null;
  readonly eventSink: MpvEventSink;
  readonly trickplay: TrickplayStore;
  child: ChildProcess | null = null;
  socket: net.Socket | null = null;
  buffer = "";
  nextRequestId = 1;
  pending = new Map<number, PendingCommand>();
  starting: Promise<void> | null = null;
  closing = false;
  current = false;
  replacing = false;
  pendingLoad: MpvLoadRequest | null = null;
  pendingSegments: MpvSegment[] = [];
  pendingNavigation: MpvNavigationState = { ...EMPTY_NAVIGATION };
  fileLoaded = false;
  lastProcessError: Error | null = null;
  ipcPath: string | null = null;
  legacyLoadfileArguments = false;
  subtitleMpvToJellyfin = new Map<number, number>();
  subtitleJellyfinToMpv = new Map<number, number>();

  constructor({
    serverUrl,
    executable = "mpv",
    provider,
    presentation = "jellyfin",
    profile,
    integrationScript = DEFAULT_INTEGRATION_SCRIPT,
    eventSink = () => {},
  }: MpvControllerOptions) {
    this.serverUrl = serverUrl;
    this.executable = executable;
    this.provider =
      provider && isMpvProvider(provider)
        ? provider
        : detectMpvProvider(executable) === "mpv.net"
          ? "mpv.net"
          : "mpv";
    this.presentation = normalizeMpvPresentation(presentation);
    this.profile = normalizeMpvProfile(profile);
    this.integrationScript = integrationScript;
    this.eventSink = eventSink;
    this.trickplay = new TrickplayStore((command) => this.command(command));
  }

  get ready(): boolean {
    return Boolean(this.child && this.socket && this.child.exitCode == null);
  }

  status(): MpvStatus {
    return {
      backend: "mpv",
      provider: this.provider,
      available: true,
      ready: this.ready,
      executable: this.executable,
      presentation: this.presentation,
      reason: this.lastProcessError ? this.lastProcessError.message : "",
    };
  }

  emit(event: MpvEventName, payload: MpvEventPayload = {}): void {
    try {
      this.eventSink(event, payload);
    } catch (error: unknown) {
      console.warn(`[Noktus] MPV event sink failed for ${event}:`, error);
    }
  }

  async ensureStarted(): Promise<void> {
    if (this.ready) return;
    if (this.closing) throw new Error("MPV controller is closing");
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  async start(): Promise<void> {
    this.teardownConnection();
    this.lastProcessError = null;
    this.ipcPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\jellyfin-dc-electron-${process.pid}-${crypto.randomUUID()}`
        : path.join(
            os.tmpdir(),
            `jellyfin-dc-electron-${process.pid}-${crypto.randomUUID()}.sock`,
          );

    if (this.integrationScript && !fs.existsSync(this.integrationScript)) {
      throw new Error(`MPV integration script is missing: ${this.integrationScript}`);
    }
    if (this.presentation === "jellyfin" && this.integrationScript) {
      for (const name of ["thumbfast.lua", "trickplay-osc.lua"]) {
        const scriptPath = path.join(path.dirname(this.integrationScript), name);
        if (!fs.existsSync(scriptPath)) {
          throw new Error(`MPV trickplay script is missing: ${scriptPath}`);
        }
      }
    }
    const args = buildMpvArguments(
      this.ipcPath,
      this.presentation,
      this.integrationScript,
      this.provider,
      this.profile,
    );
    const child = spawn(this.executable, args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    this.child = child;
    child.once("error", (error) => this.onProcessError(child, error));
    child.once("exit", (code, signal) => this.onProcessExit(child, code, signal));

    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastConnectionError: unknown = null;
    while (Date.now() < deadline && child.exitCode == null && !this.lastProcessError) {
      try {
        this.socket = await connectOnce(this.ipcPath);
        break;
      } catch (error: unknown) {
        lastConnectionError = error;
        await delay(50);
      }
    }

    if (!this.socket) {
      this.terminateProcess();
      const earlyExit =
        child.exitCode == null
          ? null
          : new Error(
              `${this.provider === "mpv.net" ? "mpv.net" : "MPV"} exited before its IPC endpoint was ready (code ${child.exitCode})`,
            );
      const reason =
        this.lastProcessError ||
        lastConnectionError ||
        earlyExit ||
        new Error("MPV did not start");
      const profileDetail = this.profile ? ` with profile "${this.profile}"` : "";
      throw new Error(`Could not start MPV${profileDetail}: ${errorMessage(reason)}`);
    }

    this.attachSocket(this.socket);
    const properties = [
      "time-pos",
      "duration",
      "pause",
      "volume",
      "mute",
      "speed",
      "fullscreen",
      "aid",
      "sid",
    ];
    await Promise.all(
      properties.map((name, index) =>
        this.command(["observe_property", index + 1, name]),
      ),
    );
    this.emit("ready", { ready: true });
  }

  attachSocket(socket: net.Socket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onSocketData(chunk));
    socket.on("error", (error) => {
      if (!this.closing) {
        this.onSocketFailure(socket, new Error(`MPV IPC failed: ${error.message}`));
      }
    });
    socket.on("close", () => {
      if (this.socket === socket && !this.closing) {
        this.onSocketFailure(socket, new Error("MPV IPC closed"));
      }
    });
  }

  onSocketFailure(socket: net.Socket, error: Error): void {
    if (this.socket !== socket) return;
    this.lastProcessError = error;
    this.socket = null;
    socket.destroy();
    this.failPending(error);
    this.terminateProcess();
    this.removeSocketFile();
  }

  onSocketData(chunk: string | Buffer): void {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          this.onMessage(JSON.parse(line));
        } catch (error: unknown) {
          console.warn("[Noktus] Ignoring malformed MPV IPC message:", error);
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  onMessage(rawMessage: unknown): void {
    if (!isRecord(rawMessage)) return;
    const message = rawMessage;
    if (
      typeof message.request_id === "number" &&
      Number.isInteger(message.request_id)
    ) {
      const pending = this.pending.get(message.request_id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.request_id);
        if (message.error && message.error !== "success") {
          pending.reject(
            new Error(`MPV ${pending.commandName} command failed: ${message.error}`),
          );
        } else {
          pending.resolve(message.data);
        }
      }
    }

    if (typeof message.event !== "string") return;
    if (message.event === "client-message") {
      const args = Array.isArray(message.args) ? message.args : [];
      const namespace = args[0];
      const action = args[1];
      if (namespace === "shim-trickplay-need") {
        const seconds = Number(action);
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 315360000) {
          this.emit("trickplayNeed", { seconds });
        }
        return;
      }
      let navigationAction: "next" | "previous" | null = null;
      if (action === "next") navigationAction = "next";
      if (action === "previous") navigationAction = "previous";
      if (
        namespace === "jellyfin-dc-control" &&
        navigationAction &&
        this.pendingNavigation[navigationAction]
      ) {
        this.emit(navigationAction);
      }
      return;
    }
    if (message.event === "file-loaded") {
      this.replacing = false;
      void this.applySelectedTracks();
      return;
    }
    if (message.event === "end-file") {
      if (message.reason === "stop" && this.replacing) return;
      const wasCurrent = this.current;
      this.current = false;
      this.replacing = false;
      this.fileLoaded = false;
      this.pendingSegments = [];
      this.pendingNavigation = { ...EMPTY_NAVIGATION };
      this.pendingLoad = null;
      void this.trickplay.clear(this.ready);
      this.resetSubtitleTrackMap();
      if (!wasCurrent) return;
      if (message.reason === "error") {
        this.emit("failed", {
          code: "media",
          message: String(message.file_error || "MPV could not load the media"),
        });
      } else if (message.reason === "eof") {
        this.emit("ended");
      } else if (message.reason === "quit") {
        this.emit("quit");
      }
      return;
    }
    if (message.event === "property-change" && message.data != null) {
      if (message.name === "sid") {
        const mpvTrack = Number(message.data);
        const jellyfinIndex =
          message.data === false || message.data === "no"
            ? -1
            : Number.isInteger(mpvTrack)
              ? (this.subtitleMpvToJellyfin.get(mpvTrack) ?? null)
              : null;
        this.emit("subtitleTrack", {
          value: message.data,
          jellyfinIndex,
        });
        return;
      }
      const names: Record<string, MpvEventName> = {
        "time-pos": "position",
        duration: "duration",
        pause: "paused",
        volume: "volume",
        mute: "muted",
        speed: "rate",
        fullscreen: "fullscreen",
        aid: "audioTrack",
      };
      const event = typeof message.name === "string" ? names[message.name] : null;
      if (event) this.emit(event, { value: message.data });
    }
  }

  resetSubtitleTrackMap(): void {
    this.subtitleMpvToJellyfin.clear();
    this.subtitleJellyfinToMpv.clear();
  }

  async subtitleTrackIds(): Promise<Set<number>> {
    const value = await this.command(["get_property", "track-list"]);
    if (!Array.isArray(value)) {
      throw new Error("MPV did not return a track list");
    }
    return new Set(
      value.flatMap((track): number[] => {
        if (
          !isRecord(track) ||
          track.type !== "sub" ||
          typeof track.id !== "number" ||
          !Number.isInteger(track.id) ||
          track.id <= 0
        ) {
          return [];
        }
        return [track.id];
      }),
    );
  }

  async applySelectedTracks(): Promise<void> {
    const request = this.pendingLoad;
    if (!request || !this.ready) return;
    try {
      if (request.externalAudioUrl) {
        await this.command(["audio-add", request.externalAudioUrl, "select"]);
      } else {
        await this.command(["set_property", "aid", request.audioTrack]);
      }

      this.resetSubtitleTrackMap();
      for (const track of request.subtitleTracks) {
        if (track.externalUrl) continue;
        this.subtitleJellyfinToMpv.set(track.jellyfinIndex, track.mpvTrack);
        this.subtitleMpvToJellyfin.set(track.mpvTrack, track.jellyfinIndex);
      }

      let knownSubtitleIds = await this.subtitleTrackIds();
      for (const track of request.subtitleTracks) {
        if (!track.externalUrl) continue;
        try {
          await this.command([
            "sub-add",
            track.externalUrl,
            "auto",
            track.title,
            track.language,
          ]);
          if (this.pendingLoad !== request || !this.current) return;
          const updatedSubtitleIds = await this.subtitleTrackIds();
          const addedIds = [...updatedSubtitleIds].filter(
            (id) => !knownSubtitleIds.has(id),
          );
          knownSubtitleIds = updatedSubtitleIds;
          if (addedIds.length !== 1) {
            console.warn("[Noktus] Could not identify an external MPV subtitle track.");
            continue;
          }
          const mpvTrack = addedIds[0];
          if (mpvTrack == null) continue;
          this.subtitleJellyfinToMpv.set(track.jellyfinIndex, mpvTrack);
          this.subtitleMpvToJellyfin.set(mpvTrack, track.jellyfinIndex);
        } catch (error: unknown) {
          console.warn(
            "[Noktus] Could not load an external subtitle:",
            errorMessage(error),
          );
        }
      }

      const selectedSubtitleTrack =
        request.subtitleStreamIndex < 0
          ? null
          : this.subtitleJellyfinToMpv.get(request.subtitleStreamIndex);
      await this.command([
        "set_property",
        "sid",
        selectedSubtitleTrack == null ? "no" : selectedSubtitleTrack,
      ]);
      this.fileLoaded = true;
      await this.sendNavigation();
      await this.sendSegments();
      this.emit("loaded");
      if (this.presentation === "jellyfin") {
        const message = request.title ? `Jellyfin\n${request.title}` : "Jellyfin";
        this.command(["show-text", message, 2200]).catch((error: unknown) => {
          console.warn(
            "[Noktus] Could not show MPV playback title:",
            errorMessage(error),
          );
        });
      }
    } catch (error: unknown) {
      this.emit("failed", { code: "tracks", message: errorMessage(error) });
    }
  }

  async setSegments(value: unknown): Promise<true> {
    const segments = normalizeSegments(value);
    this.pendingSegments = segments;
    if (!this.current || !this.ready || !this.fileLoaded) return true;
    await this.sendSegments();
    return true;
  }

  async sendSegments(): Promise<void> {
    await this.command([
      "script-message",
      "jellyfin-dc-segments",
      JSON.stringify(this.pendingSegments),
    ]);
  }

  async setNavigation(value: unknown): Promise<true> {
    this.pendingNavigation = normalizeNavigation(value);
    if (!this.current || !this.ready || !this.fileLoaded) return true;
    await this.sendNavigation();
    return true;
  }

  async sendNavigation(): Promise<void> {
    await this.command([
      "script-message",
      "jellyfin-dc-navigation",
      JSON.stringify(this.pendingNavigation),
    ]);
  }

  async showText(message: string, duration = 1800): Promise<true> {
    const text = String(message).slice(0, 512);
    const milliseconds = numberInRange(duration, "duration", 100, 10000);
    await this.command(["show-text", text, milliseconds]);
    return true;
  }

  command(command: MpvCommand): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error("MPV is not ready"));
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("MPV command timed out"));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        commandName: String(command[0] || "unknown"),
      });
      socket.write(
        `${JSON.stringify({ command, request_id: requestId })}\n`,
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(requestId);
          this.onSocketFailure(socket, error);
          reject(error);
        },
      );
    });
  }

  async loadRequest(request: MpvLoadRequest): Promise<true> {
    await this.ensureStarted();
    await this.trickplay.clear();
    await this.command(["set_property", "fullscreen", request.fullscreen]);
    await this.command(["set_property", "pause", false]);
    await this.command(["set_property", "force-media-title", request.title]);
    this.pendingLoad = request;
    this.pendingSegments = [];
    this.pendingNavigation = { ...EMPTY_NAVIGATION };
    this.fileLoaded = false;
    this.resetSubtitleTrackMap();
    this.current = true;
    this.replacing = true;
    try {
      const perFileOptions = `start=${request.startSeconds.toFixed(3)}`;
      if (this.legacyLoadfileArguments) {
        await this.command(["loadfile", request.url, "replace", perFileOptions]);
      } else {
        try {
          await this.command(["loadfile", request.url, "replace", -1, perFileOptions]);
        } catch (error: unknown) {
          if (!isInvalidParameterError(error)) throw error;
          await this.command(["loadfile", request.url, "replace", perFileOptions]);
          this.legacyLoadfileArguments = true;
        }
      }
    } catch (error: unknown) {
      this.pendingLoad = null;
      this.current = false;
      this.replacing = false;
      throw error;
    }
    return true;
  }

  async load(value: unknown): Promise<true> {
    const request = normalizeLoadRequest(value, this.serverUrl);
    try {
      return await this.loadRequest(request);
    } catch (error: unknown) {
      if (this.closing || !canRetryLoad(error)) throw error;
      console.warn(
        "[Noktus] MPV connection was lost while loading; restarting it once.",
      );
      this.teardownConnection();
      return this.loadRequest(request);
    }
  }

  async execute(name: string, value?: unknown): Promise<true> {
    if (name === "stop" && !this.ready) {
      await this.trickplay.clear(false);
      this.current = false;
      this.replacing = false;
      this.fileLoaded = false;
      this.pendingSegments = [];
      this.pendingNavigation = { ...EMPTY_NAVIGATION };
      this.pendingLoad = null;
      this.resetSubtitleTrackMap();
      return true;
    }
    await this.ensureStarted();
    if (name === "subtitleTrack") {
      const index = streamIndex(value, "subtitleStreamIndex");
      if (this.pendingLoad) this.pendingLoad.subtitleStreamIndex = index;
      if (!this.current || !this.fileLoaded) return true;
      const track = index < 0 ? null : (this.subtitleJellyfinToMpv.get(index) ?? null);
      if (index >= 0 && track == null) {
        throw new Error("The selected Jellyfin subtitle is unavailable in MPV");
      }
      await this.command([
        "osd-auto",
        "set",
        "sid",
        track == null ? "no" : String(track),
      ]);
      return true;
    }
    const commands: Record<string, () => MpvCommand> = {
      play: () => ["osd-auto", "set", "pause", "no"],
      pause: () => ["osd-auto", "set", "pause", "yes"],
      stop: () => ["stop"],
      seek: () => [
        "osd-auto",
        "seek",
        String(numberInRange(value, "position", 0, 315360000)),
        "absolute",
      ],
      volume: () => [
        "osd-auto",
        "set",
        "volume",
        String(numberInRange(value, "volume", 0, 100)),
      ],
      rate: () => [
        "osd-auto",
        "set",
        "speed",
        String(numberInRange(value, "rate", 0.25, 4)),
      ],
      audioTrack: () => {
        const track = trackNumber(value, "audioTrack");
        return ["osd-auto", "set", "aid", track === 0 ? "no" : String(track)];
      },
    };
    if (name === "muted" || name === "fullscreen") {
      if (typeof value !== "boolean") {
        throw new Error(`${name} must be a boolean`);
      }
      if (name === "muted") {
        await this.command(["osd-auto", "set", "mute", value ? "yes" : "no"]);
      } else {
        await this.command(["set_property", "fullscreen", value]);
      }
      return true;
    }
    const makeCommand = commands[name];
    if (!makeCommand) throw new Error(`Unsupported MPV command: ${name}`);
    if (name === "stop") {
      await this.trickplay.clear();
      this.current = false;
      this.replacing = false;
      this.fileLoaded = false;
      this.pendingSegments = [];
      this.pendingNavigation = { ...EMPTY_NAVIGATION };
      this.pendingLoad = null;
      this.resetSubtitleTrackMap();
    }
    await this.command(makeCommand());
    return true;
  }

  beginTrickplay(value: unknown): Promise<string | null> {
    if (this.presentation !== "jellyfin" || !this.current) {
      return Promise.resolve(null);
    }
    return this.trickplay.begin(value);
  }

  appendTrickplay(id: unknown, chunk: unknown): Promise<true> {
    return this.trickplay.append(id, chunk);
  }

  commitTrickplay(id: unknown): Promise<true> {
    return this.trickplay.commit(id);
  }

  abortTrickplay(id: unknown): Promise<true> {
    return this.trickplay.abort(id);
  }

  clearTrickplay(): Promise<true> {
    return this.trickplay.clear(this.ready);
  }

  onProcessError(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    this.lastProcessError = error;
    this.failPending(error);
  }

  onProcessExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    const wasCurrent = this.current;
    const wasClosing = this.closing;
    this.child = null;
    this.current = false;
    this.replacing = false;
    this.fileLoaded = false;
    this.pendingSegments = [];
    this.pendingNavigation = { ...EMPTY_NAVIGATION };
    this.pendingLoad = null;
    void this.trickplay.clear(false);
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.failPending(new Error(`MPV exited (${signal ?? code ?? "unknown"})`));
    this.removeSocketFile();
    this.emit("ready", { ready: false });
    if (wasCurrent && !wasClosing) {
      if (code === 0 && signal == null) {
        this.emit("quit");
      } else {
        this.emit("failed", {
          code: "process",
          message: `MPV exited unexpectedly (${signal ?? code ?? "unknown"})`,
        });
      }
    }
  }

  failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  teardownConnection(): void {
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.buffer = "";
    this.failPending(new Error("MPV connection was replaced"));
    this.terminateProcess();
    void this.trickplay.clear(false);
    this.removeSocketFile();
  }

  terminateProcess(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode == null) child.kill();
  }

  removeSocketFile(): void {
    if (process.platform !== "win32" && this.ipcPath) {
      try {
        fs.unlinkSync(this.ipcPath);
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") {
          console.warn("[Noktus] Could not remove MPV socket:", error);
        }
      }
    }
    this.ipcPath = null;
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.current = false;
    this.replacing = false;
    this.pendingLoad = null;
    this.pendingSegments = [];
    this.pendingNavigation = { ...EMPTY_NAVIGATION };
    this.fileLoaded = false;
    void this.trickplay.clear(false);
    this.teardownConnection();
    this.emit("ready", { ready: false });
  }
}
