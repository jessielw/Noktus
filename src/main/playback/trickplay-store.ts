import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FILE_PREFIX = "noktus-trickplay-";
const FILE_SUFFIX = ".bgra";
export const TRICKPLAY_WINDOW_BYTES = 25 * 1024 * 1024;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_FRAMES = 100_000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const MAX_DIMENSION = 1920;
const STALE_FILE_AGE_MS = 24 * 60 * 60 * 1000;
const cleanupDirectories = new Set<string>();

export interface TrickplayWindowMetadata {
  count: number;
  intervalMs: number;
  width: number;
  height: number;
  first: number;
  total: number;
}

interface PendingWindow extends TrickplayWindowMetadata {
  id: string;
  filePath: string;
  handle: fs.promises.FileHandle;
  expectedBytes: number;
  writtenBytes: number;
}

type PublishMessage = (command: Array<string | number>) => Promise<unknown>;

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function normalizeTrickplayMetadata(value: unknown): TrickplayWindowMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("trickplay metadata must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const width = integer(candidate.width, "width", 1, MAX_DIMENSION);
  const height = integer(candidate.height, "height", 1, MAX_DIMENSION);
  const count = integer(candidate.count, "count", 1, MAX_TOTAL_FRAMES);
  const total = integer(candidate.total, "total", count, MAX_TOTAL_FRAMES);
  const first = integer(candidate.first, "first", 0, total - 1);
  const intervalMs = integer(candidate.intervalMs, "intervalMs", 1, MAX_INTERVAL_MS);
  if (first + count > total) {
    throw new Error("trickplay window extends beyond the video");
  }
  const expectedBytes = width * height * 4 * count;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > TRICKPLAY_WINDOW_BYTES) {
    throw new Error(
      `trickplay window exceeds the ${TRICKPLAY_WINDOW_BYTES}-byte budget`,
    );
  }
  return { count, intervalMs, width, height, first, total };
}

function chunkBytes(value: unknown): Uint8Array {
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new Error("trickplay chunk must be binary data");
  }
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new Error(`trickplay chunk must be between 1 and ${MAX_CHUNK_BYTES} bytes`);
  }
  return bytes;
}

async function removeFile(filePath: string | null): Promise<void> {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[Noktus] Could not remove a trickplay file:", error);
    }
  }
}

export async function cleanupStaleTrickplayFiles(
  directory = os.tmpdir(),
  now = Date.now(),
): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
      .map(async (name) => {
        const filePath = path.join(directory, name);
        try {
          const stats = await fs.promises.stat(filePath);
          if (now - stats.mtimeMs >= STALE_FILE_AGE_MS) await removeFile(filePath);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
            console.warn("[Noktus] Could not inspect a trickplay file:", error);
          }
        }
      }),
  );
}

export class TrickplayStore {
  private readonly publish: PublishMessage;
  private readonly directory: string;
  private pending: PendingWindow | null = null;
  private currentPath: string | null = null;
  private retiredPath: string | null = null;
  private operations: Promise<unknown> = Promise.resolve();

  constructor(publish: PublishMessage, directory = os.tmpdir()) {
    this.publish = publish;
    this.directory = directory;
    if (!cleanupDirectories.has(directory)) {
      cleanupDirectories.add(directory);
      void cleanupStaleTrickplayFiles(directory);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  begin(value: unknown): Promise<string> {
    return this.enqueue(async () => {
      const metadata = normalizeTrickplayMetadata(value);
      await this.abortPending();
      const id = crypto.randomUUID();
      const filePath = path.join(
        this.directory,
        `${FILE_PREFIX}${process.pid}-${id}${FILE_SUFFIX}`,
      );
      const handle = await fs.promises.open(filePath, "wx");
      this.pending = {
        ...metadata,
        id,
        filePath,
        handle,
        expectedBytes: metadata.width * metadata.height * 4 * metadata.count,
        writtenBytes: 0,
      };
      return id;
    });
  }

  append(id: unknown, value: unknown): Promise<true> {
    return this.enqueue<true>(async () => {
      if (typeof id !== "string" || !id || this.pending?.id !== id) {
        throw new Error("trickplay generation is no longer active");
      }
      const bytes = chunkBytes(value);
      if (this.pending.writtenBytes + bytes.byteLength > this.pending.expectedBytes) {
        throw new Error("trickplay data exceeds the declared window size");
      }
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await this.pending.handle.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          null,
        );
        if (result.bytesWritten < 1) {
          throw new Error("trickplay file write made no progress");
        }
        offset += result.bytesWritten;
        this.pending.writtenBytes += result.bytesWritten;
      }
      return true as const;
    });
  }

  commit(id: unknown): Promise<true> {
    return this.enqueue<true>(async () => {
      const pending = this.pending;
      if (typeof id !== "string" || !pending || pending.id !== id) {
        throw new Error("trickplay generation is no longer active");
      }
      this.pending = null;
      await pending.handle.close();
      if (pending.writtenBytes !== pending.expectedBytes) {
        await removeFile(pending.filePath);
        throw new Error(
          `trickplay data is incomplete (${pending.writtenBytes} of ${pending.expectedBytes} bytes)`,
        );
      }

      try {
        await this.publish([
          "script-message",
          "shim-trickplay-bif",
          String(pending.count),
          String(pending.intervalMs),
          String(pending.width),
          String(pending.height),
          pending.filePath,
          String(pending.first),
          String(pending.total),
        ]);
      } catch (error: unknown) {
        await removeFile(pending.filePath);
        throw error;
      }

      const removable = this.retiredPath;
      this.retiredPath = this.currentPath;
      this.currentPath = pending.filePath;
      await removeFile(removable);
      return true as const;
    });
  }

  abort(id: unknown): Promise<true> {
    return this.enqueue<true>(async () => {
      if (typeof id === "string" && this.pending?.id === id) {
        await this.abortPending();
      }
      return true as const;
    });
  }

  clear(publish = true): Promise<true> {
    return this.enqueue<true>(async () => {
      await this.abortPending();
      if (publish) {
        await this.publish(["script-message", "shim-trickplay-clear"]);
        const removable = this.currentPath ? this.retiredPath : null;
        if (this.currentPath) this.retiredPath = this.currentPath;
        this.currentPath = null;
        await removeFile(removable);
        return true as const;
      }
      const current = this.currentPath;
      const retired = this.retiredPath;
      this.currentPath = null;
      this.retiredPath = null;
      await removeFile(current);
      await removeFile(retired);
      return true as const;
    });
  }

  private async abortPending(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    try {
      await pending.handle.close();
    } finally {
      await removeFile(pending.filePath);
    }
  }
}
