# WeatherDesk

A self-hosted weather dashboard for a WeatherFlow Tempest station, built for a wall tablet on the
LAN. Vanilla JS, native ES modules, no build step, no framework, no chart library, no backend —
every call goes browser-direct to a free public API.

Radar comes from [Hook Echo-WX](https://github.com/d4vid87/hookecho) — my own NEXRAD viewer,
embedded here and centered on the station.

![A walkthrough of the Desk: sky hero with live station temperature and NWS alerts, the inline Hook
Echo-WX radar, the 48h temp/rain/wind chart, day cards and dial gauges, then the Forecast Lab tab
with the full-chrome radar](docs/hero.gif)

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

**Is the radar live?** It is as live as NEXRAD gets: a WSR-88D takes 4–10 minutes to finish a
volume scan, and delivery adds a little more, so the newest frame is always a few minutes behind
the sky. Nothing on the internet is fresher — that delay is the radar itself, not the viewer.
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

## Quick start

1. **Token** — tempestwx.com → Settings → **Data Authorizations** → *Create Token*. Any personal
   use token works; paste it into Settings → *Tempest API token*.
2. **Station ID** — the number in your station's URL, `tempestwx.com/station/NNNNN`. That number,
   not the station name and not the serial on the sensor.
3. **Device ID** — leave it blank. The station lookup fills it in. (A station ID pasted here is
   numeric too, and used to break every history chart in silence; the app now corrects it and says
   so.)

Everything is saved in the browser's `localStorage`, per install — the desktop app and a browser
tab don't share settings.

## Download & run

Grab the installer for your OS from [Releases](https://github.com/d4vid87/weatherdesk/releases) and
double-click it. The app opens in its own window *and* serves the same dashboard to the rest of your
network on port 8088 — the wall tablet just opens the URL shown in the window title. Nothing else to
install; leave the app running.

**One config for the whole house.** The desktop app also keeps your settings and dashboard layout
on the host computer. Any browser that opens the LAN URL loads that configuration — no re-typing the
token, no re-arranging panels per device — and a save from any of those browsers writes back, so the
next device to load picks it up. Open sessions don't update live; reload to fetch. Note that this
means anyone on your network can read the Tempest token from the host. Self-hosting the `site/`
folder statically has no config server, so those browsers keep their own settings as before.

The app also listens for your hub's UDP broadcasts on port 50222 and re-serves them to the tablet,
so live wind and lightning keep flowing with the internet unplugged. A browser can't hold a UDP
socket, so the no-install option below uses the cloud websocket only. If another Tempest app owns
port 50222 first, WeatherDesk skips it and falls back to the websocket by itself.

**UDP-only mode — no token at all.** On the desktop app, with your hub on the same network, leave
the token and station ID empty and the hub's own broadcasts still drive the hero, the wind, rain,
humidity, pressure, dew point and UV gauges, the live wind feed and the lightning log — and MQTT
publishing, if you use it. What needs the (free) token is everything that isn't your sensor:
forecasts, the 10-day list, history charts, model agreement, alerts. The pressure gauge reads
*station pressure* in this mode rather than sea-level pressure, because that is what the hub sends.

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

### Headless / home lab

No screen, no desktop session — just serve `site/` and open it from anywhere. Drop this in
`~/.config/systemd/user/weatherdesk.service`:

```ini
[Unit]
Description=WeatherDesk (static site)
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 -m http.server 8088 --bind 0.0.0.0 --directory %h/weatherdesk/site
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
loginctl enable-linger "$USER"          # keeps it running with nobody logged in
systemctl --user daemon-reload
systemctl --user enable --now weatherdesk
```

There is no hub UDP feed in this mode — a browser can't hold a UDP socket, so every client rides
WeatherFlow's websocket, which means it needs a token and the internet. The desktop app is the only
build that listens on 50222.

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

## Other devices

- **Windows 10 / 11** — the `.msi` on the Releases page is the whole answer; it's a normal desktop
  app on both.
- **iPad, iPhone, Echo Show, any other browser-only screen** — there is no native app, and there
  won't be. Run the desktop app or the headless server on a machine that stays on, then point
  Safari (or the Show's Silk browser) at that LAN URL. The Echo Show's browser is untested.
- **Android TV boxes (onn, Shield, Fire TV)** — the APK installs, but the dashboard is built for
  touch and mouse: a D-pad remote can't reach the settings drawer or drag a panel. Plug in a USB or
  Bluetooth mouse, or use an air-mouse remote.
- **Every public Tempest on a map** — that's WeatherFlow's own [tempestwx.com/map](https://tempestwx.com/map),
  which is also where you find the IDs for the Local Signals comparison table.

## Troubleshooting

Settings → **Diagnostics** pings every source and prints ✓/✗ plus latency for each, along with the
viewport size. Start there — it separates "my token is wrong" from "NWS is down".

| What you see | What it means |
|---|---|
| *token rejected: create or check a personal use token…* | The token is wrong, expired, or was never created. tempestwx.com → Settings → Data Authorizations. |
| *Token works but has no access to station N* | The token is valid but belongs to a different account, or the station ID isn't yours. The ID is the number in your `tempestwx.com/station/NNNNN` URL. |
| *not found: check the station/device ID* | A real 404 — usually a station ID typo, or a serial number (`ST-00176465`) where a numeric ID belongs. |
| *Device ID corrected* | Something that wasn't one of this station's devices was in the Device ID box. Fixed automatically; leave that box blank. |
| *Forecast stale — showing cached copy* | The last good forecast is on screen with its age marked; the source is unreachable right now. |
| *network unreachable* / *timed out (15s)* | Wi-Fi, DNS or the API itself. Diagnostics will show whether it's one source or all of them. |
| A nearby station row shows an error | Only **public** stations can be read. Pick one from tempestwx.com/map. |

On Windows, if the tablet can't load the LAN URL, it's the firewall prompt that was dismissed on
first launch — allow WeatherDesk on private networks.

## License

MIT. See [LICENSE](LICENSE).

## Notes

No service worker and no PWA install: the app is useless offline because every source is a cloud
API, and the LAN origin is insecure anyway, so the Notification API is unavailable. Alerts render
as an in-page banner queue with a WebAudio chime instead.

The layout follows the shape of myweatherdesk.com. No code was taken from it; this is written from
scratch against the same public APIs.
