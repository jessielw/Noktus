"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  installHistoryNavigation,
  navigateHistory,
} = require("../build/main/navigation");

function fixture(platform = "win32") {
  const calls = [];
  const window = new EventEmitter();
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.navigationHistory = {
    canGoBack: () => true,
    canGoForward: () => true,
    goBack: () => calls.push("back"),
    goForward: () => calls.push("forward"),
  };
  window.webContents = contents;
  installHistoryNavigation(window, platform);
  return { calls, window, contents };
}

test("navigates only when the requested history entry is available", () => {
  const { contents, calls } = fixture();
  contents.navigationHistory.canGoBack = () => false;
  navigateHistory(contents, "back");
  navigateHistory(contents, "forward");
  contents.isDestroyed = () => true;
  navigateHistory(contents, "forward");
  assert.deepEqual(calls, ["forward"]);
});

test("handles desktop shortcuts without consuming other Jellyfin keys", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const { contents, calls } = fixture(platform);
    let prevented = 0;
    const event = { preventDefault: () => prevented++ };
    const input = {
      type: "keyDown",
      key: platform === "darwin" ? "[" : "ArrowLeft",
      alt: platform !== "darwin",
      meta: platform === "darwin",
      shift: false,
      control: false,
      isComposing: false,
    };
    contents.emit("before-input-event", event, input);
    contents.emit("before-input-event", event, {
      ...input,
      key: platform === "darwin" ? "]" : "ArrowRight",
    });
    for (const extra of [
      { type: "keyUp" },
      { shift: true },
      { control: true },
      { isComposing: true },
      { alt: false, meta: false },
      { key: " " },
    ]) {
      contents.emit("before-input-event", event, { ...input, ...extra });
    }
    assert.deepEqual(calls, ["back", "forward"], platform);
    assert.equal(prevented, 2);
  }
});

test("handles mouse navigation commands without consuming unrelated commands", () => {
  const { window, calls } = fixture();
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  for (const command of ["browser-backward", "browser-forward", "volume-up"]) {
    window.emit("app-command", event, command);
  }
  assert.deepEqual(calls, ["back", "forward"]);
  assert.equal(prevented, 2);
});
