"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  formatLogValues,
  installFileLogging,
  redactSensitive,
  RotatingFileLogger,
} = require("../build/main/logging");

test("redacts Jellyfin tokens, authorization headers, and URL credentials", () => {
  const source = [
    "https://media.example/Videos/1?api_key=secret-one&start=4",
    '"AccessToken":"secret-two"',
    "Authorization: Bearer secret-three",
    'Authorization: MediaBrowser Token="secret-eight", Client="Noktus"',
    "X-Emby-Token: secret-four",
    "X-MediaBrowser-Token: secret-six",
    'X-Emby-Authorization: MediaBrowser Token="secret-seven"',
    "https://user:secret-five@media.example/web/",
  ].join("\n");
  const redacted = redactSensitive(source);

  for (const secret of [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
  ]) {
    assert.ok(!redacted.includes(`secret-${secret}`));
  }
  assert.match(redacted, /api_key=\[REDACTED\]/);
  assert.match(redacted, /Authorization: Bearer \[REDACTED\]/);
});

test("formats structured values and errors before redaction", () => {
  const message = formatLogValues([
    "Request failed",
    { api_key: "hidden", status: 500 },
    new Error("token=also-hidden"),
  ]);

  assert.match(message, /Request failed/);
  assert.match(message, /status: 500/);
  assert.ok(!message.includes("also-hidden"));
  assert.ok(!message.includes("hidden"));
});

test("rotates bounded log files and never writes secrets", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "noktus-logs-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logger = new RotatingFileLogger(directory, {
    maxBytes: 220,
    maxFiles: 3,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
  });

  for (let index = 0; index < 12; index += 1) {
    logger.write("INFO", [
      `entry-${index}`,
      `https://media.example/video?api_key=secret-${index}`,
    ]);
  }

  const files = fs
    .readdirSync(directory)
    .filter((file) => file.startsWith("noktus.log"));
  const contents = files
    .map((file) => fs.readFileSync(path.join(directory, file), "utf8"))
    .join("\n");
  assert.ok(files.length <= 3);
  assert.match(contents, /\[REDACTED\]/);
  assert.ok(!contents.includes("secret-"));
});

test("file logging captures console.info and console.debug, not just console.log", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "noktus-logs-"));
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  t.after(() => {
    Object.assign(console, original);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const { filePath } = installFileLogging(directory);
  console.info("[Noktus] Trickplay ready: 240 previews at 320x180.");
  console.debug("[Noktus] debug breadcrumb");
  console.warn("[Noktus] Trickplay error: tile 3 returned HTTP 404");

  const contents = fs.readFileSync(filePath, "utf8");
  assert.match(contents, /\[INFO\] \[Noktus\] Trickplay ready: 240 previews/);
  assert.match(contents, /\[INFO\] \[Noktus\] debug breadcrumb/);
  assert.match(contents, /\[WARN\] \[Noktus\] Trickplay error/);
});
