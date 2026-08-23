import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  screen,
  shell,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type RenderProcessGoneDetails,
} from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  COMPATIBILITY,
  supportsJellyfinWebVersion,
  supportsRuntimeTarget,
} from "../shared/compatibility";
import { createDiagnosticsReport, type NoktusDiagnostics } from "./diagnostics";
import { shouldGrantFullscreenPermission } from "./fullscreen-permission";
import { PresenceCoordinator } from "./presence/coordinator";
import { DiscordIpcProvider } from "./presence/discord-ipc";
import { normalizePresenceActivity } from "./presence/types";
import { installFileLogging } from "./logging";
import { MpvController, normalizeMpvPresentation } from "./playback/mpv-controller";
import { inspectMpvExecutable } from "./playback/mpv-diagnostics";
import { discoverMpvProfiles } from "./playback/mpv-profiles";
import {
  resolveMpvExecutable,
  resolveMpvExecutableAlias,
  type MpvExecutableResolution,
} from "./playback/mpv-resolution";
import {
  PlaybackShutdownCoordinator,
  type PlaybackShutdownReason,
} from "./playback/playback-shutdown";
import { validateJellyfinServer, type JellyfinServerHealth } from "./server-health";
import { clearServerLoginData, profilesSharingOrigin } from "./server-login-data";
import {
  loadWindowState,
  resolveWindowState,
  saveWindowState,
  WINDOW_STATE_VERSION,
  type WindowBounds,
  type WindowState,
} from "./window-state";
import {
  resolveAppIconPath,
  resolveMpvIntegrationScript,
  resolvePreloadPath,
  resolveSettingsPagePath,
  resolveSettingsPreloadPath,
  resolveServersPagePath,
  resolveServersPreloadPath,
} from "./runtime-paths";
import {
  mainRecoveryMessage,
  rendererRecoveryAction,
  rendererRecoveryPrompt,
  shouldRecoverMainFrameLoadFailure,
  type MainRecoveryReason,
  type RendererFailureKind,
} from "./runtime-recovery";
import { PRODUCT_IDENTITY } from "../shared/product";
import { normalizeMpvProfile } from "../shared/mpv-profile";
import {
  findSeriesTrackRule,
  normalizeSeriesTrackContextInput,
  removeSeriesTrackRule,
  resolveSeriesTracks,
  saveSeriesTrackRule,
} from "../shared/series-track-rules";
import {
  activeServer,
  loadSettings,
  normalizeSettings,
  removeServer,
  saveSettings,
  updateServerDisplayName,
  upsertServer,
} from "../shared/settings";
import {
  isWithinServer,
  normalizeServerUrl,
  safeJellyfinPageUrl,
} from "../shared/url-policy";
import type {
  AppSettings,
  MpvDiagnostic,
  MpvEventName,
  MpvEventPayload,
  MpvPresentation,
  PlaybackMode,
  SaveServerRequest,
  SeriesTrackContext,
  ServerConnectionStatus,
  ServerManagerSnapshot,
  ServerProfile,
  SettingsSnapshot,
} from "../shared/types";

const APP_NAME = PRODUCT_IDENTITY.name;
const LOG_PREFIX = `[${APP_NAME}]`;
// Discord application IDs are public. The override is useful for local testing only.
const DISCORD_APPLICATION_ID =
  process.env.NOKTUS_DISCORD_APPLICATION_ID || "1540440229956296835";
const DISCORD_LARGE_IMAGE_KEY = "noktus";
const MAIN_WINDOW_DEFAULT_WIDTH = 1280;
const MAIN_WINDOW_DEFAULT_HEIGHT = 800;
const MAIN_WINDOW_MIN_WIDTH = 640;
const MAIN_WINDOW_MIN_HEIGHT = 480;
const WINDOW_STATE_SAVE_DELAY_MS = 250;
const RESUME_RECOVERY_DELAY_MS = 1_500;
const UNRESPONSIVE_RECOVERY_DELAY_MS = 2_500;
const SETTINGS_EXTERNAL_URLS = new Set([
  "https://mpv.io/installation/",
  "https://github.com/mpvnet-player/mpv.net/releases",
]);
const smokeSwitch = process.argv.includes("--smoke-switch");
const smokeSettings = process.argv.includes("--smoke-settings");
const smokeServers = process.argv.includes("--smoke-servers");
const smokeServerFailure = process.argv.includes("--smoke-server-failure");
const smokeRuntimeRecovery = process.argv.includes("--smoke-runtime-recovery");
const smokeDiagnostics = process.argv.includes("--smoke-diagnostics");
const smokePackaged = process.argv.includes("--smoke-packaged");
const smokeUserDataArgument = process.argv.find((argument) =>
  argument.startsWith("--smoke-user-data="),
);
app.setName(PRODUCT_IDENTITY.name);
if (process.platform === "win32") {
  app.setAppUserModelId(PRODUCT_IDENTITY.appId);
}
if (smokeUserDataArgument) {
  const smokeUserDataPath = decodeURIComponent(
    smokeUserDataArgument.slice("--smoke-user-data=".length),
  );
  if (!path.isAbsolute(smokeUserDataPath)) {
    throw new Error("Packaged smoke user-data path must be absolute");
  }
  app.setPath("userData", smokeUserDataPath);
}
const isPrimaryInstance = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let serversWindow: BrowserWindow | null = null;
let mpvController: MpvController | null = null;
let mpvControllerStale = false;
let quitting = false;
let switchPromise: Promise<void> | null = null;
let currentMode: PlaybackMode = "web";
let serverUrl: string | null = null;
let startupError: Error | null = null;
let connectionError: string | null = null;
let mpvExecutable = "mpv";
let mpvExecutableResolution: MpvExecutableResolution = {
  executable: "mpv",
  provider: "mpv",
  source: "unresolved",
  ignoredConfiguredPath: null,
};
let mpvDiagnosticCache: Promise<MpvDiagnostic> | null = null;
let mpvIntegrationScript: string | null = null;
let appIconPath: string | null = null;
let mpvPresentation: MpvPresentation = "jellyfin";
let mpvProfile: string | undefined;
let startMpvFullscreen = true;
let preloadPath: string | null = null;
let settingsPagePath: string | null = null;
let settingsPreloadPath: string | null = null;
let serversPagePath: string | null = null;
let serversPreloadPath: string | null = null;
let settingsPath: string | null = null;
let windowStatePath: string | null = null;
let logDirectory: string | null = null;
let logFilePath: string | null = null;
let persistedSettings: AppSettings = normalizeSettings();
const presence = new PresenceCoordinator(
  new DiscordIpcProvider({
    applicationId: DISCORD_APPLICATION_ID,
    largeImageKey: DISCORD_LARGE_IMAGE_KEY,
  }),
);
let persistedWindowState: WindowState | null = null;
let activeSeriesTrackContext: SeriesTrackContext | null = null;
let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
let resumeRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let serverStatusMessage: string | null = null;
let mainRecoveryState: MainRecoveryState | null = null;
let fatalMainErrorInProgress = false;
const serverConnectionStates = new Map<string, ServerConnectionStatus>();
const playbackShutdown = new PlaybackShutdownCoordinator();
const mainWindowsPendingClose = new WeakSet<BrowserWindow>();
const mainWindowsAllowedToClose = new WeakSet<BrowserWindow>();
const expectedRendererStops = new WeakSet<BrowserWindow>();
const rendererRecoveryDialogs = new WeakSet<BrowserWindow>();
const unresponsiveRecoveryTimers = new WeakMap<
  BrowserWindow,
  ReturnType<typeof setTimeout>
>();

if (!isPrimaryInstance) {
  app.quit();
} else {
  process.on("uncaughtException", handleFatalMainError);
  process.on("unhandledRejection", handleFatalMainError);
}

interface PersistRuntimeOptions {
  includeMode?: boolean;
  includeFullscreen?: boolean;
  includePresentation?: boolean;
}

interface CreateWindowOptions {
  mode?: PlaybackMode;
  targetUrl?: string;
  showWhenReady?: boolean;
  bounds?: WindowBounds | null;
}

interface CreatedWindow {
  window: BrowserWindow;
  ready: Promise<void>;
}

interface MainRecoveryState {
  reason: MainRecoveryReason;
  windowState: WindowState | null;
}

interface SettingsSmokeReport {
  title: string;
  hasForm: boolean;
  hasDiscordPresence: boolean;
  hasDiscordPresenceStatus: boolean;
  hasMpvInstallLinks: boolean;
  hasMpvPath: boolean;
  hasMpvTest: boolean;
  hasMpvDiagnostic: boolean;
  hasMpvTestBridge: boolean;
  hasMpvProfile: boolean;
  hasMpvProfileBridge: boolean;
  hasDiagnosticResult: boolean;
  hasSupportedResult: boolean;
  hasBridge: boolean;
  playbackMode: unknown;
}

interface ServerFailureSmokeReport {
  hasBridge: boolean;
  connectionError?: string;
}

interface ServersSmokeReport {
  title: string;
  hasForm: boolean;
  hasServerName: boolean;
  hasServerUrl: boolean;
  hasBridge: boolean;
  hasForgetLoginBridge: boolean;
  hasServerList: boolean;
  hasServerStates: boolean;
}

interface PackagedSmokeReport {
  title: string;
  hasBridge: boolean;
  hasServerManager: boolean;
}

interface SenderEvent {
  senderFrame?: { url: string } | null;
  sender?: { getURL(): string };
}

