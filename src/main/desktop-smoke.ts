import {
  app,
  dialog,
  Menu,
  shell,
  type BrowserWindow,
  type MessageBoxOptions,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Desktop smoke timed out: ${label}`);
}

export async function runDesktopSmoke(
  window: BrowserWindow,
  ready: Promise<void>,
  showSettings: () => BrowserWindow,
): Promise<void> {
  await ready;
  const contents = window.webContents;
  for (const id of [
    "noktus-back",
    "noktus-forward",
    "noktus-releases",
    "noktus-report-issue",
  ]) {
    if (!Menu.getApplicationMenu()?.getMenuItemById(id)) {
      throw new Error(`Missing desktop menu action: ${id}`);
    }
  }
  if (process.platform !== "darwin") {
    const quit = Menu.getApplicationMenu()?.getMenuItemById("noktus-quit");
    if (quit?.role !== "quit" || quit.accelerator !== "CmdOrCtrl+Q") {
      throw new Error("Missing standard Quit menu action or shortcut");
    }
  }
  // Exercise the real menu boundary without opening a browser or blocking on a dialog.
  const originalOpenExternal = shell.openExternal;
  const originalShowMessageBox = dialog.showMessageBox;
  const errorDialogs: MessageBoxOptions[] = [];
  try {
    dialog.showMessageBox = (async (
      ownerOrOptions: BrowserWindow | MessageBoxOptions,
      options?: MessageBoxOptions,
    ) => {
      if (ownerOrOptions !== window || !options) {
        throw new Error("Menu error dialog must belong to the main window");
      }
      errorDialogs.push(options);
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    for (const synchronous of [false, true]) {
      shell.openExternal = () => {
        const error = new Error("Browser unavailable: ?api_key=do-not-show");
        if (synchronous) throw error;
        return Promise.reject(error);
      };
      const expectedCount = errorDialogs.length + 1;
      Menu.getApplicationMenu()!.getMenuItemById("noktus-releases")!.click();
      await waitFor(() => errorDialogs.length === expectedCount, "Menu error dialog");
      const options = errorDialogs.at(-1)!;
      if (
        options.type !== "error" ||
        options.message !== "View releases failed." ||
        !options.detail?.includes("Browser unavailable") ||
        options.detail.includes("do-not-show")
      ) {
        throw new Error("Menu failure did not produce a useful, redacted error dialog");
      }
    }
  } finally {
    shell.openExternal = originalOpenExternal;
    dialog.showMessageBox = originalShowMessageBox;
  }
  // Use Jellyfin-style same-document routes, so history is tested without page reloads.
  await contents.executeJavaScript(
    "history.pushState({}, '', '#one'); history.pushState({}, '', '#two')",
    true,
  );
  await waitFor(
    () => Boolean(Menu.getApplicationMenu()?.getMenuItemById("noktus-back")?.enabled),
    "Back menu enabled",
  );
  Menu.getApplicationMenu()!.getMenuItemById("noktus-back")!.click();
  await waitFor(() => contents.getURL().endsWith("#one"), "Back menu navigation");
  await waitFor(
    () =>
      Boolean(Menu.getApplicationMenu()?.getMenuItemById("noktus-forward")?.enabled),
    "Forward menu enabled",
  );
  const mac = process.platform === "darwin";
  window.focus();
  contents.sendInputEvent({
    type: "keyDown",
    keyCode: mac ? "]" : "Right",
    modifiers: [mac ? "meta" : "alt"],
  });
  contents.sendInputEvent({
    type: "keyUp",
    keyCode: mac ? "]" : "Right",
    modifiers: [mac ? "meta" : "alt"],
  });
  await waitFor(
    () => contents.getURL().endsWith("#two"),
    "Forward keyboard navigation",
  );
  window.emit("app-command", { preventDefault() {} }, "browser-backward");
  await waitFor(() => contents.getURL().endsWith("#one"), "Mouse Back navigation");

  const settings = showSettings();
  await waitFor(
    () =>
      settings.webContents.executeJavaScript(
        "Boolean(document.querySelector('#series-track-list button'))",
      ),
    "Saved series rendered",
  );
  await waitFor(() => settings.isVisible(), "Settings visible");
  await settings.webContents.executeJavaScript(`(async () => {
    document.getElementById('series-track-preferences').open = true;
    document.querySelector('#series-track-preferences summary').focus();
    document.getElementById('series-track-preferences').scrollIntoView();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const screenshotDirectory = path.join(app.getAppPath(), "out");
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  const screenshot = await settings.webContents.capturePage();
  fs.writeFileSync(
    path.join(screenshotDirectory, "desktop-settings-smoke.png"),
    screenshot.toPNG(),
  );
  await settings.webContents.executeJavaScript(
    "document.querySelector('#series-track-list button').click()",
  );
  await waitFor(
    () =>
      settings.webContents.executeJavaScript(
        "document.querySelectorAll('#series-track-list button').length === 1 && !document.getElementById('save').disabled",
      ),
    "Single-series reset",
  );
  const report = await settings.webContents.executeJavaScript(`(async () => {
    const remaining = (await window.settingsApi.load()).seriesTrackRules;
    let invalidRejected = false;
    try { await window.settingsApi.forgetSeriesTracks({seriesId: 'series-one'}); }
    catch { invalidRejected = true; }
    return {
      remaining: remaining.map(rule => rule.userId),
      invalidRejected,
      success: document.getElementById('status').dataset.kind === 'success',
    };
  })()`);
  if (
    JSON.stringify(report.remaining) !== '["user-two"]' ||
    !report.invalidRejected ||
    !report.success
  ) {
    throw new Error(`Series reset failed: ${JSON.stringify(report)}`);
  }
  // Cancel must leave the reset persisted while discarding unrelated form edits.
  await settings.webContents.executeJavaScript(
    "document.getElementById('mpv-path').value = 'unsaved-player'; document.getElementById('cancel').click()",
  );
  await waitFor(() => settings.isDestroyed(), "Settings closed");
  const persisted = JSON.parse(
    fs.readFileSync(path.join(app.getPath("userData"), "settings.json"), "utf8"),
  );
  if (
    persisted.seriesTrackRules.length !== 1 ||
    persisted.mpvPath === "unsaved-player"
  ) {
    throw new Error("Reset persistence or cancel behavior failed");
  }
  const reopened = showSettings();
  await waitFor(
    () =>
      reopened.webContents.executeJavaScript(
        "document.querySelectorAll('#series-track-list button').length === 1",
      ),
    "Reset survives reopening",
  );
  await reopened.webContents.executeJavaScript(
    "document.querySelector('#series-track-list button').click()",
  );
  await waitFor(
    () =>
      reopened.webContents.executeJavaScript(
        "document.getElementById('series-track-list').textContent === 'No remembered series tracks.'",
      ),
    "Empty preferences state",
  );
  console.log(
    "[Noktus] Desktop smoke passed: history menu, keyboard and mouse navigation; Help actions, menu error dialogs and Quit action; per-account series reset, validation, persistence, cancel and empty state.",
  );
}
