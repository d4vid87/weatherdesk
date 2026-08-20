# Changelog

All notable changes to WeatherDesk. Versions follow [semantic versioning](https://semver.org),
and the format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every release ships desktop installers (Linux `.deb`, Windows, macOS), an arm64 `.deb` for the
Raspberry Pi, an Android APK, and the `ghcr.io/d4vid87/weatherdesk` container image.

## [Unreleased]

## [3.0.6] — 2026-08-20

### Fixed

- **Panels can be rearranged on a phone again.** At phone width the grips and the × were hidden
  outright, which left the Android app on a handset with no way to move or hide a panel at all.
  Settings → **Rearrange panels** now turns them on for that device until the app is closed.
  Resizing stays off there: a phone gives every panel the full width and its natural height, so a
  resize handle would drag against a rule it cannot win.

### Documentation

- New hero GIF walking through first-run setup, the Desk, warnings and radar, and the intro no
  longer describes WeatherDesk as Tempest-only ([#27], [#28])
- A full-Desk screenshot and a national-mosaic screenshot under the hero ([#29], [#31]); the old
  Desk screenshot is gone ([#30])

## [3.0.5] — 2026-08-19

### Added

- **Support for weather stations other than a Tempest** ([#26]). Ecowitt, Ambient Weather,
  Davis (WeatherLink Live), AcuRite via rtl_433, La Crosse and any console speaking the Weather
  Underground upload protocol all feed the same dashboard. With no station at all, WeatherDesk
  runs on a forecast for a place you name.

### Fixed

- The Desk lays out correctly on a phone-sized screen ([#23])
- Forecast-change notifications no longer repeat ([#24])
- Panel resizes no longer grew by the font-size zoom on every drag ([#25])

## [3.0.4] — 2026-08-18

### Added

- The Android app holds the screen awake, so a wall tablet stays on the dashboard ([#21])

## [3.0.3] — 2026-08-18

### Fixed

- The LAN dashboard renders on older tablet browsers ([#20])

## [3.0.2] — 2026-08-18

### Fixed

- Config sync no longer answers its own broadcast ([#19])

## [3.0.1] — 2026-08-18

### Changed

- The radar embed points at `hookecho.pages.dev` ([#17])

## [3.0.0] — 2026-08-17

### Added

- **SQLite archive with backfill** — observations persist locally and history is filled in from
  the station's own record
- **Live streaming** of observations to every open browser
- **Seasonal outlooks**

### Fixed

- The updater permission is desktop-only; requesting it broke the Android build

## [2.0.1] — 2026-08-17

### Fixed

- Storm auto is an in-memory override, so a crash mid-storm no longer pins the radar on

## [2.0.0] — 2026-08-17

### Added

- **Eco pacing** — polling and animation back off when nothing is watching
- **Observation log**
- **Alert rules**
- **Themes**
- **Public page** — a credential-stripped read-only dashboard at `/public`
- Nearby sensors are added automatically within a radius

## [1.3.1] — 2026-08-17

### Added

- A Settings toggle for the Desk radar, off on a fresh install

### Fixed

- The Desk radar no longer loads at boot

## [1.3.0] — 2026-08-16

### Added

- Big hero clock
- Network config sync — one host's settings and layout propagate to every browser
- Lab view persistence

### Fixed

- Metric precipitation label

## [1.2.0] — 2026-08-15

### Added

- UDP-only mode, for running with no cloud account
- Hideable tabs and panels

### Fixed

- Errors are surfaced instead of swallowed
- Device-history units

## [1.1.2] — 2026-08-14

### Fixed

- Start maximized on Linux; the resize nudge is gone ([#7])

## [1.1.1] — 2026-08-14

### Added

- Diagnostics reports the webview viewport ([#4])

### Fixed

- The webview picks up the startup resize ([#5])

## [1.1.0] — 2026-08-14

### Added

- Durable radar site selection
- MQTT / Home Assistant publishing
- Android build

### Fixed

- CI builds the APK directly instead of through `tauri-action` ([#3])

## [1.0.6] — 2026-08-14

### Added

- An arm64 `.deb` for the Raspberry Pi

## [1.0.5] — 2026-08-14

### Added

- Stale badges, local UDP feed, layout presets, and four new panels

## [1.0.4] — 2026-08-13

### Performance

- Polling and animation stop while nothing is on screen

## [1.0.3] — 2026-08-13

### Fixed

- The Desk radar loads on click

## [1.0.2] — 2026-08-13

### Removed

- The AppImage target

## [1.0.1] — 2026-08-13

### Fixed

- Settings survive a restart — the window loads from the asset protocol
- Release automation creates the draft once, before the build matrix runs

## [1.0.0] — 2026-08-13

First release. A self-hosted weather dashboard for your own weather station, built for a wall
tablet on the LAN — vanilla JS, no build step, no framework, no chart library.

### Added

- Turnkey desktop apps for Linux, Windows and macOS
- Movable, resizable panels and a drawn icon set
- Radar from [Hook Echo-WX](https://github.com/d4vid87/hookecho)
- MIT license

[Unreleased]: https://github.com/d4vid87/weatherdesk/compare/v3.0.6...HEAD
[3.0.6]: https://github.com/d4vid87/weatherdesk/compare/v3.0.5...v3.0.6
[3.0.5]: https://github.com/d4vid87/weatherdesk/compare/v3.0.4...v3.0.5
[3.0.4]: https://github.com/d4vid87/weatherdesk/compare/v3.0.3...v3.0.4
[3.0.3]: https://github.com/d4vid87/weatherdesk/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/d4vid87/weatherdesk/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/d4vid87/weatherdesk/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/d4vid87/weatherdesk/compare/v2.0.1...v3.0.0
[2.0.1]: https://github.com/d4vid87/weatherdesk/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/d4vid87/weatherdesk/compare/v1.3.1...v2.0.0
[1.3.1]: https://github.com/d4vid87/weatherdesk/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/d4vid87/weatherdesk/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/d4vid87/weatherdesk/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/d4vid87/weatherdesk/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/d4vid87/weatherdesk/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/d4vid87/weatherdesk/compare/v1.0.6...v1.1.0
[1.0.6]: https://github.com/d4vid87/weatherdesk/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/d4vid87/weatherdesk/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/d4vid87/weatherdesk/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/d4vid87/weatherdesk/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/d4vid87/weatherdesk/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/d4vid87/weatherdesk/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/d4vid87/weatherdesk/releases/tag/v1.0.0

[#3]: https://github.com/d4vid87/weatherdesk/pull/3
[#4]: https://github.com/d4vid87/weatherdesk/pull/4
[#5]: https://github.com/d4vid87/weatherdesk/pull/5
[#7]: https://github.com/d4vid87/weatherdesk/pull/7
[#17]: https://github.com/d4vid87/weatherdesk/pull/17
[#19]: https://github.com/d4vid87/weatherdesk/pull/19
[#20]: https://github.com/d4vid87/weatherdesk/pull/20
[#21]: https://github.com/d4vid87/weatherdesk/pull/21
[#23]: https://github.com/d4vid87/weatherdesk/pull/23
[#24]: https://github.com/d4vid87/weatherdesk/pull/24
[#25]: https://github.com/d4vid87/weatherdesk/pull/25
[#26]: https://github.com/d4vid87/weatherdesk/pull/26
[#27]: https://github.com/d4vid87/weatherdesk/pull/27
[#28]: https://github.com/d4vid87/weatherdesk/pull/28
[#29]: https://github.com/d4vid87/weatherdesk/pull/29
[#30]: https://github.com/d4vid87/weatherdesk/pull/30
[#31]: https://github.com/d4vid87/weatherdesk/pull/31