class ServerSwitchCanceledError extends Error {
  constructor() {
    super("Server switch canceled");
    this.name = "ServerSwitchCanceledError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function handleFatalMainError(error: unknown): void {
  const fatalError = asError(error);
  console.error(`${LOG_PREFIX} Fatal main-process error:`, fatalError);
  if (fatalMainErrorInProgress) {
    app.exit(1);
    return;
  }
  fatalMainErrorInProgress = true;

  void (async () => {
    if (!app.isReady()) {
      app.exit(1);
      return;
    }
    try {
      const result = await dialog.showMessageBox({
        type: "error",
        title: `${APP_NAME} stopped`,
        message: `${APP_NAME} encountered an unrecoverable error.`,
        detail: `${fatalError.message}\n\nRestart Noktus or quit. Details were written to the local log when logging was available.`,
        buttons: [`Restart ${APP_NAME}`, "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      try {
        closeMpvController();
      } catch (closeError: unknown) {
        console.error(
          `${LOG_PREFIX} Could not close MPV after a fatal error:`,
          errorMessage(closeError),
        );
      }
      if (result.response === 0) app.relaunch();
    } catch (dialogError: unknown) {
      console.error(
        `${LOG_PREFIX} Fatal error dialog failed:`,
        errorMessage(dialogError),
      );
    } finally {
      app.exit(1);
    }
  })();
}

function requiredPath(value: string | null, label: string): string {
  if (!value) throw new Error(`${label} has not been initialized`);
  return value;
}

function isPlaybackMode(value: unknown): value is PlaybackMode {
  return value === "web" || value === "mpv";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function focusExistingInstance(): void {
  const candidates = [
    BrowserWindow.getFocusedWindow(),
    serversWindow,
    settingsWindow,
    mainWindow,
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate.isDestroyed()) continue;
    if (candidate.isMinimized()) candidate.restore();
    if (!candidate.isVisible()) continue;
    candidate.show();
    candidate.focus();
    return;
  }

  // A hidden window may still be loading. Its normal ready handler will show it
  // without exposing a blank renderer.
  if (candidates.some((candidate) => candidate && !candidate.isDestroyed())) {
    return;
  }
  if (!app.isReady()) return;
  if (mainRecoveryState || !serverUrl) showServersWindow();
  else openMainWindow();
}

function restorableWindowState(): WindowState | null {
  return resolveWindowState(
    persistedWindowState,
    screen.getAllDisplays().map((display) => display.workArea),
    {
      minWidth: MAIN_WINDOW_MIN_WIDTH,
      minHeight: MAIN_WINDOW_MIN_HEIGHT,
    },
  );
}

function captureWindowState(window: BrowserWindow): WindowState {
  return {
    version: WINDOW_STATE_VERSION,
    bounds: window.getNormalBounds(),
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  };
}

function persistMainWindowState(window: BrowserWindow): void {
  if (mainWindow !== window || window.isDestroyed() || !windowStatePath) return;
  try {
    persistedWindowState = saveWindowState(windowStatePath, captureWindowState(window));
  } catch (error: unknown) {
    console.warn(
      `${LOG_PREFIX} Could not save window state ${windowStatePath}:`,
      errorMessage(error),
    );
  }
}

function scheduleWindowStateSave(window: BrowserWindow): void {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    persistMainWindowState(window);
  }, WINDOW_STATE_SAVE_DELAY_MS);
}

function trackMainWindowState(window: BrowserWindow): void {
  window.on("move", () => scheduleWindowStateSave(window));
  window.on("resize", () => scheduleWindowStateSave(window));
  window.on("maximize", () => scheduleWindowStateSave(window));
  window.on("unmaximize", () => scheduleWindowStateSave(window));
  window.on("enter-full-screen", () => scheduleWindowStateSave(window));
  window.on("leave-full-screen", () => scheduleWindowStateSave(window));
  window.on("close", (event) => {
    if (windowStateSaveTimer) {
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
    }
    persistMainWindowState(window);
    if (
      quitting ||
      mainWindowsAllowedToClose.has(window) ||
      mainWindow !== window ||
      !mpvController
    ) {
      return;
    }
    event.preventDefault();
    if (mainWindowsPendingClose.has(window)) return;
    mainWindowsPendingClose.add(window);
    void closeMainWindowAfterPlayback(window);
  });
}

function restoreMainWindowDisplayState(
  window: BrowserWindow,
  state: WindowState | null,
): void {
  if (!state) return;
  if (state.maximized) window.maximize();
  if (state.fullscreen) window.setFullScreen(true);
}

function commandLineOption(name: string): string | null {
  const exact = `--${name}`;
  const prefix = `${exact}=`;
  for (let index = 0; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument?.startsWith(prefix)) return argument.slice(prefix.length);
    if (argument === exact) return process.argv[index + 1] || "";
  }
  return null;
}

function persistRuntimeSettings({
  includeMode = true,
  includeFullscreen = true,
  includePresentation = true,
}: PersistRuntimeOptions = {}): void {
  if (!settingsPath) return;
  try {
    const nextSettings = { ...persistedSettings };
    if (includeMode) nextSettings.playbackMode = currentMode;
    if (includeFullscreen) nextSettings.startMpvFullscreen = startMpvFullscreen;
    if (includePresentation) nextSettings.mpvPresentation = mpvPresentation;
    persistedSettings = saveSettings(settingsPath, nextSettings);
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Could not save settings ${settingsPath}:`,
      errorMessage(error),
    );
  }
}

function refreshMpvExecutable(): void {
  const resolution = resolveMpvExecutable({
    commandLinePath: commandLineOption("mpv-path"),
    environmentPath: process.env.MPV_PATH,
    configuredPath: persistedSettings.mpvPath,
  });
  mpvExecutableResolution = resolution;
  mpvExecutable = resolution.executable;
  mpvDiagnosticCache = null;
  if (resolution.ignoredConfiguredPath) {
    console.warn(
      `${LOG_PREFIX} Configured MPV executable is unavailable; selected ${resolution.executable}:`,
      resolution.ignoredConfiguredPath,
    );
  }
}

function currentMpvDiagnostic(force = false): Promise<MpvDiagnostic> {
  if (!mpvDiagnosticCache || force) {
    mpvDiagnosticCache = inspectMpvExecutable(
      mpvExecutableResolution.executable,
      mpvExecutableResolution.source,
      {
        configuredPathIgnored: Boolean(mpvExecutableResolution.ignoredConfiguredPath),
      },
    );
  }
  return mpvDiagnosticCache;
}

function testMpvExecutable(candidate: unknown): Promise<MpvDiagnostic> {
  if (typeof candidate !== "string") {
    throw new Error("MPV executable path must be a string");
  }
  const executable = candidate.trim();
  if (!executable) return currentMpvDiagnostic(true);
  return inspectMpvExecutable(resolveMpvExecutableAlias(executable), "settings");
}

function listMpvProfiles(candidate: unknown) {
  if (typeof candidate !== "string") {
    throw new Error("MPV executable path must be a string");
  }
  const executable = candidate.trim()
    ? resolveMpvExecutableAlias(candidate.trim())
    : mpvExecutableResolution.executable;
  return discoverMpvProfiles(executable);
}

function initializeRuntime(): void {
  const userDataPath = app.getPath("userData");
  logDirectory = path.join(userDataPath, "logs");
  try {
    const logging = installFileLogging(logDirectory);
    logFilePath = logging.filePath;
  } catch (error: unknown) {
    console.warn(
      `${LOG_PREFIX} Could not initialize local logging:`,
      errorMessage(error),
    );
  }
  console.log(
    `${LOG_PREFIX} Starting ${app.getVersion()} on ${process.platform} ${process.arch} (Electron ${process.versions.electron})`,
  );
  settingsPath = path.join(userDataPath, "settings.json");
  windowStatePath = path.join(userDataPath, "window-state.json");
  persistedSettings = loadSettings(settingsPath);
  presence.setEnabled(persistedSettings.discordRichPresenceEnabled);
  persistedWindowState = loadWindowState(windowStatePath);
  const rawServerUrl =
    commandLineOption("server-url") ||
    process.env.JELLYFIN_DC_SERVER_URL ||
    activeServer(persistedSettings)?.url;
  const modeOverride = commandLineOption("mode") || process.env.JELLYFIN_DC_MODE;
  const requestedMode = modeOverride || persistedSettings.playbackMode;
  const requestedMpvFullscreen = commandLineOption("mpv-fullscreen");
  const presentationOverride =
    commandLineOption("mpv-ui") || process.env.JELLYFIN_DC_MPV_UI;
  const requestedMpvPresentation =
    presentationOverride || persistedSettings.mpvPresentation;

  preloadPath = resolvePreloadPath(app.getAppPath());
  settingsPagePath = resolveSettingsPagePath(app.getAppPath());
  settingsPreloadPath = resolveSettingsPreloadPath(app.getAppPath());
  serversPagePath = resolveServersPagePath(app.getAppPath());
  serversPreloadPath = resolveServersPreloadPath(app.getAppPath());
  mpvIntegrationScript = resolveMpvIntegrationScript({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  appIconPath = resolveAppIconPath({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  refreshMpvExecutable();

  try {
    serverUrl = rawServerUrl ? normalizeServerUrl(rawServerUrl) : null;
    if (!isPlaybackMode(requestedMode)) {
      throw new Error("--mode must be either web or mpv");
    }
    currentMode = requestedMode;
    mpvPresentation = normalizeMpvPresentation(requestedMpvPresentation);
    mpvProfile = persistedSettings.mpvProfile;
    startMpvFullscreen =
      requestedMpvFullscreen == null
        ? persistedSettings.startMpvFullscreen !== false
        : !["0", "false", "no", "off"].includes(requestedMpvFullscreen.toLowerCase());
  } catch (error: unknown) {
    startupError = asError(error);
  }
}

async function checkJellyfinServer(candidate: string): Promise<JellyfinServerHealth> {
  return validateJellyfinServer(candidate, {
    fetchImpl: (input, init) => session.defaultSession.fetch(input, init),
  });
}

function assertTrustedSender(event: SenderEvent): void {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL() || "";
  if (!isWithinServer(senderUrl, requiredPath(serverUrl, "Jellyfin server URL"))) {
    throw new Error("The native bridge rejected a request from an untrusted page");
  }
}

function emitMpvEvent(name: MpvEventName, payload: MpvEventPayload = {}): void {
  if ((["ended", "quit", "failed"] as MpvEventName[]).includes(name)) {
    presence.clear();
  }
  if ((["ended", "quit", "failed"] as MpvEventName[]).includes(name)) {
    activeSeriesTrackContext = null;
    installMenu();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("jdc:mpv:event", name, payload);
  if (
    (currentMode === "web" || mpvControllerStale) &&
    (["ended", "quit", "failed"] as MpvEventName[]).includes(name)
  ) {
    setTimeout(() => {
      if (mpvController && !mpvController.current) closeMpvController();
    }, 0);
  }
}

function activeSeriesContext(value: unknown): SeriesTrackContext {
  const profile = activeServer(persistedSettings);
  if (!profile || !serverUrl) {
    throw new Error("No active Jellyfin server is available");
  }
  return {
    ...normalizeSeriesTrackContextInput(value),
    serverId: profile.id,
  };
}

async function showMpvStatusText(message: string): Promise<void> {
  if (!mpvController?.ready) return;
  try {
    await mpvController.showText(message, 2200);
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} Could not show MPV status text:`, errorMessage(error));
  }
}

async function forgetCurrentSeriesTracks(): Promise<void> {
  const context = activeSeriesTrackContext;
  if (!context) throw new Error("No series episode is currently playing");
  savePersistedSettings(
    normalizeSettings({
      ...persistedSettings,
      seriesTrackRules: removeSeriesTrackRule(
        persistedSettings.seriesTrackRules,
        context,
      ),
    }),
  );
  installMenu();
  await showMpvStatusText(`Cleared tracks for ${context.seriesName}`);
}

function createMpvController(): MpvController {
  if (mpvControllerStale && mpvController && !mpvController.current) {
    closeMpvController();
  }
  if (mpvController) return mpvController;
  mpvController = new MpvController({
    serverUrl: requiredPath(serverUrl, "Jellyfin server URL"),
    executable: mpvExecutable,
    provider: mpvExecutableResolution.provider,
    presentation: mpvPresentation,
    profile: mpvProfile,
    integrationScript: mpvIntegrationScript,
    eventSink: emitMpvEvent,
  });
  mpvControllerStale = false;
  return mpvController;
}

function closeMpvController(): void {
  activeSeriesTrackContext = null;
  if (!mpvController) return;
  mpvController.close();
  mpvController = null;
  mpvControllerStale = false;
}

async function stopAndReportActivePlayback(
  reason: PlaybackShutdownReason,
): Promise<boolean> {
  const controller = mpvController;
  if (!controller) return true;

  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  let reported = false;
  if (window && !window.webContents.isDestroyed()) {
    reported = await playbackShutdown.request(
      window.webContents.id,
      reason,
      (request) => {
        window.webContents.send("jdc:mpv:event", "shutdown", request);
      },
    );
  }
  if (!reported) {
    console.warn(
      `${LOG_PREFIX} Jellyfin Web did not acknowledge playback shutdown; stopping MPV directly.`,
    );
  }

  if (mpvController === controller && controller.current) {
    try {
      await controller.execute("stop");
    } catch (error: unknown) {
      console.warn(
        `${LOG_PREFIX} Could not stop MPV through IPC during ${reason}:`,
        errorMessage(error),
      );
    }
  }
  return reported;
}

