import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopBridge,
  MpvEventName,
  MpvEventPayload,
  PlaybackMode,
} from "../shared/types";

interface InstallPlayerConfig {
  serverUrl: string;
  backend: PlaybackMode;
  appName: string;
  appVersion: string;
  deviceName: string;
}

type InstallPlayer = (config: InstallPlayerConfig) => unknown;
type MpvEventCallback = (payload: MpvEventPayload) => void;

// We need to keep the installPlayer in JavaScript since Electron serializes
// the function body and executes it in Jellyfin's page context
const installPlayer = require("./install-player") as InstallPlayer;

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function playbackMode(value: string | null): PlaybackMode {
  return value === "mpv" ? "mpv" : "web";
}

function errorDetails(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

const serverUrl = decodeURIComponent(argument("jdc-server-url") || "");
const mode = playbackMode(argument("jdc-mode"));
const appVersion = decodeURIComponent(argument("jdc-app-version") || "0.0.0");
const eventNames = new Set<MpvEventName>([
  "ready",
  "loaded",
  "paused",
  "position",
  "duration",
  "volume",
  "muted",
  "rate",
  "fullscreen",
  "audioTrack",
  "subtitleTrack",
  "next",
  "previous",
  "ended",
  "quit",
  "failed",
  "shutdown",
  "mode",
]);
const eventCallbacks = new Map<MpvEventName, Set<MpvEventCallback>>();
const presenceSyncCallbacks = new Set<() => void>();

ipcRenderer.on("jdc:mpv:event", (_event, eventName: unknown, payload: unknown) => {
  if (typeof eventName !== "string" || !eventNames.has(eventName as MpvEventName)) {
    return;
  }
  const callbacks = eventCallbacks.get(eventName as MpvEventName);
  if (!callbacks) return;
  const safePayload =
    payload && typeof payload === "object" ? (payload as MpvEventPayload) : {};
  for (const callback of callbacks) callback(safePayload);
});
ipcRenderer.on("jdc:presence:sync", () => {
  for (const callback of presenceSyncCallbacks) callback();
});

const desktopBridge: DesktopBridge = {
  status: () => ipcRenderer.invoke("jdc:mpv:status"),
  load: (request) => ipcRenderer.invoke("jdc:mpv:load", request),
  play: () => ipcRenderer.invoke("jdc:mpv:play"),
  pause: () => ipcRenderer.invoke("jdc:mpv:pause"),
  stop: () => ipcRenderer.invoke("jdc:mpv:stop"),
  seek: (seconds) => ipcRenderer.invoke("jdc:mpv:seek", seconds),
  setVolume: (volume) => ipcRenderer.invoke("jdc:mpv:setVolume", volume),
  setMuted: (muted) => ipcRenderer.invoke("jdc:mpv:setMuted", muted),
  setRate: (rate) => ipcRenderer.invoke("jdc:mpv:setRate", rate),
  setAudioTrack: (track) => ipcRenderer.invoke("jdc:mpv:setAudioTrack", track),
  setSubtitleTrack: (streamIndex) =>
    ipcRenderer.invoke("jdc:mpv:setSubtitleTrack", streamIndex),
  setSegments: (segments) => ipcRenderer.invoke("jdc:mpv:setSegments", segments),
  setNavigation: (navigation) =>
    ipcRenderer.invoke("jdc:mpv:setNavigation", navigation),
  setFullscreen: (fullscreen) =>
    ipcRenderer.invoke("jdc:mpv:setFullscreen", fullscreen),
  resolveSeriesTracks: (context) =>
    ipcRenderer.invoke("jdc:series-tracks:resolve", context),
  rememberSeriesTracks: (context) =>
    ipcRenderer.invoke("jdc:series-tracks:remember", context),
  clearSeriesTrackContext: () => ipcRenderer.invoke("jdc:series-tracks:clear"),
  shutdownReady: (requestId) =>
    ipcRenderer.invoke("jdc:playback-shutdown-ready", requestId),
  focusApp: () => ipcRenderer.invoke("jdc:focus-app"),
  playHere: (url) => ipcRenderer.invoke("jdc:play-here", url),
  openExternal: (url) => ipcRenderer.invoke("jdc:open-external", url),
  updatePresence: (activity) => ipcRenderer.invoke("jdc:presence:update", activity),
  clearPresence: () => ipcRenderer.invoke("jdc:presence:clear"),
  onPresenceSync: (callback) => {
    if (typeof callback === "function") presenceSyncCallbacks.add(callback);
  },
  on: (name, callback) => {
    if (!eventNames.has(name) || typeof callback !== "function") return;
    let callbacks = eventCallbacks.get(name);
    if (!callbacks) {
      callbacks = new Set<MpvEventCallback>();
      eventCallbacks.set(name, callbacks);
    }
    callbacks.add(callback);
  },
};

contextBridge.exposeInMainWorld("jellyfinDesktop", desktopBridge);

try {
  const result = contextBridge.executeInMainWorld({
    func: installPlayer,
    args: [
      {
        serverUrl,
        backend: mode,
        appName: "Noktus",
        appVersion,
        deviceName: "Electron",
      },
    ],
  });
  ipcRenderer.send("jdc:injection-status", result);
} catch (error: unknown) {
  ipcRenderer.send("jdc:preload-error", errorDetails(error));
}
