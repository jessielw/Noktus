import type { BrowserWindow, WebContents } from "electron";

export type HistoryDirection = "back" | "forward";

export function navigateHistory(
  contents: WebContents,
  direction: HistoryDirection,
): void {
  if (contents.isDestroyed()) return;
  const history = contents.navigationHistory;
  if (direction === "back" && history.canGoBack()) history.goBack();
  if (direction === "forward" && history.canGoForward()) history.goForward();
}

export function installHistoryNavigation(
  window: BrowserWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  const contents = window.webContents;
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isComposing || input.shift || input.control) {
      return;
    }
    const modifier =
      platform === "darwin" ? input.meta && !input.alt : input.alt && !input.meta;
    if (!modifier) return;
    const back = platform === "darwin" ? "[" : "ArrowLeft";
    const forward = platform === "darwin" ? "]" : "ArrowRight";
    if (input.key !== back && input.key !== forward) return;
    event.preventDefault();
    navigateHistory(contents, input.key === back ? "back" : "forward");
  });
  // Windows and Linux deliver mouse navigation buttons as application commands.
  window.on("app-command", (event, command) => {
    if (command !== "browser-backward" && command !== "browser-forward") return;
    event.preventDefault();
    navigateHistory(contents, command === "browser-backward" ? "back" : "forward");
  });
}