async function closeMainWindowAfterPlayback(window: BrowserWindow): Promise<void> {
  const controller = mpvController;
  try {
    await stopAndReportActivePlayback("window-close");
  } catch (error: unknown) {
    console.warn(
      `${LOG_PREFIX} Graceful playback shutdown failed while closing:`,
      errorMessage(error),
    );
  } finally {
    mainWindowsPendingClose.delete(window);
    if (mpvController === controller) closeMpvController();
    if (!window.isDestroyed()) {
      mainWindowsAllowedToClose.add(window);
      window.close();
    }
  }
}

function assertSettingsSender(event: SenderEvent): void {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL() || "";
  const expectedUrl = pathToFileURL(
    requiredPath(settingsPagePath, "Settings page"),
  ).href;
  if (senderUrl !== expectedUrl) {
    throw new Error("The settings bridge rejected a request from an untrusted page");
  }
}

function assertServersSender(event: SenderEvent): void {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL() || "";
  const expectedUrl = pathToFileURL(requiredPath(serversPagePath, "Servers page")).href;
  if (senderUrl !== expectedUrl) {
    throw new Error("The server manager rejected a request from an untrusted page");
  }
}

async function settingsSnapshot(): Promise<SettingsSnapshot> {
  return {
    discordRichPresenceEnabled: persistedSettings.discordRichPresenceEnabled,
    discordPresenceConnection: presence.status().connection,
    playbackMode: currentMode,
    startMpvFullscreen,
    mpvPresentation,
    mpvPath: persistedSettings.mpvPath || "",
    mpvProfile: mpvProfile || "",
    mpvDiagnostic: await currentMpvDiagnostic(),
    appVersion: app.getVersion(),
  };
}

function serverLabel(profile: ServerProfile): string {
  return profile.displayName || profile.name;
}

function setServerConnectionStatus(
  serverId: string,
  state: ServerConnectionStatus["state"],
  message?: string,
): void {
  serverConnectionStates.set(serverId, {
    state,
    ...(message ? { message } : {}),
  });
}

function serversSnapshot(): ServerManagerSnapshot {
  return {
    servers: persistedSettings.servers,
    serverStates: Object.fromEntries(
      persistedSettings.servers.map((profile) => [
        profile.id,
        serverConnectionStates.get(profile.id) || { state: "saved" },
      ]),
    ),
    canClose: Boolean(mainWindow && !mainWindow.isDestroyed() && !mainRecoveryState),
    activeServerId: persistedSettings.activeServerId,
    connectionError: connectionError || undefined,
    statusMessage: serverStatusMessage || undefined,
    appVersion: app.getVersion(),
  };
}

function recoveryWindowState(window: BrowserWindow): WindowState | null {
  try {
    return captureWindowState(window);
  } catch {
    return restorableWindowState();
  }
}

function beginMainRecovery(
  failedWindow: BrowserWindow,
  reason: MainRecoveryReason,
  detail: string,
  markServerOffline: boolean,
): void {
  if (quitting || mainWindow !== failedWindow || failedWindow.isDestroyed()) {
    return;
  }

  const windowState = recoveryWindowState(failedWindow);
  persistMainWindowState(failedWindow);
  mainRecoveryState = { reason, windowState };
  connectionError = mainRecoveryMessage(reason, detail);
  serverStatusMessage = null;
  const profile = activeServer(persistedSettings);
  if (markServerOffline && profile) {
    setServerConnectionStatus(profile.id, "offline", connectionError);
  }

  console.warn(`${LOG_PREFIX} Entering runtime recovery:`, connectionError);
  mainWindow = null;
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  showServersWindow();
  emitServersSnapshot();
  installMenu();

  expectedRendererStops.add(failedWindow);
  failedWindow.hide();
  closeMpvController();
  failedWindow.destroy();
}

async function restoreMainWindowFromRecovery(): Promise<void> {
  const recovery = mainRecoveryState;
  if (!recovery || !serverUrl) return;
  const created = openMainWindow(recovery.windowState, false);
  if (!created) {
    throw new Error("Noktus could not recreate the Jellyfin window");
  }

  await created.ready;
  if (mainWindow !== created.window || created.window.isDestroyed()) {
    throw new Error("The recovered Jellyfin window closed before it was ready");
  }

  mainRecoveryState = null;
  connectionError = null;
  serverStatusMessage = null;
  if (serversWindow && !serversWindow.isDestroyed()) serversWindow.close();
  created.window.show();
  created.window.focus();
  emitServersSnapshot();
  installMenu();
  console.log(`${LOG_PREFIX} Runtime recovery completed after ${recovery.reason}`);
}

