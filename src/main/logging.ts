import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const MAX_LOG_MESSAGE_LENGTH = 32 * 1024;

export type LogLevel = "INFO" | "WARN" | "ERROR";

interface RotatingFileLoggerOptions {
  maxBytes?: number;
  maxFiles?: number;
  now?: () => Date;
}

export interface InstalledFileLogging {
  directory: string;
  filePath: string;
}

export function redactSensitive(value: string): string {
  return value
    .replace(
      /([?&](?:api_key|apikey|access_token|accesstoken|token|x-emby-token|x-mediabrowser-token|x-emby-authorization)=)[^&#\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["'](?:api_key|apikey|access_token|accesstoken|token|x-emby-token|x-mediabrowser-token|x-emby-authorization|authorization)["']\s*:\s*["'])[^"']*(["'])/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /(?<!["'])\b(authorization\s*:\s*["']?(?:bearer\s+)?)[^"'\s,;}]+(["']?)/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /(?<!["'])\b((?:x-emby-token|x-mediabrowser-token|x-emby-authorization)\s*:\s*["']?)[^"'\s,;}]+(["']?)/gi,
      "$1[REDACTED]$2",
    )
    .replace(/\b(Token\s*=\s*)(["']?)[^"'\s,;}]+(["']?)/gi, "$1$2[REDACTED]$3")
    .replace(
      /(?<!["'])\b(api_key|apikey|access_token|accesstoken|token)\b(\s*:\s*)["']?[^"',}\s]+["']?/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /\b(api_key|apikey|access_token|accesstoken|token|x-emby-token|x-mediabrowser-token|x-emby-authorization)\s*=\s*[^\s&,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[REDACTED]@");
}

export function formatLogValues(values: unknown[]): string {
  const formatted = util.formatWithOptions(
    { colors: false, depth: 6, breakLength: Infinity, maxArrayLength: 100 },
    ...values,
  );
  const redacted = redactSensitive(formatted);
  return redacted.length <= MAX_LOG_MESSAGE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_LOG_MESSAGE_LENGTH)}... [truncated]`;
}

export class RotatingFileLogger {
  readonly directory: string;
  readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => Date;
  private currentBytes = 0;

  constructor(
    directory: string,
    {
      maxBytes = DEFAULT_MAX_BYTES,
      maxFiles = DEFAULT_MAX_FILES,
      now = () => new Date(),
    }: RotatingFileLoggerOptions = {},
  ) {
    if (maxBytes <= 0 || maxFiles < 1) {
      throw new Error("Log limits must be positive");
    }
    this.directory = directory;
    this.filePath = path.join(directory, "noktus.log");
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.now = now;
    fs.mkdirSync(directory, { recursive: true });
    try {
      this.currentBytes = fs.statSync(this.filePath).size;
    } catch {
      this.currentBytes = 0;
    }
    if (this.currentBytes >= this.maxBytes) this.rotate();
  }

  write(level: LogLevel, values: unknown[]): void {
    const line = `[${this.now().toISOString()}] [${level}] ${formatLogValues(values)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.currentBytes > 0 && this.currentBytes + bytes > this.maxBytes) {
      this.rotate();
    }
    fs.appendFileSync(this.filePath, line, { encoding: "utf8", mode: 0o600 });
    this.currentBytes += bytes;
  }

  private rotate(): void {
    if (this.maxFiles === 1) {
      try {
        fs.unlinkSync(this.filePath);
      } catch (error: unknown) {
        if (!isMissingFile(error)) throw error;
      }
      this.currentBytes = 0;
      return;
    }

    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const destination = `${this.filePath}.${index}`;
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      try {
        fs.unlinkSync(destination);
      } catch (error: unknown) {
        if (!isMissingFile(error)) throw error;
      }
      try {
        fs.renameSync(source, destination);
      } catch (error: unknown) {
        if (!isMissingFile(error)) throw error;
      }
    }
    this.currentBytes = 0;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function installFileLogging(directory: string): InstalledFileLogging {
  const logger = new RotatingFileLogger(directory);
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  let writable = true;
  const install =
    (level: LogLevel, output: (...values: unknown[]) => void) =>
    (...values: unknown[]) => {
      const message = formatLogValues(values);
      output(message);
      if (!writable) return;
      try {
        logger.write(level, [message]);
      } catch (error: unknown) {
        writable = false;
        original.error(formatLogValues(["[Noktus] File logging failed:", error]));
      }
    };

  console.log = install("INFO", original.log);
  // `info` and `debug` are their own properties on Node's console rather than
  // wrappers around `log`, so replacing `log` alone left them writing to stdout
  // only. Trickplay reported every non-error outcome through `console.info`,
  // which is why bug reports arrived with logs that never mentioned trickplay.
  console.info = install("INFO", original.info);
  console.debug = install("INFO", original.debug);
  console.warn = install("WARN", original.warn);
  console.error = install("ERROR", original.error);
  console.log("[Noktus] Local logging started");
  return { directory: logger.directory, filePath: logger.filePath };
}
