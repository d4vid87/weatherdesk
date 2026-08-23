# Changelog

All notable changes to WeatherDesk. Versions follow [semantic versioning](https://semver.org),
and the format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every release ships desktop installers (Linux `.deb`, Windows, macOS), an arm64 `.deb` for the
Raspberry Pi, an Android APK, and the `ghcr.io/d4vid87/weatherdesk` container image.

## [3.1.1] — 2026-08-23

Three things testers wrote in about, and the elevation setting the barometer always wanted.

### Fixed
- E-ink palette: the hero (and with it the clock) was white text on a white card, because the
  palette strips background images and the hero's colour lived only in a gradient. It now paints
  in the palette's own ink with a border, like every other e-ink panel.
- Eco mode's clock pace and seconds format were read once at load, so the toggle did nothing
  until a reload. The clock job re-registers on every settings change.
- Place search in the setup wizard looked dead: the results rendered below the fold of the
  wizard's scroll box, and a ZIP match was labelled "06092, Connecticut, United States" with the
  town nowhere in sight. Results scroll into view, labels carry the town, and the search is
  biased to your language and the location already on file.
- Polled stations (Davis WeatherLink Live and friends) showed the forecast model's wind on the
  gauges between forecast fetches — five minutes of somebody else's weather. Every observation
  now repaints the cached forecast with the station's own reading.
- A leftover Tempest device ID from an earlier setup beat the current brand when loading three
  hours of history, which is what left the hero reading "999m old". Brand wins, and switching
  brands clears the stale ID.
- `/diag` called the healthy state "throttled" — the WeatherLink poll runs faster than the
  archive's write gate by design. It now says so in words that don't look like a fault.

### Added
- Station elevation in Settings, in feet or metres to match your units. Only the barometer uses
  it: a station reading is reduced to sea level before it is shown, and doing that with the
  forecast model's elevation for the grid square instead of yours is why the dashboard and the
  console disagreed by a few hundredths of an inch.
- The live wind card says "1-min avg · polled" for brands that are polled. Only a Tempest hub
  broadcasts true three-second wind; resending a one-minute average every ten seconds is not a
  fast needle and shouldn't look like one.
- Settings warns when two consoles are writing into one archive with no ingest key set — their
  rows interleave and the trends read as noise.

## [3.1.0] — 2026-08-22

### Added
- Animated hero: rain, snow, drifting cloud and lightning drawn behind the numbers, keyed to the
  current conditions icon. Off entirely in eco mode and while the tab is hidden.
- Countdown to the next solar event on the hero ("Sunset in 1h 14m"), and visibility beside
  feels-like when the forecast source reports it.
- Source health dots at the end of the ticker — one per station source the LAN server holds,
  hover for its `/diag` line. Hidden where there is no server.
- Region presets (US/UK/EU/CA/AU) and a 12/24-hour clock setting, honoured by every time on the
  page including the big clock.
- "Why this forecast" — model timing, spread and station edge as one sentence above the model
  agreement rows — plus a trust badge from this install's own verification record.
- Kiosk mode: one switch for fullscreen, locked layout, hidden header and a screen wake lock.
  `k` toggles it; Escape, `f` or three taps on the clock leave it.

### Fixed
- A severe-weather banner now comes down when the warning expires, and a continued NWS warning
  no longer re-chimes every five minutes — the dedupe key is the warning, not its id (#38 sibling).
- A 401 on someone else's Tempest station now says the station isn't shared publicly instead of
  blaming your token (#38).
- **The barometer shows your barometer.** A station's own pressure reading is measured where it
  stands; every console quotes it reduced to sea level, and the gauge was quietly falling back to
  the model's sea-level pressure instead. Non-Tempest readings are now reduced using the station's
  elevation, which is the two-hundredths of an inch that made the dashboard look wrong next to a
  Davis or an Ecowitt console.
- **Self-check no longer probes WeatherFlow on installs that have no Tempest** — an Ambient or a
  Davis owner saw two red rows and reasonably read them as a broken app. It now checks the local
  station instead, and says so when nothing has reported in the last hour (#37).
- **The first-run wizard stops leading with a Tempest token.** Both routes are visible from the
  start and the other-brand section opens by default; nothing autofocuses the token field.
- **The phone app now says a console can't upload to it** instead of showing an address on
  `tauri://localhost` that nothing on the network can reach, and points at the cloud sources.

### Security
- **A crafted `/ingest` body no longer takes the server down.** A `%` in front of a multi-byte
  character put a string slice mid-character and panicked the worker thread that was handling it;
  four such requests left nothing answering on 8088 while the container stayed up and the archive
  kept filling, so it read as a network fault rather than a crash. `/ingest` takes no credentials
  by default, so anyone on the LAN could send them. Thanks to @parallaxintelligencepartnership
  (#48).
- **The container no longer runs as root.** Both ports are above 1024 and `/data` is the only path
  written, so the image runs as uid 1000. **Upgrading an install that bind-mounts a host directory
  needs a one-time `sudo chown -R 1000:1000 ./data`** — a root-owned data directory otherwise
  leaves the dashboard serving normally while storing nothing. Thanks to
  @parallaxintelligencepartnership (#49).

### Documentation
- WeeWX connects with no plugin: point its Weather Underground uploader at `/ingest` (#47).

## [3.0.9] — 2026-08-21

Everything here came out of what people reported after 3.0.8.

### Fixed

- **A station no longer stops reporting after the first reading.** One throttle was shared by every
  source, and it compared the timestamp inside the report rather than the clock on this machine. A
  console set even slightly ahead of real time — a WeatherLink Live is the one people hit — parked
  that throttle in the future, and every later reading was dropped until the app was restarted. The
  gate is now per source and runs on our own clock, so a wrong console clock can't stall it, and a
  push station and a polled one no longer starve each other. Report timestamps are clamped to
  within ten minutes of now, so a badly set console can't scatter rows across the archive either.
- **Consoles that upload on a different path are answered.** Weather Underground clones — Vevor,
  Sainlogic, Fine Offset and the rest — vary in where they post: with and without the
  `/weatherstation/` prefix, with and without a trailing slash on `/data/report`. All of them reach
  the ingest route now instead of a 404.
- **Placeholders stop claiming a Tempest token is required.** Panels that only need a location said
  "Needs a Tempest token", which sent people off to open accounts they never needed. They now say
  what is actually missing, and an install with only a saved place gets its forecast, ten-day and
  story — those come from open-meteo, free and worldwide.
- Failed station polls say what went wrong. A timeout or a refused connection was silent; it now
  logs the failure kind (never the URL — these carry API keys).

### Added

- **The running version is on screen**, beside Settings → Check for updates, and comes from the
  build rather than a string in the page that went stale two releases ago.
- **Station reporting**, under Settings: what each source last did, how many rows it has stored and
  how long ago. Answers "is my console actually getting through?" without a log file, and a
  screenshot of it answers most of a bug report.
- **Re-upload to Weather Underground and PWSWeather.** A console holds one upload address, so
  pointing it at WeatherDesk takes it off whichever network it was on. Put the station ID and key
  for either service under Settings → This computer and each reading is sent on once a minute.
- **A WBGT gauge** — the heat-stress number that accounts for sun and wind, which the heat index
  doesn't. Estimated from temperature, humidity, solar and wind, and labelled as an estimate: the
  real instrument is a black globe on a stand.
- **Airports can be added by code.** Type an ICAO like `KBDL` under Nearby stations for anywhere the
  radius scan doesn't reach, and it survives later scans. **Reset dismissed** brings back an airport
  that was closed with its ×.
- **A Help section in Settings**: per-brand setup, what version you're on and how to update, how to
  restore a panel you closed, where the forecasts come from, reading the dashboard on an iPad or
  phone, Docker, and what to do when Defender quarantines the installer.

### Changed

- The hidden-panel list has its own heading and names panels the way the page does, instead of
  sitting unlabelled below the saved layouts showing raw ids.
- Every release now publishes `SHA256SUMS.txt`, so an installer can be checked against it — and
  each Windows build is reported to Microsoft as a false detection.
- Bug reports have a template that asks for the version, install type and station brand up front.

## [3.0.8] — 2026-08-20

### Fixed

- **A group of panels can be moved as a group.** The gauges block, the day cards and the Desk grid
  are panels in their own right, but their drag grip sat at the top right — exactly where the last
  panel in the group's first row puts its own, which covered it. A group's grip and × now sit at
  the top left, where nothing else lands.
- **Any panel can be dragged to any part of the Desk, including the top.** A panel used to be
  trapped in the container it started in, so a card in the Desk grid could be reordered among its
  neighbours but could never be lifted above the gauges or up beside the hero. A drag now lands in
  whichever container the pointer is over, innermost first, and the new home is saved with the
  layout. Dropping a panel into a different grid clears a width that was measured against the old
  one.

## [3.0.7] — 2026-08-20

### Fixed

- Rearrange mode now actually shows the grips in the Android app. The rules that reveal them were
  scoped inside the phone media query in 3.0.6; they are keyed on the mode alone now, so nothing
  about how a given webview reports its width can swallow them.

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

[Unreleased]: https://github.com/d4vid87/weatherdesk/compare/v3.0.9...HEAD
[3.0.9]: https://github.com/d4vid87/weatherdesk/compare/v3.0.8...v3.0.9
[3.0.8]: https://github.com/d4vid87/weatherdesk/compare/v3.0.7...v3.0.8
[3.0.7]: https://github.com/d4vid87/weatherdesk/compare/v3.0.6...v3.0.7
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