async function retryActiveServerForRecovery(): Promise<void> {
  const profile = activeServer(persistedSettings);
  if (!profile) {
    showServersWindow();
    return;
  }
  try {
    await activateSavedServer(profile.id);
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} Runtime recovery check failed:`, errorMessage(error));
    showServersWindow();
    emitServersSnapshot();
  }
}

async function showRendererRecoveryDialog(
  window: BrowserWindow,
  kind: RendererFailureKind,
  detail: string,
): Promise<void> {
  if (
    quitting ||
    mainWindow !== window ||
    window.isDestroyed() ||
    rendererRecoveryDialogs.has(window)
  ) {
    return;
  }

  rendererRecoveryDialogs.add(window);
  try {
    const prompt = rendererRecoveryPrompt(kind, detail);
    const result = await dialog.showMessageBox(window, {
      type: "error",
      ...prompt,
      noLink: true,
    });
    const action = rendererRecoveryAction(kind, result.response);
    if (action === "wait") {
      console.log(`${LOG_PREFIX} Waiting for Jellyfin Web to respond`);
      return;
    }
    if (action === "quit") {
      app.quit();
      return;
    }

    beginMainRecovery(
      window,
      kind === "crashed" ? "renderer-crash" : "unresponsive",
      detail,
      false,
    );
    if (action === "reload") await retryActiveServerForRecovery();
  } catch (error: unknown) {
    console.error(
      `${LOG_PREFIX} Renderer recovery dialog failed:`,
      errorMessage(error),
    );
    beginMainRecovery(
      window,
      kind === "crashed" ? "renderer-crash" : "unresponsive",
      detail,
      false,
    );
  } finally {
    rendererRecoveryDialogs.delete(window);
  }
}

function clearUnresponsiveRecoveryTimer(window: BrowserWindow): void {
  const timer = unresponsiveRecoveryTimers.get(window);
  if (timer) clearTimeout(timer);
  unresponsiveRecoveryTimers.delete(window);
}

function installMainWindowRecoveryHandlers(window: BrowserWindow): void {
  window.webContents.on(
    "render-process-gone",
    (_event, details: RenderProcessGoneDetails) => {
      clearUnresponsiveRecoveryTimer(window);
      if (quitting || expectedRendererStops.has(window) || mainWindow !== window) {
        return;
      }
      const detail = `Renderer exit reason: ${details.reason}; exit code: ${details.exitCode}.`;
      console.error(`${LOG_PREFIX} Jellyfin Web renderer stopped:`, detail);
      void showRendererRecoveryDialog(window, "crashed", detail);
    },
  );

  window.on("unresponsive", () => {
    if (
      quitting ||
      mainWindow !== window ||
      rendererRecoveryDialogs.has(window) ||
      unresponsiveRecoveryTimers.has(window)
    ) {
      return;
    }
    console.warn(`${LOG_PREFIX} Jellyfin Web became unresponsive`);
    const timer = setTimeout(() => {
      unresponsiveRecoveryTimers.delete(window);
      if (
        quitting ||
        mainWindow !== window ||
        window.isDestroyed() ||
        rendererRecoveryDialogs.has(window)
      ) {
        return;
      }
      void showRendererRecoveryDialog(
        window,
        "unresponsive",
        "Wait for the page, reload the active server, or choose another server.",
      );
    }, UNRESPONSIVE_RECOVERY_DELAY_MS);
    timer.unref();
    unresponsiveRecoveryTimers.set(window, timer);
  });

  window.on("responsive", () => {
    if (unresponsiveRecoveryTimers.has(window)) {
      console.log(`${LOG_PREFIX} Jellyfin Web became responsive again`);
    }
    clearUnresponsiveRecoveryTimer(window);
  });
  window.on("closed", () => clearUnresponsiveRecoveryTimer(window));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

async function checkActiveServerAfterResume(): Promise<void> {
  const profile = activeServer(persistedSettings);
  if (!profile || quitting) return;
  const serverId = profile.id;
  console.log(`${LOG_PREFIX} Checking ${serverLabel(profile)} after system resume`);
  serverStatusMessage = `Reconnecting to ${serverLabel(profile)}...`;
  connectionError = null;
  setServerConnectionStatus(serverId, "checking");
  emitServersSnapshot();

  let health: JellyfinServerHealth | null = null;
  let lastError: unknown = null;
  for (const retryDelay of [0, 2_000, 5_000]) {
    if (retryDelay) await delay(retryDelay);
    if (quitting || activeServer(persistedSettings)?.id !== serverId) return;
    try {
      health = await checkJellyfinServer(profile.url);
      break;
    } catch (error: unknown) {
      lastError = error;
      console.warn(`${LOG_PREFIX} Resume server check failed:`, errorMessage(error));
    }
  }
  if (quitting || activeServer(persistedSettings)?.id !== serverId) return;

  if (!health) {
    const detail = errorMessage(lastError);
    connectionError = mainRecoveryMessage("resume", detail);
    serverStatusMessage = null;
    setServerConnectionStatus(serverId, "offline", connectionError);
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (window) {
      beginMainRecovery(window, "resume", detail, true);
    } else {
      if (mainRecoveryState) {
        mainRecoveryState = { ...mainRecoveryState, reason: "resume" };
      }
      showServersWindow();
      emitServersSnapshot();
      installMenu();
    }
    return;
  }

  const nextProfile = profileFromHealth(health, profile.displayName);
  savePersistedSettings(upsertServer(persistedSettings, nextProfile, profile.id));
  if (profile.id !== nextProfile.id) serverConnectionStates.delete(profile.id);
  serverUrl = health.serverUrl;
  connectionError = null;
  serverStatusMessage = null;
  setServerConnectionStatus(nextProfile.id, "online");
  emitServersSnapshot();
  installMenu();
  console.log(`${LOG_PREFIX} Jellyfin server is reachable after system resume`);

  if (mainRecoveryState) {
    try {
      await restoreMainWindowFromRecovery();
    } catch (error: unknown) {
      console.error(
        `${LOG_PREFIX} Could not restore Jellyfin Web after resume:`,
        errorMessage(error),
      );
    }
  }
}

function installPowerMonitorRecovery(): void {
  powerMonitor.on("suspend", () => {
    if (resumeRecoveryTimer) {
      clearTimeout(resumeRecoveryTimer);
      resumeRecoveryTimer = null;
    }
    console.log(`${LOG_PREFIX} System suspended`);
  });
  powerMonitor.on("resume", () => {
    if (resumeRecoveryTimer) clearTimeout(resumeRecoveryTimer);
    console.log(`${LOG_PREFIX} System resumed; waiting for the network`);
    resumeRecoveryTimer = setTimeout(() => {
      resumeRecoveryTimer = null;
      void checkActiveServerAfterResume().catch((error: unknown) => {
        console.error(`${LOG_PREFIX} Resume recovery failed:`, errorMessage(error));
      });
    }, RESUME_RECOVERY_DELAY_MS);
    resumeRecoveryTimer.unref();
  });
}

function openSettingsExternalUrl(url: string): boolean {
  if (!SETTINGS_EXTERNAL_URLS.has(url)) return false;
  void shell.openExternal(url).catch((error: unknown) => {
    console.error(
      `${LOG_PREFIX} Could not open MPV installation page:`,
      errorMessage(error),
    );
  });
  return true;
}

function placeAuxiliaryWindow(
  window: BrowserWindow,
  owner: BrowserWindow | null,
  center: boolean,
): void {
  if (!owner && !center) return;

  const targetDisplay = owner
    ? screen.getDisplayMatching(owner.getBounds())
    : screen.getPrimaryDisplay();
  const currentDisplay = screen.getDisplayMatching(window.getBounds());
  if (!center && currentDisplay.id === targetDisplay.id) return;

  const bounds = window.getBounds();
  const workArea = targetDisplay.workArea;
  const x = workArea.x + Math.max(0, Math.floor((workArea.width - bounds.width) / 2));
  const y = workArea.y + Math.max(0, Math.floor((workArea.height - bounds.height) / 2));
  window.setPosition(x, y);
}

function showSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    placeAuxiliaryWindow(settingsWindow, owner, false);
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const pagePath = requiredPath(settingsPagePath, "Settings page");
  const expectedUrl = pathToFileURL(pagePath).href;
  settingsWindow = new BrowserWindow({
    width: 570,
    height: 680,
    minWidth: 460,
    minHeight: 580,
    parent: parent || undefined,
    modal: Boolean(parent),
    show: false,
    title: `${APP_NAME} Settings`,
    icon: requiredPath(appIconPath, "Application icon"),
    webPreferences: {
      preload: requiredPath(settingsPreloadPath, "Settings preload"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.webContents.on("will-navigate", (event, url) => {
    if (url === expectedUrl) return;
    event.preventDefault();
    openSettingsExternalUrl(url);
  });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    openSettingsExternalUrl(url);
    return { action: "deny" };
  });
  settingsWindow.once("ready-to-show", () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    placeAuxiliaryWindow(settingsWindow, parent, true);
    settingsWindow.show();
    settingsWindow.focus();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  void settingsWindow.loadFile(pagePath);
  return settingsWindow;
}

function emitServersSnapshot(): void {
  if (!serversWindow || serversWindow.isDestroyed()) return;
  serversWindow.webContents.send("jdc:servers:changed", serversSnapshot());
}

function showServersWindow(): BrowserWindow {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (serversWindow && !serversWindow.isDestroyed()) {
    placeAuxiliaryWindow(serversWindow, parent, false);
    serversWindow.show();
    serversWindow.focus();
    emitServersSnapshot();
    return serversWindow;
  }

  const pagePath = requiredPath(serversPagePath, "Servers page");
  const expectedUrl = pathToFileURL(pagePath).href;
  serversWindow = new BrowserWindow({
    width: 720,
    height: 680,
    minWidth: 540,
    minHeight: 460,
    parent: parent || undefined,
    show: false,
    title: `${APP_NAME} Servers`,
    icon: requiredPath(appIconPath, "Application icon"),
    webPreferences: {
      preload: requiredPath(serversPreloadPath, "Servers preload"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  serversWindow.setMenuBarVisibility(false);
  serversWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== expectedUrl) event.preventDefault();
  });
  serversWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  serversWindow.once("ready-to-show", () => {
    if (!serversWindow || serversWindow.isDestroyed()) return;
    placeAuxiliaryWindow(serversWindow, parent, true);
    serversWindow.show();
    serversWindow.focus();
  });
  serversWindow.on("closed", () => {
    serversWindow = null;
  });
  void serversWindow.loadFile(pagePath);
  return serversWindow;
}

function runSettingsSmoke(): void {
  const window = showSettingsWindow();
  window.webContents.once("did-finish-load", async () => {
    try {
      const report = (await window.webContents.executeJavaScript(`(async () => {
        const settings = await window.settingsApi.load();
        const diagnostic = await window.settingsApi.testMpv('');
        return {
          title: document.title,
          hasForm: Boolean(document.getElementById('settings-form')),
          hasDiscordPresence: Boolean(document.getElementById('discord-rich-presence')),
          hasDiscordPresenceStatus:
            typeof settings.discordRichPresenceEnabled === 'boolean' &&
            typeof settings.discordPresenceConnection === 'string',
          hasMpvInstallLinks:
            document.getElementById('install-mpv')?.href ===
              'https://mpv.io/installation/' &&
            document.getElementById('install-mpv-net')?.href ===
              'https://github.com/mpvnet-player/mpv.net/releases',
          hasMpvPath: Boolean(document.getElementById('mpv-path')),
          hasMpvTest: Boolean(document.getElementById('test-mpv')),
          hasMpvDiagnostic: Boolean(document.getElementById('mpv-diagnostic')),
          hasMpvTestBridge: typeof window.settingsApi.testMpv === 'function',
          hasMpvProfile: Boolean(document.getElementById('mpv-profile')),
          hasMpvProfileBridge:
            typeof window.settingsApi.listMpvProfiles === 'function',
          hasDiagnosticResult: typeof diagnostic?.available === 'boolean',
          hasSupportedResult: typeof diagnostic?.supported === 'boolean',
          hasBridge: typeof window.settingsApi === 'object',
          playbackMode: settings.playbackMode
        };
      })()`)) as SettingsSmokeReport;
      if (
        !report.hasForm ||
        !report.hasDiscordPresence ||
        !report.hasDiscordPresenceStatus ||
        !report.hasMpvInstallLinks ||
        !report.hasMpvPath ||
        !report.hasMpvTest ||
        !report.hasMpvDiagnostic ||
        !report.hasMpvTestBridge ||
        !report.hasMpvProfile ||
        !report.hasMpvProfileBridge ||
        !report.hasDiagnosticResult ||
        !report.hasSupportedResult ||
        !report.hasBridge ||
        !isPlaybackMode(report.playbackMode)
      ) {
        throw new Error(`Incomplete settings surface: ${JSON.stringify(report)}`);
      }
      console.log(
        `${LOG_PREFIX} Settings-window smoke passed:`,
        JSON.stringify(report),
      );
      app.exit(0);
    } catch (error: unknown) {
      console.error(`${LOG_PREFIX} Settings-window smoke failed:`, error);
      app.exit(1);
    }
  });
}

function runServerFailureSmoke(): void {
  const window = showServersWindow();
  window.webContents.once("did-finish-load", async () => {
    try {
      const report = (await window.webContents.executeJavaScript(`(async () => {
        const settings = await window.serverManagerApi.load();
        return {
          hasBridge: typeof window.serverManagerApi === 'object',
          connectionError: settings.connectionError
        };
      })()`)) as ServerFailureSmokeReport;
      if (mainWindow || !report.hasBridge || !report.connectionError) {
        throw new Error(
          `Invalid server did not recover to Settings: ${JSON.stringify(report)}`,
        );
      }
      console.log(
        `${LOG_PREFIX} Invalid-server recovery smoke passed:`,
        report.connectionError,
      );
      app.exit(0);
    } catch (error: unknown) {
      console.error(`${LOG_PREFIX} Invalid-server recovery smoke failed:`, error);
      app.exit(1);
    }
  });
}

function runRuntimeRecoverySmoke(initial: CreatedWindow): void {
  void (async () => {
    const originalWindow = initial.window;
    try {
      await initial.ready;
      try {
        await originalWindow.loadURL(
          `${requiredPath(serverUrl, "Jellyfin server URL")}/fail`,
        );
      } catch {
        // The deliberate main-frame failure must reject loadURL.
      }

      const recoveryDeadline = Date.now() + 5_000;
      while (!mainRecoveryState && Date.now() < recoveryDeadline) {
        await delay(25);
      }
      if (
        !mainRecoveryState ||
        mainWindow ||
        !originalWindow.isDestroyed() ||
        !serversWindow ||
        serversWindow.isDestroyed()
      ) {
        throw new Error("Main-frame failure did not enter runtime recovery");
      }

      const profile = activeServer(persistedSettings);
      if (!profile) throw new Error("Recovery smoke has no active server");
      await activateSavedServer(profile.id);
      const recoveredWindow = mainWindow as BrowserWindow | null;
      if (
        mainRecoveryState ||
        !recoveredWindow ||
        recoveredWindow.isDestroyed() ||
        recoveredWindow === originalWindow ||
        connectionError
      ) {
        throw new Error("Retry did not recreate a healthy Jellyfin window");
      }
      const title =
        await recoveredWindow.webContents.executeJavaScript("document.title");
      if (title !== "Recovery Smoke") {
        throw new Error(`Recovered an unexpected page: ${String(title)}`);
      }

      console.log(
        `${LOG_PREFIX} Runtime recovery smoke passed:`,
        JSON.stringify({
          originalDestroyed: originalWindow.isDestroyed(),
          recoveredTitle: title,
        }),
      );
      app.exit(0);
    } catch (error: unknown) {
      console.error(`${LOG_PREFIX} Runtime recovery smoke failed:`, error);
      app.exit(1);
    }
  })();
}

function runServersSmoke(): void {
  const window = showServersWindow();
  window.webContents.once("did-finish-load", async () => {
    try {
      const report = (await window.webContents.executeJavaScript(`(async () => {
        const snapshot = await window.serverManagerApi.load();
        return {
          title: document.title,
          hasForm: Boolean(document.getElementById('server-form')),
          hasServerName: Boolean(document.getElementById('server-name')),
          hasServerUrl: Boolean(document.getElementById('server-url')),
          hasBridge: typeof window.serverManagerApi === 'object',
          hasForgetLoginBridge: typeof window.serverManagerApi.forgetLogin === 'function',
          hasServerList: Array.isArray(snapshot.servers),
          hasServerStates: Boolean(snapshot.serverStates) && typeof snapshot.serverStates === 'object'
        };
      })()`)) as ServersSmokeReport;
      if (
        !report.hasForm ||
        !report.hasServerName ||
        !report.hasServerUrl ||
        !report.hasBridge ||
        !report.hasForgetLoginBridge ||
        !report.hasServerList ||
        !report.hasServerStates
      ) {
        throw new Error(`Incomplete server manager surface: ${JSON.stringify(report)}`);
      }
      console.log(`${LOG_PREFIX} Server-manager smoke passed:`, JSON.stringify(report));
      app.exit(0);
    } catch (error: unknown) {
      console.error(`${LOG_PREFIX} Server-manager smoke failed:`, error);
      app.exit(1);
    }
  });
}

function runDiagnosticsSmoke(): void {
  void (async () => {
    try {
      if (!logFilePath || !fs.existsSync(logFilePath)) {
        throw new Error("Local log file was not initialized");
      }

      const menu = Menu.getApplicationMenu();
      for (const id of [
        "noktus-about",
        "noktus-copy-diagnostics",
        "noktus-open-log-folder",
      ]) {
        if (!menu?.getMenuItemById(id)) {
          throw new Error(`Application menu is missing ${id}`);
        }
      }

      const report = await collectDiagnostics();
      if (!report.startsWith("Noktus diagnostics")) {
        throw new Error("Diagnostics report is missing its header");
      }
      for (const profile of persistedSettings.servers) {
        if (report.includes(profile.url)) {
          throw new Error("Diagnostics report exposed a server address");
        }
      }

      clipboard.writeText(report);
      if (clipboard.readText() !== report) {
        throw new Error("Diagnostics report did not round-trip through clipboard");
      }

      console.log(
        `${LOG_PREFIX} Diagnostics smoke passed:`,
        JSON.stringify({
          logFile: path.basename(logFilePath),
          reportLength: report.length,
        }),
      );
      app.exit(0);
    } catch (error: unknown) {
      console.error(`${LOG_PREFIX} Diagnostics smoke failed:`, error);
      app.exit(1);
    }
  })();
}

function runPackagedSmoke(): void {
  const window = showServersWindow();
  window.webContents.once("did-finish-load", async () => {
    try {
      if (!app.isPackaged) {
        throw new Error("Application is not running from a packaged bundle");
      }
      if (process.versions.electron !== COMPATIBILITY.electronVersion) {
        throw new Error(
          `Packaged Electron ${process.versions.electron} does not match ${COMPATIBILITY.electronVersion}`,
        );
      }
      if (!supportsRuntimeTarget(process.platform, process.arch)) {
        throw new Error(
          `Packaged runtime target is unsupported: ${process.platform}-${process.arch}`,
        );
      }
      if (path.basename(app.getAppPath()) !== "app.asar") {
        throw new Error(`Expected an ASAR application, got ${app.getAppPath()}`);
      }
      if (app.getName() !== PRODUCT_IDENTITY.name) {
        throw new Error(`Unexpected packaged product name: ${app.getName()}`);
      }
      for (const runtimePath of [
        preloadPath,
        settingsPreloadPath,
        serversPreloadPath,
        settingsPagePath,
        serversPagePath,
      ]) {
        if (!runtimePath || !fs.existsSync(runtimePath)) {
          throw new Error(`Packaged runtime file is missing: ${runtimePath}`);
        }
      }
      if (
        !mpvIntegrationScript ||
        !fs.existsSync(mpvIntegrationScript) ||
        path.dirname(path.dirname(mpvIntegrationScript)) !== process.resourcesPath
      ) {
        throw new Error(
          `External MPV integration resource is missing: ${mpvIntegrationScript}`,
        );
      }
      if (
        !appIconPath ||
        !fs.existsSync(appIconPath) ||
        path.dirname(path.dirname(appIconPath)) !== process.resourcesPath
      ) {
        throw new Error(
          `External application icon resource is missing: ${appIconPath}`,
        );
      }
      const noktusLicensePath = path.join(process.resourcesPath, "LICENSE");
      if (!fs.existsSync(noktusLicensePath)) {
        throw new Error(`External Noktus license is missing: ${noktusLicensePath}`);
      }

      const report = (await window.webContents.executeJavaScript(`(async () => {
        const snapshot = await window.serverManagerApi.load();
        return {
          title: document.title,
          hasBridge: typeof window.serverManagerApi === 'object',
          hasServerManager: Array.isArray(snapshot.servers)
        };
      })()`)) as PackagedSmokeReport;
      if (
        report.title !== `${APP_NAME} Servers` ||
        !report.hasBridge ||
        !report.hasServerManager
      ) {
        throw new Error(
          `Packaged server surface is incomplete: ${JSON.stringify(report)}`,
        );
      }
      console.log(
        `${LOG_PREFIX} Packaged-runtime smoke passed:`,
        JSON.stringify({
          ...report,
          appPath: path.basename(app.getAppPath()),
          appIcon: path.basename(appIconPath),
          mpvResource: path.basename(mpvIntegrationScript),
        }),
      );
      app.exit(0);
    } catch (error: unknown) {
      console.error(`${LOG_PREFIX} Packaged-runtime smoke failed:`, error);
      app.exit(1);
    }
  });
}

function openMainWindow(
  windowState: WindowState | null = restorableWindowState(),
  showWhenReady = true,
): CreatedWindow | null {
  if (!serverUrl) return null;
  const created = createWindow({
    bounds: windowState?.bounds,
    showWhenReady,
  });
  mainWindow = created.window;
  restoreMainWindowDisplayState(created.window, windowState);
  trackMainWindowState(created.window);
  installMenu();
  created.ready
    .then(() => {
      connectionError = null;
      const profile = activeServer(persistedSettings);
      if (profile) setServerConnectionStatus(profile.id, "online");
      emitServersSnapshot();
      installMenu();
    })
    .catch((error: unknown) => {
      recoverFromMainLoadFailure(created.window, error);
    });
  return created;
}

function recoverFromMainLoadFailure(failedWindow: BrowserWindow, error: unknown): void {
  console.error(`${LOG_PREFIX} Jellyfin Web load failed:`, error);
  beginMainRecovery(failedWindow, "load-failure", errorMessage(error), true);
}

function profileFromHealth(
  health: JellyfinServerHealth,
  displayName?: string,
): ServerProfile {
  if (health.version && !supportsJellyfinWebVersion(health.version)) {
    console.warn(
      `${LOG_PREFIX} Jellyfin ${health.version} is outside the tested ${COMPATIBILITY.jellyfinWebMinor}.x compatibility line`,
    );
  }
  const profile: ServerProfile = {
    id: health.serverId,
    name: health.serverName,
    url: health.serverUrl,
    version: health.version || undefined,
  };
  if (displayName?.trim()) profile.displayName = displayName.trim();
  return profile;
}

function savePersistedSettings(settings: AppSettings): void {
  persistedSettings = saveSettings(
    requiredPath(settingsPath, "Settings path"),
    settings,
  );
}

async function confirmServerSwitch(): Promise<void> {
  if (mpvController?.current) {
    const owner =
      serversWindow && !serversWindow.isDestroyed()
        ? serversWindow
        : mainWindow && !mainWindow.isDestroyed()
          ? mainWindow
          : undefined;
    const options = {
      type: "warning" as const,
      title: "Switch Jellyfin server",
      message: "Stop the current MPV playback and switch servers?",
      detail: "Noktus will report the stopped session before opening the server.",
      buttons: ["Stop and switch", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    };
    const result = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 0) throw new ServerSwitchCanceledError();
  }
  await stopAndReportActivePlayback("server-switch");
}

function scheduleActiveServerWindow(windowState: WindowState | null): void {
  setTimeout(() => {
    const oldWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    closeMpvController();
    const created = openMainWindow(windowState);
    if (!created) {
      connectionError = "The selected Jellyfin server could not be opened.";
      serverStatusMessage = null;
      const profile = activeServer(persistedSettings);
      if (profile) {
        setServerConnectionStatus(profile.id, "offline", connectionError);
      }
      showServersWindow();
      emitServersSnapshot();
      return;
    }
    if (oldWindow) oldWindow.destroy();
    created.ready
      .then(() => {
        connectionError = null;
        serverStatusMessage = null;
        if (serversWindow && !serversWindow.isDestroyed()) serversWindow.close();
        installMenu();
      })
      .catch(() => {
        // openMainWindow routes the failure back to the server picker.
      });
  }, 0);
}

async function activateValidatedServer(
  health: JellyfinServerHealth,
  replacingId?: string,
  displayName?: string,
): Promise<ServerManagerSnapshot> {
  const existingActive = activeServer(persistedSettings);
  const sameServer = existingActive?.id === health.serverId;
  const sameOpenServer = Boolean(mainWindow && !mainWindow.isDestroyed()) && sameServer;

  if (!sameServer) await confirmServerSwitch();
  const profile = profileFromHealth(health, displayName);
  savePersistedSettings(upsertServer(persistedSettings, profile, replacingId));
  if (replacingId && replacingId !== profile.id) {
    serverConnectionStates.delete(replacingId);
  }
  setServerConnectionStatus(profile.id, "online");
  serverUrl = health.serverUrl;
  connectionError = null;
  serverStatusMessage = `Connecting to ${serverLabel(profile)}...`;
  installMenu();

  if (sameServer && mainRecoveryState) {
    await restoreMainWindowFromRecovery();
  } else if (sameOpenServer) {
    serverStatusMessage = null;
    setTimeout(() => {
      if (serversWindow && !serversWindow.isDestroyed()) serversWindow.close();
      mainWindow?.show();
      mainWindow?.focus();
    }, 0);
  } else {
    const recoveryWindowState = mainRecoveryState?.windowState || null;
    mainRecoveryState = null;
    const windowState =
      mainWindow && !mainWindow.isDestroyed()
        ? captureWindowState(mainWindow)
        : recoveryWindowState || restorableWindowState();
    scheduleActiveServerWindow(windowState);
  }
  return serversSnapshot();
}

async function activateSavedServer(serverId: string): Promise<ServerManagerSnapshot> {
  const profile = persistedSettings.servers.find((server) => server.id === serverId);
  if (!profile) throw new Error("The selected Jellyfin server no longer exists");
  serverStatusMessage = `Checking ${serverLabel(profile)}...`;
  setServerConnectionStatus(profile.id, "checking");
  connectionError = null;
  emitServersSnapshot();
  try {
    const health = await checkJellyfinServer(profile.url);
    return activateValidatedServer(health, profile.id, profile.displayName);
  } catch (error: unknown) {
    serverStatusMessage = null;
    if (error instanceof ServerSwitchCanceledError) {
      connectionError = null;
      setServerConnectionStatus(profile.id, "online");
      emitServersSnapshot();
      return serversSnapshot();
    }
    connectionError = errorMessage(error);
    setServerConnectionStatus(profile.id, "offline", connectionError);
    emitServersSnapshot();
    throw error;
  }
}

function saveServerRequest(value: unknown): SaveServerRequest {
  if (!isRecord(value) || typeof value.url !== "string") {
    throw new Error("A Jellyfin server address is required");
  }
  const request: SaveServerRequest = { url: value.url };
  if (typeof value.displayName === "string") {
    const displayName = value.displayName.trim();
    if (displayName.length > 80) {
      throw new Error("The server display name must be 80 characters or fewer");
    }
    request.displayName = displayName;
  }
  if (typeof value.replacingId === "string" && value.replacingId) {
    request.replacingId = value.replacingId;
  }
  return request;
}

async function saveServer(value: unknown): Promise<ServerManagerSnapshot> {
  const request = saveServerRequest(value);
  const editedProfile = request.replacingId
    ? persistedSettings.servers.find((profile) => profile.id === request.replacingId)
    : undefined;
  if (
    editedProfile &&
    request.displayName !== undefined &&
    normalizeServerUrl(request.url) === editedProfile.url
  ) {
    savePersistedSettings(
      updateServerDisplayName(persistedSettings, editedProfile.id, request.displayName),
    );
  }
  serverStatusMessage = "Checking Jellyfin server...";
  if (request.replacingId) {
    setServerConnectionStatus(request.replacingId, "checking");
  }
  connectionError = null;
  emitServersSnapshot();
  try {
    const health = await checkJellyfinServer(request.url);
    return activateValidatedServer(
      health,
      request.replacingId,
      request.displayName ?? editedProfile?.displayName,
    );
  } catch (error: unknown) {
    serverStatusMessage = null;
    if (error instanceof ServerSwitchCanceledError) {
      connectionError = null;
      if (request.replacingId) {
        setServerConnectionStatus(request.replacingId, "online");
      }
      emitServersSnapshot();
      return serversSnapshot();
    }
    connectionError = errorMessage(error);
    if (request.replacingId) {
      setServerConnectionStatus(request.replacingId, "offline", connectionError);
    }
    emitServersSnapshot();
    throw error;
  }
}

async function removeSavedServer(serverId: string): Promise<ServerManagerSnapshot> {
  if (!persistedSettings.servers.some((server) => server.id === serverId)) {
    throw new Error("The selected Jellyfin server no longer exists");
  }
  const removedActiveServer = persistedSettings.activeServerId === serverId;
  if (removedActiveServer) await confirmServerSwitch();
  savePersistedSettings(removeServer(persistedSettings, serverId));
  serverConnectionStates.delete(serverId);
  if (removedActiveServer) {
    closeMpvController();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    mainWindow = null;
    serverUrl = null;
    connectionError = null;
    serverStatusMessage = null;
    mainRecoveryState = null;
  }
  installMenu();
  return serversSnapshot();
}

async function forgetSavedServerLogin(
  serverId: string,
): Promise<ServerManagerSnapshot> {
  const profile = persistedSettings.servers.find(
    (candidate) => candidate.id === serverId,
  );
  if (!profile) {
    throw new Error("The selected Jellyfin server no longer exists");
  }

  const affectedProfiles = profilesSharingOrigin(persistedSettings.servers, profile);
  const activeProfile = activeServer(persistedSettings);
  const affectsActiveServer = Boolean(
    activeProfile &&
    affectedProfiles.some((candidate) => candidate.id === activeProfile.id),
  );
  const sharedOriginDetail =
    affectedProfiles.length > 1
      ? `\n\nThese saved servers share the same web origin and will also be signed out: ${affectedProfiles
          .filter((candidate) => candidate.id !== profile.id)
          .map(serverLabel)
          .join(", ")}.`
      : "";
  const playbackDetail = affectsActiveServer
    ? " Active playback will be stopped and the Jellyfin page will reload."
    : "";
  const options = {
    type: "warning" as const,
    title: "Forget Jellyfin login data",
    message: `Forget login data for ${serverLabel(profile)}?`,
    detail:
      `Noktus will clear cookies and site storage for this server. The server will remain in your saved list.${playbackDetail}` +
      sharedOriginDetail +
      "\n\nBrowser cookies may be shared more broadly by a domain, so other services on the same site may also be signed out.",
    buttons: ["Forget login data", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  };
  const owner =
    serversWindow && !serversWindow.isDestroyed()
      ? serversWindow
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : undefined;
  const confirmation = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  if (confirmation.response !== 0) return serversSnapshot();

  serverStatusMessage = `Forgetting login data for ${serverLabel(profile)}...`;
  connectionError = null;
  emitServersSnapshot();
  try {
    if (affectsActiveServer) {
      await stopAndReportActivePlayback("server-switch");
      closeMpvController();
    }
    await clearServerLoginData(session.defaultSession, profile.url);
    console.log(
      `${LOG_PREFIX} Cleared local Jellyfin login data for ${serverLabel(profile)}`,
    );

    if (affectsActiveServer && serverUrl && mainWindow && !mainWindow.isDestroyed()) {
      const window = mainWindow;
      try {
        await window.loadURL(`${serverUrl}/web/`);
      } catch (error: unknown) {
        recoverFromMainLoadFailure(window, error);
        throw error;
      }
    }
  } finally {
    serverStatusMessage = null;
    emitServersSnapshot();
  }
  return serversSnapshot();
}

async function applySettings(rawSettings: unknown): Promise<SettingsSnapshot> {
  const source = isRecord(rawSettings) ? rawSettings : {};
  const requestedProfile = normalizeMpvProfile(source.mpvProfile);
  const nextSettings = normalizeSettings({
    ...persistedSettings,
    discordRichPresenceEnabled: source.discordRichPresenceEnabled,
    playbackMode: source.playbackMode,
    startMpvFullscreen: source.startMpvFullscreen,
    mpvPresentation: source.mpvPresentation,
    mpvPath: source.mpvPath,
    mpvProfile: requestedProfile,
  });
  const previousMpvPath = persistedSettings.mpvPath || "";
  const previousPresentation = mpvPresentation;
  const previousProfile = mpvProfile;

  const presenceWasEnabled = persistedSettings.discordRichPresenceEnabled;
  savePersistedSettings(nextSettings);
  presence.setEnabled(nextSettings.discordRichPresenceEnabled);
  if (!presenceWasEnabled && nextSettings.discordRichPresenceEnabled) {
    mainWindow?.webContents.send("jdc:presence:sync");
  }
  startMpvFullscreen = nextSettings.startMpvFullscreen;
  mpvPresentation = normalizeMpvPresentation(nextSettings.mpvPresentation);
  mpvProfile = nextSettings.mpvProfile;
  refreshMpvExecutable();

  const mpvConfigurationChanged =
    previousMpvPath !== (nextSettings.mpvPath || "") ||
    previousPresentation !== mpvPresentation ||
    previousProfile !== mpvProfile;
  if (mpvConfigurationChanged && mpvController) {
    if (mpvController.current) mpvControllerStale = true;
    else closeMpvController();
  }
  await switchMode(nextSettings.playbackMode);
  installMenu();

  setTimeout(() => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  }, 0);
  return settingsSnapshot();
}

function registerIpc(): void {
  ipcMain.handle("jdc:servers:load", (event: IpcMainInvokeEvent) => {
    assertServersSender(event);
    return serversSnapshot();
  });
  ipcMain.handle(
    "jdc:servers:save",
    async (event: IpcMainInvokeEvent, request: unknown) => {
      assertServersSender(event);
      return saveServer(request);
    },
  );
  ipcMain.handle(
    "jdc:servers:activate",
    async (event: IpcMainInvokeEvent, serverId: unknown) => {
      assertServersSender(event);
      if (typeof serverId !== "string") {
        throw new Error("A saved Jellyfin server is required");
      }
      return activateSavedServer(serverId);
    },
  );
  ipcMain.handle(
    "jdc:servers:remove",
    async (event: IpcMainInvokeEvent, serverId: unknown) => {
      assertServersSender(event);
      if (typeof serverId !== "string") {
        throw new Error("A saved Jellyfin server is required");
      }
      return removeSavedServer(serverId);
    },
  );
  ipcMain.handle(
    "jdc:servers:forget-login",
    async (event: IpcMainInvokeEvent, serverId: unknown) => {
      assertServersSender(event);
      if (typeof serverId !== "string") {
        throw new Error("A saved Jellyfin server is required");
      }
      return forgetSavedServerLogin(serverId);
    },
  );
  ipcMain.handle("jdc:settings:load", (event: IpcMainInvokeEvent) => {
    assertSettingsSender(event);
    return settingsSnapshot();
  });
  ipcMain.handle(
    "jdc:settings:save",
    async (event: IpcMainInvokeEvent, settings: unknown) => {
      assertSettingsSender(event);
      return applySettings(settings);
    },
  );
  ipcMain.handle("jdc:settings:browse-mpv", async (event: IpcMainInvokeEvent) => {
    assertSettingsSender(event);
    const options: OpenDialogOptions = {
      title: "Select MPV or mpv.net executable",
      properties: ["openFile"],
    };
    if (process.platform === "win32") {
      options.filters = [
        { name: "Applications", extensions: ["exe"] },
        { name: "All files", extensions: ["*"] },
      ];
    }
    const owner =
      settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle(
    "jdc:settings:test-mpv",
    (event: IpcMainInvokeEvent, candidate: unknown) => {
      assertSettingsSender(event);
      return testMpvExecutable(candidate);
    },
  );
  ipcMain.handle(
    "jdc:settings:list-mpv-profiles",
    (event: IpcMainInvokeEvent, candidate: unknown) => {
      assertSettingsSender(event);
      return listMpvProfiles(candidate);
    },
  );
  ipcMain.handle("jdc:mpv:status", async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event);
    const diagnostic = await currentMpvDiagnostic();
    const status = mpvController?.status() || {
      ready: false,
      provider: mpvExecutableResolution.provider,
      executable: mpvExecutable,
      presentation: mpvPresentation,
      reason: "",
    };
    return {
      ...status,
      backend: currentMode,
      available: diagnostic.available,
      provider: diagnostic.provider,
      executable: diagnostic.executable,
      version: diagnostic.version,
      source: diagnostic.source,
      reason: status.reason || diagnostic.reason,
      startFullscreen: startMpvFullscreen,
    };
  });
  ipcMain.handle("jdc:presence:update", (event: IpcMainInvokeEvent, value: unknown) => {
    assertTrustedSender(event);
    const activity = normalizePresenceActivity(value);
    if (!activity) return false;
    presence.update(activity);
    return true;
  });
  ipcMain.handle("jdc:presence:clear", (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event);
    presence.clear();
    return true;
  });
  ipcMain.handle(
    "jdc:series-tracks:resolve",
    (event: IpcMainInvokeEvent, value: unknown) => {
      assertTrustedSender(event);
      const context = activeSeriesContext(value);
      const resolution = resolveSeriesTracks(
        persistedSettings.seriesTrackRules,
        context,
      );
      activeSeriesTrackContext = {
        ...context,
        audioStreamIndex: resolution.audioStreamIndex,
        subtitleStreamIndex: resolution.subtitleStreamIndex,
      };
      installMenu();
      return resolution;
    },
  );
  ipcMain.handle(
    "jdc:series-tracks:remember",
    async (event: IpcMainInvokeEvent, value: unknown) => {
      assertTrustedSender(event);
      const context = activeSeriesContext(value);
      if (
        !activeSeriesTrackContext ||
        activeSeriesTrackContext.serverId !== context.serverId ||
        activeSeriesTrackContext.userId !== context.userId ||
        activeSeriesTrackContext.seriesId !== context.seriesId
      ) {
        return false;
      }
      const changed =
        activeSeriesTrackContext.audioStreamIndex !== context.audioStreamIndex ||
        activeSeriesTrackContext.subtitleStreamIndex !== context.subtitleStreamIndex;
      activeSeriesTrackContext = context;
      if (!changed) return false;
      savePersistedSettings(
        normalizeSettings({
          ...persistedSettings,
          seriesTrackRules: saveSeriesTrackRule(
            persistedSettings.seriesTrackRules,
            context,
          ),
        }),
      );
      installMenu();
      await showMpvStatusText(`Saved tracks for ${context.seriesName}`);
      return true;
    },
  );
  ipcMain.handle("jdc:series-tracks:clear", (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event);
    activeSeriesTrackContext = null;
    installMenu();
    return true;
  });
  ipcMain.handle(
    "jdc:playback-shutdown-ready",
    (event: IpcMainInvokeEvent, requestId: unknown) => {
      assertTrustedSender(event);
      if (typeof requestId !== "string" || !requestId) return false;
      return playbackShutdown.acknowledge(event.sender.id, requestId);
    },
  );
  ipcMain.handle(
    "jdc:mpv:load",
    async (event: IpcMainInvokeEvent, request: unknown) => {
      assertTrustedSender(event);
      return createMpvController().load(request);
    },
  );
  const commands = {
    play: "play",
    pause: "pause",
    stop: "stop",
    seek: "seek",
    setVolume: "volume",
    setMuted: "muted",
    setRate: "rate",
    setAudioTrack: "audioTrack",
    setSubtitleTrack: "subtitleTrack",
    setFullscreen: "fullscreen",
  } as const;
  for (const [channelName, commandName] of Object.entries(commands)) {
    ipcMain.handle(
      `jdc:mpv:${channelName}`,
      async (event: IpcMainInvokeEvent, value: unknown) => {
        assertTrustedSender(event);
        return createMpvController().execute(commandName, value);
      },
    );
  }
  ipcMain.handle(
    "jdc:mpv:setSegments",
    async (event: IpcMainInvokeEvent, segments: unknown) => {
      assertTrustedSender(event);
      return createMpvController().setSegments(segments);
    },
  );
  ipcMain.handle(
    "jdc:mpv:setNavigation",
    async (event: IpcMainInvokeEvent, navigation: unknown) => {
      assertTrustedSender(event);
      return createMpvController().setNavigation(navigation);
    },
  );
  ipcMain.handle(
    "jdc:mpv:trickplay:begin",
    (event: IpcMainInvokeEvent, metadata: unknown) => {
      assertTrustedSender(event);
      return createMpvController().beginTrickplay(metadata);
    },
  );
  ipcMain.handle(
    "jdc:mpv:trickplay:append",
    (event: IpcMainInvokeEvent, id: unknown, chunk: unknown) => {
      assertTrustedSender(event);
      return createMpvController().appendTrickplay(id, chunk);
    },
  );
  ipcMain.handle(
    "jdc:mpv:trickplay:commit",
    (event: IpcMainInvokeEvent, id: unknown) => {
      assertTrustedSender(event);
      return createMpvController().commitTrickplay(id);
    },
  );
  ipcMain.handle(
    "jdc:mpv:trickplay:abort",
    (event: IpcMainInvokeEvent, id: unknown) => {
      assertTrustedSender(event);
      return createMpvController().abortTrickplay(id);
    },
  );
  ipcMain.handle("jdc:mpv:trickplay:clear", (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event);
    return createMpvController().clearTrickplay();
  });
  ipcMain.handle(
    "jdc:open-external",
    async (event: IpcMainInvokeEvent, rawUrl: unknown) => {
      assertTrustedSender(event);
      if (typeof rawUrl !== "string") throw new Error("URL must be a string");
      if (!isWithinServer(rawUrl, requiredPath(serverUrl, "Jellyfin server URL"))) {
        throw new Error("Only pages on the configured Jellyfin server may be opened");
      }
      await shell.openExternal(new URL(rawUrl).href);
      return true;
    },
  );
  ipcMain.handle("jdc:play-here", (event: IpcMainInvokeEvent, rawUrl: unknown) => {
    assertTrustedSender(event);
    if (typeof rawUrl !== "string") throw new Error("URL must be a string");
    if (!isWithinServer(rawUrl, requiredPath(serverUrl, "Jellyfin server URL"))) {
      throw new Error("The inline playback destination is outside the Jellyfin server");
    }
    setTimeout(() => {
      switchMode("web", new URL(rawUrl).href).catch((error: unknown) => {
        console.error(`${LOG_PREFIX} Could not switch to Web playback:`, error);
      });
    }, 0);
    return true;
  });
  ipcMain.handle("jdc:focus-app", (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event);
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return true;
  });
  ipcMain.on("jdc:preload-error", (_event: IpcMainEvent, message: unknown) => {
    console.error(`${LOG_PREFIX} Preload injection failed:`, message);
  });
  ipcMain.on("jdc:injection-status", (_event: IpcMainEvent, status: unknown) => {
    console.log(`${LOG_PREFIX} Player injection:`, JSON.stringify(status));
  });
}

function codecProbeSource(): string {
  return `(() => {
    const video = document.createElement('video');
    const audio = document.createElement('audio');
    const mse = type => typeof MediaSource !== 'undefined'
      && typeof MediaSource.isTypeSupported === 'function'
      && MediaSource.isTypeSupported(type);
    return {
      userAgent: navigator.userAgent,
      h264AacMp4: video.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"'),
      h264Mp4: video.canPlayType('video/mp4; codecs="avc1.640028"'),
      aac: audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
      hevc: video.canPlayType('video/mp4; codecs="hvc1.1.6.L120.B0"'),
      vp9: video.canPlayType('video/webm; codecs="vp9, opus"'),
      av1: video.canPlayType('video/mp4; codecs="av01.0.05M.08, opus"'),
      mseH264Aac: mse('video/mp4; codecs="avc1.640028, mp4a.40.2"'),
      mseHevc: mse('video/mp4; codecs="hvc1.1.6.L120.B0"')
    };
  })()`;
}

async function collectCodecReport(
  showDialog: boolean = false,
  targetWindow: BrowserWindow | null = mainWindow,
  mode: PlaybackMode = currentMode,
): Promise<Record<string, unknown> | null> {
  if (!targetWindow || targetWindow.isDestroyed()) return null;
  try {
    const report = (await targetWindow.webContents.executeJavaScript(
      codecProbeSource(),
    )) as Record<string, unknown>;
    const complete = {
      mode,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      ...report,
    };
    console.log(`${LOG_PREFIX} Codec report:`, JSON.stringify(complete, null, 2));
    if (showDialog) {
      await dialog.showMessageBox(targetWindow, {
        type: "info",
        title: "Electron codec report",
        message: "Embedded media capability report",
        detail: JSON.stringify(complete, null, 2),
      });
    }
    return complete;
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} Codec probe failed:`, errorMessage(error));
    return null;
  }
}

