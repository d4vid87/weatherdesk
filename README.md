# WeatherDesk

A self-hosted weather dashboard for a WeatherFlow Tempest station, built for a wall tablet on the
LAN. Vanilla JS, native ES modules, no build step, no framework, no chart library, no backend —
every call goes browser-direct to a free public API.

Radar comes from [Hook Echo-WX](https://github.com/d4vid87/hookecho) — my own NEXRAD viewer,
embedded here and centered on the station.

![The Desk in motion: live radar on the Desk, then the radar panel dragged to the top of the stack
by its grip and resized to full width from its corner handle](docs/hero.gif)

![The Desk, rearranged: Hook Echo-WX radar dragged to the top, sky hero, seven day cards, a row of
gauges (wind, rain, humidity, pressure, dew point, UV, lightning, wet bulb) and the 48h forecast
chart](docs/screenshot.png)

## Sections

- **Desk** — every panel drags by its grip and resizes from its corner, with the arrangement kept
  in `localStorage`; sky-gradient hero (astro + moon phase + battery + live-observation age), signal ticker,
  station-vs-model trend strip, 48h temp/rain/wind chart, click-to-load inline radar, six day cards with
  temperature arcs, eight dial gauges, 10-day list, alert center, weather story, model agreement,
  forecast changes, forecast accuracy, air quality.
- **Forecast Lab** — radar, embedded from [Hook Echo-WX](https://hookecho.netlify.app/).

The Desk radar waits for a click. A live radar loop repaints ten times a second, and the WebKit
webview the desktop app uses on Linux and macOS redraws the whole Desk on every one of those
frames — enough to saturate a CPU core and freeze the window. In a browser it is free; load it
there, or in the Forecast Lab tab, which has the Desk hidden behind it.
- **Local Signals** — nearby-station comparison table and the Tempest websocket live wind feed.
- **Data** — nine boards off 7-day device history, multi-model output and the local verification log.

## Moving things around

The Desk is one 12-column grid and every panel is a free agent. Drag a panel by the grip in its
top-right corner to drop it anywhere in the grid; drag its right edge to change how many columns it
spans, its bottom edge for height, the corner for both. Double-click the grip to restore one panel,
or Settings → **Reset panel layout** to put everything back.

Both gestures are pointer events, so they work the same with a mouse, a pen or a finger — the
tablet case is the one that matters, and HTML5 drag-and-drop never fires for touch.

## Data sources

| Feature | Endpoint |
|---|---|
| Station meta, observations, forecast | `swd.weatherflow.com/swd/rest/` |
| Live 3-second wind, lightning strikes | `wss://ws.weatherflow.com/swd/data` |
| Watches and warnings, gridpoint forecast | `api.weather.gov` |
| Multi-model agreement, 15-minute nowcast, AQI | `api.open-meteo.com` |
| Radar | [Hook Echo-WX](https://github.com/d4vid87/hookecho) at `hookecho.netlify.app` |
| Place search | `photon.komoot.io` |

## Download & run

Grab the installer for your OS from [Releases](https://github.com/d4vid87/weatherdesk/releases) and
double-click it. The app opens in its own window *and* serves the same dashboard to the rest of your
network on port 8088 — the wall tablet just opens the URL shown in the window title. Nothing else to
install; leave the app running.

- **Windows** — run the `.msi`. The app is unsigned, so SmartScreen shows a warning: **More info →
  Run anyway**. Allow the Windows Firewall prompt on first launch, or the tablet can't connect.
- **macOS** — open the `.dmg`, drag WeatherDesk to Applications. Unsigned, so on first launch macOS
  refuses it: **System Settings → Privacy & Security → Open Anyway**, or in a terminal
  `xattr -dr com.apple.quarantine /Applications/WeatherDesk.app`.
- **Linux** — `sudo apt install ./WeatherDesk_*_amd64.deb` (Debian, Ubuntu, Mint, Pop!_OS). On other
  distributions install `webkit2gtk-4.1` and build from source, below — there is no AppImage: it has
  to carry its own WebKitGTK, and that copy crashes on hosts newer than the machine that built it.

To start it automatically: macOS System Settings → General → Login Items; Windows put a shortcut in
`shell:startup`; Linux add a `.desktop` file to `~/.config/autostart`.

## No-install / development option

```sh
git clone https://github.com/d4vid87/weatherdesk
cd weatherdesk
python3 -m http.server 8088 --bind 0.0.0.0 --directory site
```

Open `http://<box>:8088`, then paste a WeatherFlow personal access token
(tempestwx.com → Settings → Data Authorizations) and a station ID into the settings drawer. The
station lookup fills in the name, coordinates and numeric device ID. Everything else — units,
refresh interval, saved places, notification categories, forecast snapshots and the verification
log — lives in `localStorage`; there is nothing to configure on the server.

For a permanent install, a systemd user unit running that same command is enough.

The desktop app serves from its own origin, so settings saved in a browser install (token included)
don't carry over — paste the token once more in the app.

Building the desktop app yourself: `cargo tauri build` in `src-tauri/` (Rust + the Tauri
[prerequisites](https://tauri.app/start/prerequisites/) for your OS). Iterate on the HTML/JS with
the python command above; the app embeds `site/` at compile time.

## License

MIT. See [LICENSE](LICENSE).

## Notes

No service worker and no PWA install: the app is useless offline because every source is a cloud
API, and the LAN origin is insecure anyway, so the Notification API is unavailable. Alerts render
as an in-page banner queue with a WebAudio chime instead.

The layout follows the shape of myweatherdesk.com. No code was taken from it; this is written from
scratch against the same public APIs.
