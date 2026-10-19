import electronPath from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SMOKE_TIMEOUT_MS = 45_000;
const desktopSmoke = process.argv.includes("--desktop");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "noktus-recovery-smoke-"));

const server = http.createServer((request, response) => {
  const requestPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (requestPath === "/System/Info/Public") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ProductName: "Jellyfin Server",
        Id: "noktus-runtime-recovery-smoke",
        ServerName: "Recovery Smoke",
        Version: "10.11.0",
      }),
    );
    return;
  }
  if (requestPath === "/web/" || requestPath === "/web/index.html") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      "<!doctype html><html><head><title>Recovery Smoke</title></head><body>Jellyfin recovery smoke</body></html>",
    );
    return;
  }
  if (requestPath === "/fail") {
    request.socket.destroy();
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("Not found");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") {
  server.close();
  throw new Error("Runtime recovery smoke server did not bind to TCP");
}
const serverUrl = `http://127.0.0.1:${address.port}`;
if (desktopSmoke) {
  await fs.writeFile(
    path.join(userDataPath, "settings.json"),
    JSON.stringify({
      discordRichPresenceEnabled: false,
      seriesTrackRules: ["user-one", "user-two"].map((userId) => ({
        serverId: "noktus-runtime-recovery-smoke",
        userId,
        seriesId: "series-one",
        seriesName: "Example Show",
        subtitle: "off",
        updatedAt: "2026-10-18T00:00:00.000Z",
      })),
    }),
  );
}
const electronArguments = [
  ...(process.platform === "linux" && process.env.NOKTUS_TEST_NO_SANDBOX === "1"
    ? ["--no-sandbox"]
    : []),
  projectRoot,
  desktopSmoke ? "--smoke-desktop" : "--smoke-runtime-recovery",
  `--server-url=${serverUrl}`,
  `--smoke-user-data=${encodeURIComponent(userDataPath)}`,
];

let exitCode = 1;
try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, electronArguments, {
      cwd: projectRoot,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    let settled = false;
    let timer = null;
    const finish = (error, code = 1) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(code);
    };
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish(null, 0);
      else {
        finish(
          new Error(
            `Runtime recovery smoke exited with ${code ?? signal ?? "unknown"}`,
          ),
        );
      }
    });
    timer = setTimeout(() => {
      child.kill();
      finish(new Error("Runtime recovery smoke timed out"));
    }, SMOKE_TIMEOUT_MS);
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(userDataPath, { recursive: true, force: true });
}
process.exitCode = exitCode;
