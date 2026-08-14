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
  station-vs-model trend strip, 48h temp/rain/wind chart, inline radar, six day cards with
  temperature arcs, eight dial gauges, 10-day list, alert center, weather story, model agreement,
  forecast changes, forecast accuracy, air quality.
- **Forecast Lab** — radar, embedded from [Hook Echo-WX](https://hookecho.netlify.app/).

The Desk radar loads itself, in Hook Echo's embedded mode: no chrome, and one frame a minute until
you touch it. That matters because a live radar loop repaints ten times a second, and the WebKit
webview the desktop app uses on Linux and macOS redraws the whole Desk on every one of those
frames — enough to saturate a CPU core. Touch the map and it animates normally; the Forecast Lab
tab is the full-chrome view.

Settings → **Radar site** picks which radar, out of all 201 WSR-88D and TDWR sites, nearest first;
leave it on *Nearest to my station* and it follows the station. Wherever you leave the map — site,
product, tilt, basemap, zoom — is remembered here and handed back to the viewer on the next launch.
It has to work that way round: browsers partition an iframe's storage, so the embedded viewer
cannot remember anything on its own. The Desk and the Lab share one remembered view.
- **Local Signals** — nearby-station comparison table, the Tempest live wind feed, a 24-hour
  lightning-strike log and the notification history.
- **Data** — ten boards off 7-day device history, including a wind rose, plus multi-model output
  and the local verification log.

A panel that has stopped updating keeps its last good numbers and marks itself with its age in the
corner, rather than blanking or lying. The forecast and current observations are cached, so a
reload during an outage still renders something.

## Moving things around

The Desk is one 12-column grid and every panel is a free agent. Drag a panel by the grip in its
top-right corner to drop it anywhere in the grid; drag its right edge to change how many columns it
spans, its bottom edge for height, the corner for both. Double-click the grip to restore one panel,
or Settings → **Reset panel layout** to put everything back.

Name an arrangement in Settings → **Save layout** to keep it, and load it back from the list below
— one layout for the wall tablet, another for the desktop window. The padlock in the header hides
every grip and handle, so a mounted tablet can't be rearranged by a passing sleeve.

Both gestures are pointer events, so they work the same with a mouse, a pen or a finger — the
tablet case is the one that matters, and HTML5 drag-and-drop never fires for touch.

## Data sources

| Feature | Endpoint |
|---|---|
| Station meta, observations, forecast | `swd.weatherflow.com/swd/rest/` |
| Live 3-second wind, lightning strikes | `wss://ws.weatherflow.com/swd/data` |
| The same, straight off the hub's LAN broadcast (desktop app only) | UDP `50222` |
| Watches and warnings, gridpoint forecast | `api.weather.gov` |
| Multi-model agreement, 15-minute nowcast, AQI | `api.open-meteo.com` |
| Radar | [Hook Echo-WX](https://github.com/d4vid87/hookecho) at `hookecho.netlify.app` |
| Place search | `photon.komoot.io` |

## Smart home

WeatherDesk publishes the station to your own MQTT broker and reads a few Home Assistant entities
back. Both halves are dark until you fill them in under Settings → **Smart home**.

**Publishing.** Point *MQTT WebSocket URL* at a broker with a WebSocket listener — mosquitto wants

```
listener 9001
protocol websockets
```

— and readings arrive on `weatherdesk/<station id>/temp`, `…/wind`, `…/gust`, `…/rain`,
`…/pressure`, and the rest, retained, **in SI units** (°C, m/s, hPa, mm) whatever the dashboard is
set to display. Events land on `weatherdesk/<station id>/event/{lightning,rain,gust}` and are not
retained. `weatherdesk/<station id>/status` is `online`/`offline`, the second written by the
broker's last-will when the dashboard goes away.

Home Assistant discovers all of it by itself: the retained `homeassistant/…/config` topics
materialize one device with every sensor under it, and they survive a Home Assistant restart with
no dashboard open. Changing your station ID leaves the old device's retained configs behind —
delete them with `mosquitto_pub -t 'homeassistant/sensor/wd_<old id>_temp/config' -r -n`, one per
topic, if you care.

**Reading back.** *Home Assistant URL* + a long-lived access token + a comma-separated list of
entity ids puts their live states on the Desk. Home Assistant has to allow this origin —
in `configuration.yaml`:

```yaml
http:
  cors_allowed_origins:
    - http://tauri.localhost
    - http://<the LAN URL in the window title>
```

**HomeKit, Alexa, Google.** Through Home Assistant, which already bridges all three — there is no
WeatherDesk-specific code for them and there shouldn't be. Add the MQTT integration (the device
above appears), then Settings → Devices & Services → Add Integration → **HomeKit Bridge** and pick
it; Alexa and Google go through Home Assistant Cloud or their own manual setups.

Two limits worth knowing: publishing only happens while the dashboard is open somewhere (leave the
desktop app running — that is the always-on copy), and a browser tab served over `https` cannot
reach a `ws://` broker at all. The desktop app and the LAN URL are both plain origins, so they can.

## Download & run

Grab the installer for your OS from [Releases](https://github.com/d4vid87/weatherdesk/releases) and
double-click it. The app opens in its own window *and* serves the same dashboard to the rest of your
network on port 8088 — the wall tablet just opens the URL shown in the window title. Nothing else to
install; leave the app running.

The app also listens for your hub's UDP broadcasts on port 50222 and re-serves them to the tablet,
so live wind and lightning keep flowing with the internet unplugged. A browser can't hold a UDP
socket, so the no-install option below uses the cloud websocket only. If another Tempest app owns
port 50222 first, WeatherDesk skips it and falls back to the websocket by itself.

- **Windows** — run the `.msi`. The app is unsigned, so SmartScreen shows a warning: **More info →
  Run anyway**. Allow the Windows Firewall prompt on first launch, or the tablet can't connect.
- **macOS** — open the `.dmg`, drag WeatherDesk to Applications. Unsigned, so on first launch macOS
  refuses it: **System Settings → Privacy & Security → Open Anyway**, or in a terminal
  `xattr -dr com.apple.quarantine /Applications/WeatherDesk.app`.
- **Linux** — `sudo apt install ./WeatherDesk_*_amd64.deb` (Debian, Ubuntu, Mint, Pop!_OS). On other
  distributions install `webkit2gtk-4.1` and build from source, below — there is no AppImage: it has
  to carry its own WebKitGTK, and that copy crashes on hosts newer than the machine that built it.
- **Raspberry Pi** — `sudo apt install ./WeatherDesk_*_arm64.deb` on 64-bit Raspberry Pi OS
  (Bookworm or newer, Pi 4 / Pi 5). `uname -m` must say `aarch64`; the 32-bit image is not built.

To start it automatically: macOS System Settings → General → Login Items; Windows put a shortcut in
`shell:startup`; Linux and Raspberry Pi OS add a `.desktop` file to `~/.config/autostart`:

```ini
[Desktop Entry]
Type=Application
Name=WeatherDesk
Exec=weatherdesk
```

A Pi with a screen attached is the whole appliance: it shows the dashboard itself *and* serves it to
any other tablet in the house. A Pi with no screen has no desktop for the window to open on — use
the server-only option below, which gives up the hub's UDP feed but nothing else.

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

**Android / Fire tablets.** `WeatherDesk.apk` is on the same Releases page. Sideload it — the
tablet will ask you to allow installs from whatever app you downloaded it with (on Fire OS:
Settings → Security & Privacy → Apps from Unknown Sources). One APK covers 64-bit and 32-bit
devices, Fire OS 6 and newer. The phone build talks to WeatherFlow's websocket only: it neither
listens for the hub's LAN broadcasts nor serves the dashboard to other devices, both of which stay
desktop jobs. Paste the token once per device.

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