function diagnosticOwner(): BrowserWindow | undefined {
  return (
    BrowserWindow.getFocusedWindow() ||
    settingsWindow ||
    serversWindow ||
    mainWindow ||
    undefined
  );
}

function runMenuAction(label: string, action: () => Promise<unknown>): void {
  void action().catch((error: unknown) => {
    console.error(`${LOG_PREFIX} ${label} failed:`, errorMessage(error));
  });
}

async function showAboutDialog(): Promise<void> {
  const diagnostic = await currentMpvDiagnostic();
  const options = {
    type: "info" as const,
    title: `About ${APP_NAME}`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: [
      "A thin Jellyfin desktop client with Web and MPV playback.",
      "",
      `Electron ${process.versions.electron}`,
      `Chromium ${process.versions.chrome}`,
      `Node.js ${process.versions.node}`,
      diagnostic.available
        ? `${diagnostic.provider === "mpv.net" ? "mpv.net" : "MPV"} ${diagnostic.version}${diagnostic.supported ? "" : " (not validated)"}`
        : "MPV player not currently available",
      `Supported Jellyfin Web: ${COMPATIBILITY.jellyfinWebMinor}.x`,
      `Supported MPV: ${COMPATIBILITY.minimumMpvVersion}+`,
      "",
      "Noktus does not upload telemetry or crash reports.",
    ].join("\n"),
  };
  const owner = diagnosticOwner();
  if (owner) await dialog.showMessageBox(owner, options);
  else await dialog.showMessageBox(options);
}

