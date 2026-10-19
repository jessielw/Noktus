import { contextBridge, ipcRenderer } from "electron";
import type { SettingsBridge } from "../shared/types";

const settingsBridge: SettingsBridge = {
  forgetSeriesTracks: (key) =>
    ipcRenderer.invoke("jdc:settings:forget-series-tracks", key),
  load: () => ipcRenderer.invoke("jdc:settings:load"),
  save: (settings) => ipcRenderer.invoke("jdc:settings:save", settings),
  browseMpv: () => ipcRenderer.invoke("jdc:settings:browse-mpv"),
  testMpv: (path) => ipcRenderer.invoke("jdc:settings:test-mpv", path),
  listMpvProfiles: (path) => ipcRenderer.invoke("jdc:settings:list-mpv-profiles", path),
};

contextBridge.exposeInMainWorld("settingsApi", settingsBridge);
