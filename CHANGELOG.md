# Changelog

All notable changes to WeatherDesk. Versions follow [semantic versioning](https://semver.org),
and the format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every release ships desktop installers (Linux `.deb`, Windows, macOS), an arm64 `.deb` for the
Raspberry Pi, an Android APK, and the `ghcr.io/d4vid87/weatherdesk` container image.

## [Unreleased]

## [3.3.0] - 2026-09-03

### Added
- **Motion, as a setting.** Settings → Motion picks `Auto`, `Full`, `Lite` or `Off`. Auto is Full
  on a desktop and Lite on the hardware eco mode already calls slow (a wall tablet, a 4 GB
  Chromebook). `prefers-reduced-motion` and the e-ink palette force Off, and `?motion=` overrides
  everything for one page load. Eco mode is now only about polling rate.
- **The hero is a sky.** The gradient behind the numbers is interpolated from the station's own
  sunrise and sunset rather than snapped between five presets, and at Full a sun or a phased moon
  rides its real arc across the panel.
- **Vendored Meteocons** (MIT, Bas Milius) for every condition glyph — animated at Full, static
  at Lite and Off.
- **Barlow Semi Condensed**, bundled, for the clock, the hero temperature and every gauge readout.
  Tabular figures, so a counting number does not shuffle the line it sits on.
- **Broadcast choreography.** Numbers count to their new value and flash as they land, gauge
  needles swing (the short way round), panels swoosh in behind a band of light on a tab change,
  and rearranging the layout animates instead of jumping.
- **A severe-weather crawl.** Under a Severe or Extreme warning the signal ticker becomes the red
  alert crawl, carrying the event and its headline.
- **Severe and emergency alerts are read aloud**, on by default. Only Severe and Extreme (and any
  headline carrying the word *emergency*) — the routine advisories that used to be read out are
  not. If the browser refuses to speak before the page has been touched, the announcement is held
  and made on the first tap.

### Changed
- Gauges, day cards and the hero are built once and updated in place. The 48-hour chart and the
  ticker skip writes that would produce identical markup.
- `Eco mode` in Settings is labelled "slower polling"; the animation half of it moved to Motion.
- Static assets carry an `ETag` and a cache policy: fonts and icons for a week, code and markup
  always revalidated.

### Fixed
- Saving settings repeatedly left a WebSocket (and a reconnect timer) per save, and `/events`
  left an `EventSource` per init.
- Several panels registered their event listeners again on every settings save, so one
  observation triggered several renders.
- The detail slide-over raced itself when two metrics were opened quickly, and its Escape key
  also dropped the dashboard out of kiosk mode.
- Charts read two CSS variables that do not exist (`--bg-2`, `--fg`), reallocated their bitmap on
  every hover frame, and kept a stale bitmap after a resize.
- The 10-day board compared NWS periods against the wrong day whenever the forecast started with
  "Tonight"; the 7-day precipitation outlook plotted every bar a day early west of Greenwich.
- The Fire card printed millimetres under an inches label; forecast snapshots and verifications
  are now tagged with the units they were recorded in.
- The AQI card showed midnight's value after 23:00; a single missing hour blanked the 48-hour
  temperature line; muggy wording and the day-card arc were pinned to °F.
- Layout presets could permanently hide the severe, winter and tropical cards.
- A negative refresh interval was accepted and became a busy loop.
- The Home Assistant panel kept polling after its entity list was cleared, and two quick saves
  could leave an orphaned MQTT client publishing.
- The service worker's "never cache" list missed `/api`, `/ha`, `/alerts` and `/discover`.
- The radar panel says so when the viewer is unreachable, and its camera is persisted on a 5 s
  debounce instead of once a second.

### Performance
- Repainting the Desk from a station observation (the common case, once per `refreshSec`):
  **8.4 ms → 7.4 ms** per render, measured headless over 120 renders at Lite. Full motion costs
  about 1.5 ms more per render than Lite by design — that is what the setting is for.
- One in-flight/30-second memo in front of `getJSON`, so the panels that ask for the same URL at
  the same moment share one request.
- `localStorage` writes are skipped when the payload is byte-identical.
- Boot no longer blocks the whole module graph on a config fetch, and the graph is `modulepreload`ed.
- Server: one kept-open SQLite writer instead of a fresh connection per reading, a cached settings
  file, `MIN/MAX(ts)` instead of `COUNT(*)` behind `/history/daily`, and a 5 s deadline on
  `/ha/states`.

## [3.2.3] - 2026-08-31

### Fixed
- **Blank window on some Linux GPU/compositor combinations** (seen on Hyprland with Intel UHD
  600 graphics): WeatherDesk started and ran, but never drew anything. WebKitGTK's DMABUF
  renderer is now disabled by default on Linux. Export
  `WEBKIT_DISABLE_DMABUF_RENDERER=0` to force the old behaviour back on.

## [3.2.2] - 2026-08-30

### Fixed
- **Relaunching while WeatherDesk was already running crashed the old instance.** Each new
  launch tore down the previous instance's UI process, and its WebKit web process — busy in
  JavaScript — missed WebKit's shutdown deadline and was killed with SIGTRAP, leaving a core
  dump behind. WeatherDesk is now single-instance: a second launch focuses the window that is
  already open and exits.

## [3.2.1] - 2026-08-30

### Added
- **A Linux AppImage, and with it a Linux updater that actually works.** The in-app updater can
  only install an AppImage on Linux, and no release shipped one — every "check for updates"
  click on Linux was a path that could not complete. x86_64 releases now bundle an AppImage and
  `latest.json` points the updater at it. On a `.deb` (or any non-AppImage) install the updater
  now says to update through the package manager instead of failing.
- **A designed default layout.** A fresh install, a new browser and the reset button all land on
  a designed arrangement — current conditions, gauges, day cards, radar, then the core four
  cards — instead of raw markup order. Saved arrangements still win; only the starting point
  changed.
- **`--version` and `--check`.** `weatherdesk --check` asks the running server for its source
  and the age of the last reading, and exits non-zero if nothing has landed — a headless Pi
  install no longer needs a browser to be verified.
- **WeeWX, documented.** WeeWX's Weather Underground uploader pointed at
  `/updateweatherstation.php` feeds WeatherDesk today; [docs/weewx.md](docs/weewx.md) has the
  five-line stanza (#47).

### Fixed
- **Switching station brands now really leaves Tempest behind (#37).** Choosing a non-Tempest
  brand cleared the device ID but left the token and station ID, so the forecast kept coming
  from WeatherFlow. All three are cleared on a brand switch, and the forecast routes to
  open-meteo whenever a non-Tempest source is set, even over a stale token.
- **A public Tempest station that returns 401 says why (#38).** WeatherFlow only serves a
  station's data to its owner's token; the wizard and diagnostics now say so where the ID was
  typed, instead of a bare 401.

### Security
- **The `rustls-webpki` advisory in our dependency tree is not reachable from WeatherDesk, and there
  is now a written record of why.** The affected 0.102.8 comes in twice, both times under `rumqttc`,
  the MQTT publisher; the panic it describes (RUSTSEC-2026-0104 / GHSA-82j2-j2ch-gfr8) is in CRL
  parsing, code that runs only for a revocation list the application hands it, and WeatherDesk hands
  it none — TLS is configured in exactly two places, both a bare
  `Transport::tls_with_default_config()`. No upgrade exists yet: the fix is in 0.103.13, there is no
  0.102.x backport, and `rumqttc 0.25.1` still asks for `rustls-webpki ^0.102.8`. So
  [SECURITY.md](SECURITY.md) stands in for the bump until a release moves, and `cargo deny check
  advisories` now fails if the exception stops being true (#55).

### Documentation
- A [SECURITY.md](SECURITY.md): where to report something, the LAN trust model in one place instead
  of only halfway down the README, and the analysis above with the commands to check it yourself.

## [3.2.0] — 2026-08-24

Home Assistant, done properly. The MQTT publisher, the alert engine and the Home Assistant
read-back all moved off the page and into the server, so they keep working with every window in
the house closed — which is the one thing an alert cannot depend on a browser for.

Two new repositories ship alongside this release: a
[HACS integration](https://github.com/d4vid87/ha-weatherdesk) for a weather entity with a forecast
card, and a [Home Assistant OS add-on](https://github.com/d4vid87/weatherdesk-addons).

### Added
- **Server-side MQTT publishing.** One Home Assistant device, nineteen entities, discovered with
  no YAML and no custom component. SI on the wire always — a units switch on the dashboard must
  never rewrite months of Home Assistant history. `feels_like`, `pressure_trend` as a word,
  `alert` and `rule` alongside the raw readings; the first fifteen carry `expire_after`, so a
  station that stops reporting shows as unavailable rather than serving a frozen number.
- **Server-side alert engine**, mirroring the page's rules latch for latch — same thresholds,
  hold times, AND conditions and re-arm band — plus the NWS poll. Pushes through ntfy, a webhook
  and the broker. The page stands down when the server is running, so nothing arrives twice.
- **Test push channels** in Settings sends one real notification down every configured channel.
  A test that takes a different path to your phone than the alerts do tests nothing.
- **Home Assistant entity picker.** The state list is fetched by the server, so the long-lived
  token never reaches a browser — and `cors_allowed_origins` in `configuration.yaml` is no longer
  needed, which is what used to make this fail for most people. Read-only, deliberately.
- **`GET /api/v1`** — named fields, SI, no credentials, and a version number that means it.
  Everything else this server answers is shaped for the page and free to change with it.
- **mDNS.** The dashboard announces itself as `_weatherdesk._tcp`, and finds a WeatherLink Live
  console the same way — the *Find console* button in the wizard and in Settings.
- **Wind unit override** — mph, km/h, m/s or knots, independent of the master units switch.
- **Layout presets**: Wall landscape, Kitchen portrait, E-ink. A starting point to drag from.
- **Data and Signals cards are draggable**, resizable and hideable like every other panel.
- **Sun strength panel**: UV now and its band, burn time, today's peak UV and when, solar now,
  and the day's energy in kWh/m².
- **This day, other years** — what your own station recorded on this date in previous years.
- **Station elevation**, **three importable Home Assistant blueprints**, and
  [`docs/homeassistant.md`](docs/homeassistant.md).
- Ingress support: served behind a path prefix, the page is handed that prefix rather than
  firing absolute paths at whatever is in front of it.

### Changed
- The setup wizard leads with the brand of station rather than a Tempest token, and waits for one
  real reading before it closes — "68.2°F received ✓". A saved setting was never the same thing
  as a working station.
- Six files each carried their own copy of the metres-per-second conversion factor. One helper
  now: six chances for a chart to be plausible and wrong, removed.
- The Home Assistant settings are one section split into *Publish the station* and *Read entities
  back*, with a **Test both** button that connects for real and waits for the broker to
  acknowledge a message — a broker that rejects your password accepts the TCP connection first.

### Fixed
- The `alert` sensor kept its last headline forever, so an automation asking "is anything out
  right now" would have been answered by a thunderstorm that ended on Tuesday. It clears on the
  all-clear.
- Publishing no longer stops when the last browser tab closes.
- **The Android app is 16 KB page compatible.** Android 15 and up refuses a shared library whose
  segments are aligned to the old 4 KB page, and told every phone so in a dialog on first launch.
- **A phone in landscape is 780x360**, and the phone stylesheet asked about width alone — so
  landscape got the desktop treatment: drag handles over the panel titles, saved desktop widths,
  and the hero icon painted on top of the clock.
- Android draws edge to edge. The status bar sat on the tabs, and the last panel and the last
  setting sat under the gesture bar — which in landscape is down the right-hand side.
- The alert banners are in the page flow rather than over it, and four of them are taller than a
  phone held sideways: the dashboard was entirely behind its own warnings. The stack scrolls now.
- The hero clock, the wet bulb and WBGT gauges, and the sun and moon times were each painted over
  by something of their own — a drag grip, a thermometer column and the alert banners.

### Upgrading
Publishing used to run in the browser over a WebSocket. Change the broker address from
`ws://host:9001` to `mqtt://host:1883` — the app says so if you leave the old one there — and you
can drop `protocol websockets` from mosquitto if nothing else used it.

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

[Unreleased]: https://github.com/d4vid87/weatherdesk/compare/v3.2.0...HEAD
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