async function showKeyboardShortcutsDialog(): Promise<void> {
  const primary = process.platform === "darwin" ? "Command" : "Ctrl";
  const options = {
    type: "info" as const,
    title: `${APP_NAME} keyboard shortcuts`,
    message: "Keyboard shortcuts",
    detail: [
      `Settings — ${primary}+,`,
      `Switch or add server — ${primary}+Shift+S`,
      `Use Jellyfin Web player — ${primary}+Shift+W`,
      `Use MPV player — ${primary}+Shift+M`,
      `Zoom in / out — ${primary}+Plus / ${primary}+Minus`,
      `Actual size — ${primary}+0`,
      "",
      "While playing in MPV",
      "Skip the active segment — Enter",
      "Skip fallback — Ctrl+Shift+I",
      "Next / previous item — > / <",
      "",
      "Jellyfin Web handles its own playback shortcuts.",
    ].join("\n"),
  };
  const owner = diagnosticOwner();
  if (owner) await dialog.showMessageBox(owner, options);
  else await dialog.showMessageBox(options);
}

function currentJellyfinPageUrl(): string | null {
  if (!serverUrl || !mainWindow || mainWindow.isDestroyed()) return null;
  try {
    return safeJellyfinPageUrl(mainWindow.webContents.getURL(), serverUrl);
  } catch {
    return null;
  }
}

