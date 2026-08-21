import { redactSensitive } from "./logging";

export interface NoktusDiagnostics {
  generatedAt: string;
  application: {
    name: string;
    version: string;
    packaged: boolean;
  };
  platform: {
    operatingSystem: string;
    release: string;
    architecture: string;
  };
  runtime: {
    electron: string;
    chromium: string;
    node: string;
  };
  playback: {
    mode: string;
    mpvPresentation: string;
    mpvProfile: string | null;
    startMpvFullscreen: boolean;
  };
  presence: {
    enabled: boolean;
    provider: string;
    connection: string;
  };
  mpv: {
    available: boolean;
    supported: boolean;
    provider: string;
    version: string | null;
    source: string;
    executableName: string;
    reason: string;
  };
  jellyfin: {
    savedServerCount: number;
    activeServerVersion: string | null;
    connected: boolean;
    seriesTrackRuleCount: number;
  };
  compatibility: {
    jellyfinWeb: string;
    electron: string;
    minimumMpv: string;
    runtimeTargetSupported: boolean;
  };
  codecs?: Record<string, unknown>;
}

export function createDiagnosticsReport(value: NoktusDiagnostics): string {
  return redactSensitive(
    [
      "Noktus diagnostics",
      "No access tokens, server addresses, media URLs, or account details are included.",
      "",
      JSON.stringify(value, null, 2),
    ].join("\n"),
  );
}
