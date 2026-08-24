"use strict";

const form = document.getElementById("settings-form");
const playbackMode = document.getElementById("playback-mode");
const discordRichPresence = document.getElementById("discord-rich-presence");
const discordRichPresenceHelp = document.getElementById("discord-rich-presence-help");
const mpvSettings = document.getElementById("mpv-settings");
const mpvPath = document.getElementById("mpv-path");
const mpvPresentation = document.getElementById("mpv-presentation");
const mpvProfile = document.getElementById("mpv-profile");
const mpvProfileList = document.getElementById("mpv-profile-list");
const mpvProfileHelp = document.getElementById("mpv-profile-help");
const discoverMpvProfiles = document.getElementById("discover-mpv-profiles");
const mpvFullscreen = document.getElementById("mpv-fullscreen");
const browseMpv = document.getElementById("browse-mpv");
const testMpv = document.getElementById("test-mpv");
const mpvDiagnostic = document.getElementById("mpv-diagnostic");
const mpvDiagnosticTitle = document.getElementById("mpv-diagnostic-title");
const mpvDiagnosticDetail = document.getElementById("mpv-diagnostic-detail");
const mpvTrickplay = document.getElementById("mpv-trickplay");
const cancel = document.getElementById("cancel");
const save = document.getElementById("save");
const status = document.getElementById("status");
const version = document.getElementById("version");

function updateMpvState() {
  mpvSettings.classList.toggle("inactive", playbackMode.value !== "mpv");
}

function renderDiscordPresence(connection) {
  const details = {
    disabled: "Enable this to share title-only playback activity with Discord.",
    unconfigured: "Discord Rich Presence is not configured in this Noktus build.",
    connecting: "Connecting to Discord…",
    connected: "Connected to Discord. Playback will appear while playing.",
    unavailable: "Discord is not running or is unavailable. Noktus will retry quietly.",
  };
  discordRichPresenceHelp.textContent = details[connection] || details.unavailable;
}

function setBusy(value) {
  save.disabled = value;
  cancel.disabled = value;
  browseMpv.disabled = value;
  testMpv.disabled = value;
  discoverMpvProfiles.disabled = value;
}

function setStatus(message, kind = "error") {
  status.textContent = message;
  status.dataset.kind = message ? kind : "";
}

