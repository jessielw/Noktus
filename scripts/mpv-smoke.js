"use strict";

const { MpvController } = require("../build/main/playback/mpv-controller");

async function main() {
  const events = [];
  const controller = new MpvController({
    serverUrl: "http://127.0.0.1:9",
    executable: process.env.MPV_PATH || "mpv",
    eventSink: (name, payload) => events.push({ name, payload }),
  });

  try {
    await controller.ensureStarted();
    if (!controller.status().ready) throw new Error("MPV did not report ready");
    controller.current = true;
    const trickplayId = await controller.beginTrickplay({
      count: 1,
      intervalMs: 1000,
      width: 1,
      height: 1,
      first: 0,
      total: 2,
    });
    if (!trickplayId) throw new Error("MPV rejected a valid trickplay window");
    await controller.appendTrickplay(trickplayId, new Uint8Array([0, 0, 0, 255]));
    await controller.commitTrickplay(trickplayId);
    await controller.command([
      "script-message-to",
      "thumbfast",
      "thumb",
      "1",
      "0",
      "0",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!events.some((event) => event.name === "trickplayNeed")) {
      throw new Error(
        `MPV trickplay provider did not respond: ${JSON.stringify(events)}`,
      );
    }
    await controller.clearTrickplay();
    controller.current = false;
    await controller.execute("volume", 50);
    await controller.execute("muted", true);
    await controller.execute("muted", false);
    await controller.command([
      "script-message",
      "jellyfin-dc-navigation",
      JSON.stringify({ previous: true, next: true }),
    ]);
    controller.pendingNavigation = { previous: true, next: true };
    await controller.command(["keypress", ">"]);
    await controller.command(["keypress", "<"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await controller.execute("fullscreen", true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await controller.execute("fullscreen", false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await controller.load({
      url: "http://127.0.0.1:9/noktus-mpv-smoke",
      startSeconds: 1.25,
      title: "Noktus MPV smoke test",
      fullscreen: false,
      audioTrack: 0,
      externalAudioUrl: null,
      subtitleStreamIndex: -1,
      subtitleTracks: [],
    });
    await controller.execute("stop");
    const fullscreenValues = events
      .filter((event) => event.name === "fullscreen")
      .map((event) => event.payload.value);
    if (!fullscreenValues.includes(true) || !fullscreenValues.includes(false)) {
      throw new Error(
        `MPV fullscreen observation failed: ${JSON.stringify(fullscreenValues)}`,
      );
    }
    if (!events.some((event) => event.name === "next")) {
      throw new Error(`MPV next-item binding failed: ${JSON.stringify(events)}`);
    }
    if (!events.some((event) => event.name === "previous")) {
      throw new Error(`MPV previous-item binding failed: ${JSON.stringify(events)}`);
    }
    console.log(`[Noktus] MPV IPC is ready via ${controller.status().executable}`);
    console.log("[Noktus] MPV fullscreen state is synchronized");
    console.log("[Noktus] MPV native OSD commands are accepted");
    console.log("[Noktus] MPV-to-Jellyfin control messages are accepted");
    console.log("[Noktus] MPV trickplay provider messages are accepted");
    console.log("[Noktus] MPV loadfile command is accepted");
  } finally {
    if (controller.status().ready) {
      await controller.command(["quit"]).catch(() => {});
    }
    controller.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
