import * as net from "node:net";
import type {
  PresenceActivity,
  PresenceConnectionState,
  PresenceProvider,
} from "./types";

const HANDSHAKE_OPCODE = 0;
const FRAME_OPCODE = 1;
const CLOSE_OPCODE = 2;
const RETRY_DELAY_MS = 15_000;
const CONNECT_TIMEOUT_MS = 750;

export interface DiscordIpcProviderOptions {
  applicationId: string;
  largeImageKey: string;
  socketPaths?: () => string[];
}

interface DiscordFrame {
  opcode: number;
  payload: Record<string, unknown>;
}

export function encodeDiscordFrame(
  opcode: number,
  payload: Record<string, unknown>,
): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeUInt32LE(opcode, 0);
  frame.writeUInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

export function discordSocketPaths(): string[] {
  if (process.platform === "win32") {
    return Array.from(
      { length: 10 },
      (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`,
    );
  }
  const directories = [
    process.env.XDG_RUNTIME_DIR,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    "/tmp",
  ].filter(
    (value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
  );
  return directories.flatMap((directory) =>
    Array.from({ length: 10 }, (_, index) => `${directory}/discord-ipc-${index}`),
  );
}

function discordActivity(activity: PresenceActivity, largeImageKey: string) {
  const pausedPosition = Math.floor(activity.positionSeconds);
  return {
    type: activity.mediaType === "audio" ? 2 : 3,
    details: activity.title,
    ...(activity.playbackState === "paused"
      ? { state: `Paused \u2022 ${formatPosition(pausedPosition)}` }
      : {
          state: activity.mediaType === "audio" ? "Listening" : "Watching",
          timestamps: {
            start: Math.floor(Date.now() / 1000 - activity.positionSeconds),
          },
        }),
    assets: {
      large_image: largeImageKey,
      large_text: "Noktus",
    },
  };
}

function formatPosition(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export class DiscordIpcProvider implements PresenceProvider {
  private socket: net.Socket | null = null;
  private connection: PresenceConnectionState;
  private desiredActivity: PresenceActivity | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting: Promise<void> | null = null;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly options: DiscordIpcProviderOptions) {
    this.connection = options.applicationId ? "unavailable" : "unconfigured";
  }

  status(): PresenceConnectionState {
    return this.connection;
  }

  async connect(): Promise<void> {
    if (!this.options.applicationId || this.closed) return;
    try {
      await this.ensureConnected();
    } catch {
      this.scheduleRetry();
    }
  }

  async setActivity(activity: PresenceActivity | null): Promise<void> {
    this.desiredActivity = activity;
    if (!activity) {
      this.cancelRetry();
      this.sendActivity(null);
      return;
    }
    if (!this.options.applicationId || this.closed) return;
    await this.connect();
    this.sendActivity(activity);
  }

  close(): void {
    this.closed = true;
    this.cancelRetry();
    this.desiredActivity = null;
    this.socket?.destroy();
    this.socket = null;
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && this.connection === "connected") return;
    if (!this.connecting) {
      this.connecting = this.connectIpc().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connectIpc(): Promise<void> {
    this.connection = "connecting";
    let lastError: Error | null = null;
    for (const socketPath of (this.options.socketPaths || discordSocketPaths)()) {
      try {
        await this.connectPath(socketPath);
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    this.connection = "unavailable";
    throw lastError || new Error("Discord IPC is unavailable");
  }

  private connectPath(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timer = null;
        socket.destroy();
        reject(new Error("Discord IPC connection timed out"));
      }, CONNECT_TIMEOUT_MS);
      const finish = (error?: Error) => {
        if (timer) clearTimeout(timer);
        timer = null;
        socket.off("error", fail);
        if (error) reject(error);
        else resolve();
      };
      const fail = (error: Error) => finish(error);
      socket.once("error", fail);
      socket.once("connect", () => {
        this.attachSocket(socket);
        socket.write(
          encodeDiscordFrame(HANDSHAKE_OPCODE, {
            v: 1,
            client_id: this.options.applicationId,
          }),
        );
      });
      socket.once("close", () => {
        if (this.connection !== "connected") finish(new Error("Discord IPC closed"));
      });
      socket.once("ready", () => {});
      const ready = () => {
        socket.off("discord-ready", ready);
        this.connection = "connected";
        finish();
      };
      socket.on("discord-ready", ready);
    });
  }

  private attachSocket(socket: net.Socket): void {
    this.socket?.destroy();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => this.readFrames(socket, chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.closed) {
        this.connection = "unavailable";
        if (this.desiredActivity) this.scheduleRetry();
      }
    });
  }

  private readFrames(socket: net.Socket, chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (length > 1_000_000) {
        socket.destroy();
        return;
      }
      if (this.buffer.length < 8 + length) return;
      const rawPayload = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawPayload) as Record<string, unknown>;
      } catch {
        socket.destroy();
        return;
      }
      const frame: DiscordFrame = { opcode, payload };
      if (frame.opcode === CLOSE_OPCODE) {
        socket.destroy();
        return;
      }
      if (frame.opcode === FRAME_OPCODE && frame.payload.evt === "READY") {
        socket.emit("discord-ready");
      }
    }
  }

  private sendActivity(activity: PresenceActivity | null): void {
    if (!this.socket || this.connection !== "connected") return;
    this.socket.write(
      encodeDiscordFrame(FRAME_OPCODE, {
        cmd: "SET_ACTIVITY",
        nonce: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        args: {
          pid: process.pid,
          activity: activity
            ? discordActivity(activity, this.options.largeImageKey)
            : null,
        },
      }),
    );
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed || !this.desiredActivity) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.setActivity(this.desiredActivity);
    }, RETRY_DELAY_MS);
  }

  private cancelRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
