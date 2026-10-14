export const COMPATIBILITY = {
  jellyfinWebMinor: "10.11",
  electronVersion: "43.7.7",
  minimumMpvVersion: "0.37.0",
  targets: [
    { platform: "win32", architectures: ["x64"] },
    { platform: "darwin", architectures: ["x64", "arm64"] },
    { platform: "linux", architectures: ["x64"] },
  ],
} as const;

function numericVersion(value: string): [number, number, number] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function supportsJellyfinWebVersion(version: string): boolean {
  const parsed = numericVersion(version);
  const supported = numericVersion(`${COMPATIBILITY.jellyfinWebMinor}.0`);
  return Boolean(
    parsed && supported && parsed[0] === supported[0] && parsed[1] === supported[1],
  );
}

export function supportsElectronVersion(version: string): boolean {
  return version === COMPATIBILITY.electronVersion;
}

export function supportsMpvVersion(version: string): boolean {
  const parsed = numericVersion(version);
  const minimum = numericVersion(COMPATIBILITY.minimumMpvVersion);
  if (!parsed || !minimum) return false;
  const [major, minor, patch] = parsed;
  const [minimumMajor, minimumMinor, minimumPatch] = minimum;
  if (major !== minimumMajor) return major > minimumMajor;
  if (minor !== minimumMinor) return minor > minimumMinor;
  return patch >= minimumPatch;
}

export function supportsRuntimeTarget(platform: string, architecture: string): boolean {
  return COMPATIBILITY.targets.some(
    (target) =>
      target.platform === platform &&
      target.architectures.some((candidate) => candidate === architecture),
  );
}
