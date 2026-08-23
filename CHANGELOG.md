# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