async function openCurrentJellyfinPage(): Promise<void> {
  const url = currentJellyfinPageUrl();
  if (!url) throw new Error("No Jellyfin page is currently available");
  await shell.openExternal(url);
}

async function copyCurrentJellyfinPage(): Promise<void> {
  const url = currentJellyfinPageUrl();
  if (!url) throw new Error("No Jellyfin page is currently available");
  clipboard.writeText(url);
}

async function openLogFolder(): Promise<void> {
  if (!logDirectory) return;
  const result = await shell.openPath(logDirectory);
  if (!result) return;
  const options = {
    type: "error" as const,
    title: "Could not open log folder",
    message: "Noktus could not open its local log folder.",
    detail: result,
  };
  const owner = diagnosticOwner();
  if (owner) await dialog.showMessageBox(owner, options);
  else await dialog.showMessageBox(options);
}

function diagnosticCodecReport(
  report: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!report) return undefined;
  return {
    h264AacMp4: report.h264AacMp4,
    h264Mp4: report.h264Mp4,
    aac: report.aac,
    hevc: report.hevc,
    vp9: report.vp9,
    av1: report.av1,
    mseH264Aac: report.mseH264Aac,
    mseHevc: report.mseHevc,
  };
}

async function collectDiagnostics(): Promise<string> {
  const mpv = await currentMpvDiagnostic();
  const executableName = path.basename(mpv.executable);
  const codecReport = await collectCodecReport(false);
  const activeProfile = activeServer(persistedSettings);
  const value: NoktusDiagnostics = {
    generatedAt: new Date().toISOString(),
    application: {
      name: APP_NAME,
      version: app.getVersion(),
      packaged: app.isPackaged,
    },
    platform: {
      operatingSystem: process.platform,
      release: os.release(),
      architecture: process.arch,
    },
    runtime: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    },
    playback: {
      mode: currentMode,
      mpvPresentation,
      mpvProfile: mpvProfile || null,
      startMpvFullscreen,
    },
    presence: presence.status(),
    mpv: {
      available: mpv.available,
      supported: mpv.supported,
      provider: mpv.provider,
      version: mpv.version,
      source: mpv.source,
      executableName,
      reason: mpv.reason.split(mpv.executable).join(executableName),
    },
    jellyfin: {
      savedServerCount: persistedSettings.servers.length,
      activeServerVersion: activeProfile?.version || null,
      connected: Boolean(serverUrl && mainWindow && !mainWindow.isDestroyed()),
      seriesTrackRuleCount: persistedSettings.seriesTrackRules.length,
    },
    compatibility: {
      jellyfinWeb: `${COMPATIBILITY.jellyfinWebMinor}.x`,
      electron: COMPATIBILITY.electronVersion,
      minimumMpv: COMPATIBILITY.minimumMpvVersion,
      runtimeTargetSupported: supportsRuntimeTarget(process.platform, process.arch),
    },
    codecs: diagnosticCodecReport(codecReport),
  };
  return createDiagnosticsReport(value);
}

async function copyDiagnostics(): Promise<void> {
  const report = await collectDiagnostics();
  clipboard.writeText(report);
  const options = {
    type: "info" as const,
    title: "Diagnostics copied",
    message: "Noktus diagnostics were copied to the clipboard.",
    detail:
      "The report excludes access tokens, server addresses, media URLs, and account details.",
  };
  const owner = diagnosticOwner();
  if (owner) await dialog.showMessageBox(owner, options);
  else await dialog.showMessageBox(options);
}

