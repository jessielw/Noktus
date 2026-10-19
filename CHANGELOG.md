# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.11] - 2026-10-18

### Added

- Native recap and preview skip prompts when Jellyfin provides those media segments.
- Back and forward navigation through the View menu, Alt+Left / Alt+Right (Command+[ /
  Command+] on macOS), and mouse navigation buttons on Windows and Linux.
- Remembered series tracks in Settings, with individual resets for each server, Jellyfin
  account, and series.
- View releases and Report an issue links in the Help menu.
- Quit action with Ctrl+Q in the Application menu on Windows and Linux, using the
  existing graceful playback shutdown.

### Changed

- Advertise Noktus in the playback activity on Jellyfin instead of the underlying
  framework name.
- Rename player/profile to Noktus MPV.
- Identify Chromium codec reports in the menu, dialog, logs, and copied diagnostics;
  explain capability results and clarify that MPV, hardware decoding, and actual file
  playback are not tested.
- Keep page titles branded with Noktus throughout.
- Expand keyboard shortcut help with common MPV playback, track, subtitle, and
  statistics controls, with a note about custom bindings and mpv.net.

### Fixed

- Restore saved MPV volume, including zero, before playback starts and remember volume
  adjustments made inside MPV for later sessions.
- Show errors from menu actions in a dialog instead of only logging them.

## [0.1.10] - 2026-10-13

### Fixed

- MPV playback on macOS no longer fails with `connect EINVAL`. The IPC socket path was
  longer than the 103-byte macOS limit, so it is now shorter and falls back to `/tmp`
  when a long `TMPDIR` would push it over.

## [0.1.9] - 2026-10-01

### Changed

- Updated several dependencies.

### Fixed

- macOS bundles are ad-hoc signed after packaging, with signature verification before
  release archives are uploaded.

## [0.1.8] - 2026-08-27

### Changed

- Improved logging.

## [0.1.7] - 2026-08-23

### Fixed

- mpv.net lost its on-screen controller and seekbar under the Noktus controls preset
- mpv.net now loads every Noktus script, not just the last one passed to it
- Trickplay metadata is read from the current Jellyfin item route, not the deprecated
  one
- Thumbnail overlays are cleared when MPV's OSC visibility is set to `never`
- The controls preset no longer sends `osc-fadein`, which MPV logged as an unknown
  option
- MPV keybinds and menu entries for `osc/visibility` work again under the controls
  preset

### Changed

- mpv.net keeps its own on-screen controller, so trickplay previews are MPV only
- Trickplay previews use the sharpest thumbnail size that fits, instead of the smallest
- Settings shows whether the last MPV playback got trickplay previews, and why not

## [0.1.6] - 2026-08-23

### Fixed

- MPV playback for HTTP and HTTPS media referenced by Jellyfin `.strm` files

## [0.1.5] - 2026-08-22

### Added

- Bounded Jellyfin trickplay thumbnail previews for the Noktus MPV controls preset
- Discord rich presence (can opt out in settings)

### Fixed

- Jellyfin inline playback can enter Electron fullscreen through its fullscreen control

## [0.1.4] - 2026-08-03

### Changed

- MPV overlay controls now follow the active display's system scaling

## [0.1.3] - 2026-08-03

### Added

- MPV profiles in settings
- Now automatically remembers last used audio/subtitle track (with the option to clear
  this) in series

### Changed

- Fallback Jellyfin API requests use the standard MediaBrowser Authorization scheme

## [0.1.2] - 2026-07-27

### Added

- MPV/mpv.net now shows external subtitles for selection

## [0.1.1] - 2026-07-27

### Changed

- Icon

## [0.1.0] - 2026-07-26

### Changed

- Changed name of project from Deskfin to Noktus

## [0.1.0-beta.3] - 2026-07-26

### Added

- MPV.net support
- Skip intro/outro through mpv/mpv.net
- View menu now includes standard zoom controls
- Added 'Open current page in browser' and 'Copy current page link'
- Links retain the Jellyfin route while removing credentials and auth tokens
- Added Help → Keyboard shortcuts

### Changed

- Children windows now open on the screen based on the parent Noktus window

### Fixed

- Long executable description on hover/taskbar

## [0.1.0-beta.2] - 2026-07-24

### Fixed

- MPV launching when not in fullscreen mode could sometimes go rogue/not launch at all