function errorMessage(error) {
  return String(error?.message || error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
}

function mpvSourceLabel(source) {
  return (
    {
      "command-line": "Command line override",
      environment: "Environment override",
      settings: "Configured executable",
      path: "System PATH",
      common: "Standard install location",
      unresolved: "Not found",
    }[source] || "Detected executable"
  );
}

function renderMpvDiagnostic(diagnostic) {
  if (!diagnostic) {
    mpvDiagnostic.dataset.kind = "pending";
    mpvDiagnosticTitle.textContent = "Player selection not checked";
    mpvDiagnosticDetail.textContent = "Use Check Player to verify this executable.";
    return;
  }

  mpvDiagnostic.dataset.kind =
    diagnostic.available && diagnostic.supported
      ? "success"
      : diagnostic.available
        ? "warning"
        : "error";
  mpvDiagnosticTitle.textContent = diagnostic.available
    ? diagnostic.supported
      ? `${diagnostic.provider === "mpv.net" ? "mpv.net" : "MPV"} ${diagnostic.version} is available`
      : `${diagnostic.provider === "mpv.net" ? "mpv.net" : "MPV"} ${diagnostic.version} could not be validated`
    : "MPV player is unavailable";
  const source = `${mpvSourceLabel(diagnostic.source)}: ${diagnostic.executable}`;
  const ignored = diagnostic.configuredPathIgnored
    ? "The saved path was unavailable; Noktus selected a fallback. "
    : "";
  mpvDiagnosticDetail.textContent = diagnostic.available
    ? `${ignored}${source}${diagnostic.supported ? "" : `. ${diagnostic.reason}`}`
    : `${source}. ${diagnostic.reason}`;
}

// Reported by the injected player after the last MPV playback, so users can tell
// "the server has no thumbnails" apart from "Noktus could not load them".
const TRICKPLAY_LABELS = {
  off: "Trickplay previews are off while Controls uses your own MPV configuration.",
  unsupported: "Trickplay previews are not available on mpv.net.",
  "no-manifest": "No trickplay previews: the server had none for the last item played.",
  error: "Trickplay previews failed on the last item played.",
  ready: "Trickplay previews loaded for the last item played.",
};

function renderTrickplay(trickplay) {
  const label = trickplay && TRICKPLAY_LABELS[trickplay.state];
  if (!label) {
    mpvTrickplay.hidden = true;
    mpvTrickplay.textContent = "";
    return;
  }
  mpvTrickplay.hidden = false;
  mpvTrickplay.textContent = trickplay.detail ? `${label} ${trickplay.detail}` : label;
}

async function initialize() {
  try {
    const settings = await window.settingsApi.load();
    discordRichPresence.checked = settings.discordRichPresenceEnabled;
    renderDiscordPresence(settings.discordPresenceConnection);
    playbackMode.value = settings.playbackMode;
    mpvPath.value = settings.mpvPath || "";
    mpvPresentation.value = settings.mpvPresentation;
    mpvProfile.value = settings.mpvProfile || "";
    mpvFullscreen.checked = settings.startMpvFullscreen;
    renderMpvDiagnostic(settings.mpvDiagnostic);
    renderTrickplay(settings.trickplay);
    version.textContent = `Noktus ${settings.appVersion}`;
    updateMpvState();
    playbackMode.focus();
  } catch (error) {
    setStatus(`Could not load settings: ${errorMessage(error)}`);
    setBusy(true);
  }
}

playbackMode.addEventListener("change", updateMpvState);
mpvPath.addEventListener("input", () => renderMpvDiagnostic(null));
cancel.addEventListener("click", () => window.close());
browseMpv.addEventListener("click", async () => {
  setStatus("");
  try {
    const selected = await window.settingsApi.browseMpv();
    if (selected) {
      mpvPath.value = selected;
      renderMpvDiagnostic(null);
    }
  } catch (error) {
    setStatus(`Could not select MPV: ${errorMessage(error)}`);
  }
});

testMpv.addEventListener("click", async () => {
  setStatus("Checking player...", "pending");
  setBusy(true);
  try {
    const diagnostic = await window.settingsApi.testMpv(mpvPath.value);
    renderMpvDiagnostic(diagnostic);
    if (diagnostic.available && diagnostic.supported) {
      setStatus(
        `${diagnostic.provider === "mpv.net" ? "mpv.net" : "MPV"} ${diagnostic.version} executable check passed.`,
        "success",
      );
    } else if (diagnostic.available) {
      setStatus(
        `${diagnostic.provider === "mpv.net" ? "mpv.net" : "MPV"} ${diagnostic.version} runs, but ${diagnostic.reason.toLowerCase()}.`,
      );
    } else {
      setStatus(`Player check failed: ${diagnostic.reason}`);
    }
  } catch (error) {
    renderMpvDiagnostic(null);
    setStatus(`Could not check player: ${errorMessage(error)}`);
  } finally {
    setBusy(false);
  }
});

discoverMpvProfiles.addEventListener("click", async () => {
  setStatus("Discovering MPV profiles...", "pending");
  setBusy(true);
  mpvProfileList.replaceChildren();
  try {
    const discovery = await window.settingsApi.listMpvProfiles(mpvPath.value);
    for (const profile of discovery.profiles) {
      const option = document.createElement("option");
      option.value = profile.name;
      option.label = profile.description || profile.name;
      mpvProfileList.append(option);
    }
    if (discovery.profiles.length > 0) {
      mpvProfileHelp.textContent = `${discovery.profiles.length} selectable profile${discovery.profiles.length === 1 ? "" : "s"} found. You can also enter a profile name manually.`;
      setStatus("MPV profiles discovered.", "success");
    } else {
      mpvProfileHelp.textContent = `${discovery.reason}. You can still enter a profile name manually.`;
      setStatus("No profiles were added; manual entry remains available.");
    }
  } catch (error) {
    mpvProfileHelp.textContent =
      "Profile discovery failed. You can still enter a profile name manually.";
    setStatus(`Could not discover profiles: ${errorMessage(error)}`);
  } finally {
    setBusy(false);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Saving settings...", "pending");
  setBusy(true);
  try {
    await window.settingsApi.save({
      playbackMode: playbackMode.value,
      discordRichPresenceEnabled: discordRichPresence.checked,
      mpvPath: mpvPath.value,
      mpvPresentation: mpvPresentation.value,
      mpvProfile: mpvProfile.value,
      startMpvFullscreen: mpvFullscreen.checked,
    });
    setStatus("Settings saved.", "success");
  } catch (error) {
    setStatus(errorMessage(error));
    setBusy(false);
  }
});

initialize();