function switchMode(
  mode: PlaybackMode,
  targetUrl: string | null = null,
): Promise<void> {
  if (switchPromise) return switchPromise;
  if (mode === currentMode && !targetUrl) return Promise.resolve();

  switchPromise = (async () => {
    currentMode = mode;
    if (mode === "web") activeSeriesTrackContext = null;
    if (mode === "mpv" && serverUrl) createMpvController();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(`${APP_NAME} - ${mode.toUpperCase()}`);
      mainWindow.webContents.send("jdc:mpv:event", "mode", { value: mode });
    }
    installMenu();
    persistRuntimeSettings();

    if (mode === "web" && mpvController && !mpvController.current) {
      closeMpvController();
    }
    if (targetUrl && mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(targetUrl);
    }
  })().finally(() => {
    switchPromise = null;
  });
  return switchPromise;
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [];
  const hasCurrentPage = Boolean(currentJellyfinPageUrl());
  const hasSeriesContext = Boolean(currentMode === "mpv" && activeSeriesTrackContext);
  const hasSavedSeriesRule = Boolean(
    activeSeriesTrackContext &&
    findSeriesTrackRule(persistedSettings.seriesTrackRules, activeSeriesTrackContext),
  );
  const serverItems: MenuItemConstructorOptions[] =
    persistedSettings.servers.length > 0
      ? persistedSettings.servers.map((server) => ({
          label: serverLabel(server),
          sublabel: server.url,
          type: "radio" as const,
          checked: server.id === persistedSettings.activeServerId,
          click: () => {
            serverStatusMessage = `Checking ${serverLabel(server)}...`;
            connectionError = null;
            activateSavedServer(server.id).catch((error: unknown) => {
              console.error(
                `${LOG_PREFIX} Could not switch to ${serverLabel(server)}:`,
                error,
              );
              installMenu();
              showServersWindow();
              emitServersSnapshot();
            });
          },
        }))
      : [{ label: "No saved servers", enabled: false }];
  if (process.platform === "darwin") template.push({ role: "appMenu" });
  template.push(
    {
      label: "Application",
      submenu: [
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => showSettingsWindow(),
        },
        { type: "separator" },
        {
          id: "noktus-about",
          label: `About ${APP_NAME}`,
          click: () => runMenuAction("About dialog", showAboutDialog),
        },
      ],
    },
    {
      label: "Servers",
      submenu: [
        ...serverItems,
        { type: "separator" },
        {
          label: "Switch or add server...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => showServersWindow(),
        },
      ],
    },
    {
      label: "Playback",
      enabled: Boolean(serverUrl),
      submenu: [
        {
          label: "Web player",
          type: "radio",
          checked: currentMode === "web",
          accelerator: "CmdOrCtrl+Shift+W",
          click: () => switchMode("web").catch(console.error),
        },
        {
          label: "MPV player",
          type: "radio",
          checked: currentMode === "mpv",
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => switchMode("mpv").catch(console.error),
        },
        { type: "separator" },
        {
          label: "Start MPV fullscreen",
          type: "checkbox",
          checked: startMpvFullscreen,
          click: (item) => {
            startMpvFullscreen = item.checked;
            persistRuntimeSettings();
          },
        },
        { type: "separator" },
        {
          label: "Forget automatically saved tracks for this series",
          enabled: hasSeriesContext && hasSavedSeriesRule,
          click: () => runMenuAction("Forget series tracks", forgetCurrentSeriesTracks),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Open current page in browser",
          enabled: hasCurrentPage,
          click: () => runMenuAction("Open current page", openCurrentJellyfinPage),
        },
        {
          label: "Copy current page link",
          enabled: hasCurrentPage,
          click: () => runMenuAction("Copy current page link", copyCurrentJellyfinPage),
        },
      ],
    },
    {
      label: "Diagnostics",
      submenu: [
        {
          id: "noktus-copy-diagnostics",
          label: "Copy diagnostics",
          click: () => runMenuAction("Copy diagnostics", copyDiagnostics),
        },
        {
          id: "noktus-open-log-folder",
          label: "Open log folder",
          enabled: Boolean(logDirectory && logFilePath),
          click: () => runMenuAction("Open log folder", openLogFolder),
        },
        { type: "separator" },
        {
          label: "Show codec report",
          enabled: Boolean(serverUrl),
          click: () => runMenuAction("Codec report", () => collectCodecReport(true)),
        },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Keyboard shortcuts...",
          click: () => runMenuAction("Keyboard shortcuts", showKeyboardShortcutsDialog),
        },
      ],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow({
  mode = currentMode,
  targetUrl,
  showWhenReady = true,
  bounds = null,
}: CreateWindowOptions = {}): CreatedWindow {
  if (!serverUrl)
    throw new Error("A Jellyfin server URL is required before opening the client");
  if (mode === "mpv") createMpvController();
  const destination = targetUrl || `${serverUrl}/web/`;
  const preloadArguments = [
    `--jdc-server-url=${encodeURIComponent(serverUrl)}`,
    `--jdc-mode=${mode}`,
    `--jdc-app-version=${encodeURIComponent(app.getVersion())}`,
  ];
  const window = new BrowserWindow({
    ...(bounds || {
      width: MAIN_WINDOW_DEFAULT_WIDTH,
      height: MAIN_WINDOW_DEFAULT_HEIGHT,
    }),
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: false,
    title: `${APP_NAME} - ${mode.toUpperCase()}`,
    icon: requiredPath(appIconPath, "Application icon"),
    webPreferences: {
      preload: requiredPath(preloadPath, "Main preload"),
      additionalArguments: preloadArguments,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (showWhenReady && !window.isDestroyed()) window.show();
      resolve();
    };
    window.webContents.once("did-finish-load", finish);
    window.webContents.once(
      "did-fail-load",
      (_event, code, description, _url, isMainFrame) => {
        if (
          settled ||
          !shouldRecoverMainFrameLoadFailure(code, isMainFrame, quitting)
        ) {
          return;
        }
        settled = true;
        reject(new Error(`Jellyfin Web failed to load: ${code} ${description}`));
      },
    );
  });

  installMainWindowRecoveryHandlers(window);
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    playbackShutdown.cancel();
    if (!quitting && BrowserWindow.getAllWindows().length === 0) {
      closeMpvController();
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isWithinServer(url, requiredPath(serverUrl, "Jellyfin server URL"))) {
      return;
    }
    event.preventDefault();
    if (["http:", "https:"].includes(new URL(url).protocol)) {
      void shell.openExternal(url);
    }
  });
  window.webContents.on("did-start-loading", () => presence.clear());
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (["http:", "https:"].includes(new URL(url).protocol))
        void shell.openExternal(url);
    } catch {
      // Invalid and non-web URLs are ignored.
    }
    return { action: "deny" };
  });
  window.webContents.on(
    "did-fail-load",
    (_event, code, description, url, isMainFrame) => {
      if (!shouldRecoverMainFrameLoadFailure(code, isMainFrame, quitting)) {
        return;
      }
      console.error(`${LOG_PREFIX} Failed to load ${url}: ${code} ${description}`);
      recoverFromMainLoadFailure(
        window,
        new Error(`Jellyfin Web failed to load: ${code} ${description}`),
      );
    },
  );
  window.webContents.once("did-finish-load", () =>
    collectCodecReport(false, window, mode),
  );
  void window.loadURL(destination);
  return { window, ready };
}

app.on("before-quit", (event) => {
  if (resumeRecoveryTimer) {
    clearTimeout(resumeRecoveryTimer);
    resumeRecoveryTimer = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    persistMainWindowState(mainWindow);
  }
  if (quitting) return;
  if (!mpvController || !mainWindow || mainWindow.isDestroyed()) {
    quitting = true;
    presence.close();
    closeMpvController();
    return;
  }

  event.preventDefault();
  quitting = true;
  void stopAndReportActivePlayback("quit")
    .catch((error: unknown) => {
      console.warn(
        `${LOG_PREFIX} Graceful playback shutdown failed while quitting:`,
        errorMessage(error),
      );
    })
    .finally(() => {
      presence.close();
      closeMpvController();
      app.quit();
    });
});

app.on("activate", () => {
  if (!isPrimaryInstance) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    if (mainRecoveryState || !serverUrl) showServersWindow();
    else openMainWindow();
  }
});

if (isPrimaryInstance) {
  app.on("second-instance", () => focusExistingInstance());
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  initializeRuntime();
  const grantFullscreenPermission = (
    requestingWebContentsId: number | null,
    permission: string,
    requestingUrl: string,
    isMainFrame: boolean,
  ): boolean =>
    shouldGrantFullscreenPermission({
      permission,
      requestingUrl,
      isMainFrame,
      requestingWebContentsId,
      mainWindowWebContentsId:
        mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null,
      serverUrl,
    });
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      grantFullscreenPermission(
        webContents?.id ?? null,
        permission,
        details.requestingUrl || requestingOrigin,
        details.isMainFrame,
      ),
  );
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        grantFullscreenPermission(
          webContents.id,
          permission,
          details.requestingUrl,
          details.isMainFrame,
        ),
      );
    },
  );
  registerIpc();
  installPowerMonitorRecovery();
  installMenu();
  if (smokePackaged) {
    runPackagedSmoke();
    return;
  }
  if (smokeDiagnostics) {
    runDiagnosticsSmoke();
    return;
  }
  if (smokeSettings) {
    runSettingsSmoke();
    return;
  }
  if (smokeServers) {
    runServersSmoke();
    return;
  }
  if (startupError) {
    connectionError = startupError.message;
    await dialog.showMessageBox({
      type: "error",
      title: APP_NAME,
      message: startupError.message,
      detail:
        "Correct the saved values in Settings, or remove invalid command-line overrides.",
    });
    showServersWindow();
    return;
  }
  if (!serverUrl) {
    showServersWindow();
    return;
  }

  try {
    const candidateServerUrl = serverUrl;
    const candidateProfile = persistedSettings.servers.find(
      (profile) =>
        normalizeServerUrl(profile.url) === normalizeServerUrl(candidateServerUrl),
    );
    if (candidateProfile) {
      setServerConnectionStatus(candidateProfile.id, "checking");
    }
    const health = await checkJellyfinServer(candidateServerUrl);
    serverUrl = health.serverUrl;
    connectionError = null;
    serverStatusMessage = null;
    const replacingId = candidateProfile?.id;
    const profile = profileFromHealth(health, candidateProfile?.displayName);
    savePersistedSettings(upsertServer(persistedSettings, profile, replacingId));
    if (replacingId && replacingId !== profile.id) {
      serverConnectionStates.delete(replacingId);
    }
    setServerConnectionStatus(profile.id, "online");
    installMenu();
  } catch (error: unknown) {
    connectionError = errorMessage(error);
    const failedProfile = persistedSettings.servers.find(
      (profile) => profile.url === serverUrl,
    );
    if (failedProfile) {
      setServerConnectionStatus(failedProfile.id, "offline", connectionError);
    }
    serverUrl = null;
    console.error(`${LOG_PREFIX} Server validation failed:`, error);
    installMenu();
    if (smokeServerFailure) runServerFailureSmoke();
    else showServersWindow();
    return;
  }

  const initial = openMainWindow();
  if (!initial) throw new Error("Could not create the main window");
  if (smokeRuntimeRecovery) {
    runRuntimeRecoverySmoke(initial);
  } else if (smokeSwitch) {
    const initialWindow = initial.window;
    initial.ready
      .then(() => switchMode(currentMode === "web" ? "mpv" : "web"))
      .then(() => {
        if (mainWindow !== initialWindow || initialWindow.isDestroyed()) {
          throw new Error("Playback mode switch replaced the application window");
        }
        console.log(
          `${LOG_PREFIX} In-place mode-switch smoke passed in ${currentMode} mode`,
        );
        app.quit();
      })
      .catch((error: unknown) => {
        console.error(`${LOG_PREFIX} Mode-switch smoke failed:`, error);
        process.exitCode = 1;
        app.quit();
      });
  } else {
    initial.ready.catch(() => {});
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
