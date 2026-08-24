# WeatherDesk and Home Assistant

WeatherDesk publishes your station to Home Assistant over MQTT, evaluates your alert rules
server-side, and reads Home Assistant entities back onto the dashboard. None of it needs a browser
to be open, and none of it needs a cloud account.

- [What you get](#what-you-get)
- [Publishing the station](#publishing-the-station)
- [The entities](#the-entities)
- [Alerts](#alerts)
- [Reading Home Assistant back](#reading-home-assistant-back)
- [Blueprints](#blueprints)
- [The JSON API](#the-json-api)
- [When it doesn't work](#when-it-doesnt-work)

## What you get

One Home Assistant device with fifteen sensors under it, discovered automatically, surviving a
restart of either side. No custom component to install and nothing to add to
`configuration.yaml` — the discovery topics are retained, so Home Assistant finds the device on
its own.

**Everything on the wire is SI**: °C, m/s, hPa, mm. Always, whatever the dashboard is set to
display. A units switch on the dashboard must never rewrite months of Home Assistant history, and
Home Assistant converts for display anyway.

## Publishing the station

Settings → **Home Assistant** → *Publish the station*.

| Field | What goes in it |
| --- | --- |
| MQTT broker | `mqtt://192.168.1.10:1883`, or `mqtts://…` for TLS. A bare hostname works too. |
| MQTT username / password | Only if your broker asks for them. |
| Discovery prefix | `homeassistant` unless you changed it in Home Assistant's MQTT settings. |

Then press **Test both**. It connects for real and waits for the broker to acknowledge a
published message, rather than just checking that the socket opened — a broker that rejects your
password accepts the TCP connection first, which is why "it connected" was never worth reporting.

Mosquitto with no authentication needs nothing beyond a listener. With authentication, whatever
user you give WeatherDesk needs write access to `weatherdesk/#` and to your discovery prefix.

> **`ws://` is a different listener.** Older versions of WeatherDesk published from the browser
> over a WebSocket, so the setting wanted a `ws://` URL and your broker needed
> `protocol websockets`. Publishing moved into the server, which speaks plain MQTT — if you are
> upgrading, change the address to `mqtt://` and the port from 9001 to 1883. WeatherDesk says so
> if you leave a `ws://` address there.

Topics, if you want them directly:

```
weatherdesk/<station id>/temp          retained, °C
weatherdesk/<station id>/wind_avg      retained, m/s
weatherdesk/<station id>/day_rain      retained, mm
weatherdesk/<station id>/status        online | offline   (offline is the broker's last will)
homeassistant/sensor/wd_<station id>_temp/config           retained discovery
```

Discovery is re-sent every fifteen minutes, so a broker that lost its retained set — a fresh
container, a `mosquitto -c` with no persistence — gets it back without anyone restarting anything.

Changing your station ID leaves the old device's retained configs on the broker. Clear them with
one `mosquitto_pub -t 'homeassistant/sensor/wd_<old id>_temp/config' -r -n` per topic, if the
duplicate device bothers you.

## The entities

Fifteen sensors straight off the archive:

`temperature` · `humidity` · `pressure` · `wind` · `gust` · `wind lull` · `wind direction` ·
`uv` · `solar` · `lux` · `rain` · `day rain` · `battery` · `strikes` · `strike distance`

and four more that Home Assistant would otherwise need a template sensor per house to work out:

| Entity | What it is |
| --- | --- |
| `feels_like` | Heat index above 27 °C, wind chill below 10 °C, the plain reading between — the same two formulas the dashboard's hero uses, so they agree. |
| `pressure_trend` | A word: `falling rapidly`, `falling`, `steady`, `rising`, `rising rapidly`. |
| `alert` | The headline of the worst NWS warning in force. Empty when nothing is out. |
| `rule` | The last of your own alert rules to fire, as the text you would have seen on the dashboard. |

The first thirteen carry `expire_after`, so a station that stops reporting shows as unavailable
rather than serving a frozen number forever. `alert` and `rule` deliberately do not: a quiet
fortnight is not a fault, and an alert sensor that went unavailable is an automation that silently
stopped working.

`configuration_url` on the device links back to the dashboard, so the Home Assistant device page
has a way in.

## Alerts

The rules you write under Settings → **Alert rules** are evaluated by the WeatherDesk server, not
by the page. That is the whole point: a tablet that sleeps at midnight used to be a house with no
frost warning.

The server watches the archive, applies the same thresholds, the same hold times, the same
AND conditions and the same re-arm behaviour the dashboard applies, and pushes through every
channel you have configured — ntfy, a webhook, and the `rule` topic on the broker. It also polls
the National Weather Service and pushes severe warnings the same way. The page stops pushing when
it notices the server is doing it, so nothing arrives twice.

**Test push channels**, in the notifications section of Settings, sends one real notification down
every configured channel. Real on purpose: a test that takes a different path to your phone than
the alerts do tests nothing.

Static self-hosts — the site served by a plain web server with no WeatherDesk process behind it —
have no server to do this, and the page keeps evaluating rules itself while it is open.

## Reading Home Assistant back

Settings → **Home Assistant** → *Read entities back*. Paste the Home Assistant URL and a
long-lived access token (Home Assistant → your profile → Security → Long-lived access tokens),
then press **List entities** and tick what you want on the dashboard.

The list is fetched by the WeatherDesk server, which means two things worth knowing:

- The token stays on the server. It is never sent to a browser.
- **You no longer need `cors_allowed_origins` in `configuration.yaml`.** Home Assistant sends no
  CORS headers unless its YAML says to, which is why this used to fail for most people until they
  edited a config file. The request is same-origin now.

A static self-host still takes the old path — the browser calls Home Assistant directly — and
still needs the CORS block:

```yaml
http:
  cors_allowed_origins:
    - http://tauri.localhost
    - http://<the LAN address of the dashboard>
```

This is read-only, deliberately. Turning things on and off is Home Assistant's job; a dashboard on
a LAN with no authentication that can throw a socket would sink the trust model this app
documents.

## Blueprints

Three importable automations live in [`blueprints/automation/weatherdesk`](../blueprints/automation/weatherdesk).
In Home Assistant: Settings → Automations & scenes → Blueprints → **Import blueprint**, and paste
the URL of the raw file.

| Blueprint | What it does |
| --- | --- |
| [`severe-alert-critical-push`](../blueprints/automation/weatherdesk/severe-alert-critical-push.yaml) | Sends a critical notification — one that overrides silent mode and Do Not Disturb — when the `alert` sensor picks up a warning. |
| [`wind-gust-threshold`](../blueprints/automation/weatherdesk/wind-gust-threshold.yaml) | Runs anything you like when gusts stay over a number, and optionally something else when they drop back. |
| [`daily-rain-skip-irrigation`](../blueprints/automation/weatherdesk/daily-rain-skip-irrigation.yaml) | Waters at a set time unless your own gauge says the garden already got some. |

Thresholds are typed in the unit the sensor shows in Home Assistant. 10 m/s is about 22 mph;
5 mm is about a fifth of an inch.

## The JSON API

`GET /api/v1` on the dashboard's own address. Named fields, SI, no credentials, and a version
number that means it. Everything else this server answers is shaped for the page and free to
change with it; this one is not.

```json
{
  "api": 1,
  "version": "3.2.0",
  "units": "si",
  "station": { "id": "12345", "name": "Home", "source": "", "lat": 41.87, "lon": -72.8 },
  "current": {
    "at": 1787537000,
    "temp": 20.1, "humidity": 54, "pressure": 1013.2,
    "wind_avg": 2.1, "wind_gust": 4.4, "wind_dir": 190,
    "uv": 0.4, "solar": 33, "rain": 0, "day_rain": 1.2,
    "feels_like": 20.1, "pressure_trend": "steady"
  },
  "forecast": { "days": [ { "at": 1787529600, "high_c": 27.4, "low_c": 14.1, "precip_chance": 10, "wmo_code": 3 } ] },
  "health": { "wll": { "at": 1787536980, "ok": true, "what": "ok · waiting for next write slot", "rows": 412 } }
}
```

`current` is the newest row of the archive. A field the station does not measure is `null`, not
missing. The forecast is five days from open-meteo, cached for fifteen minutes.

The dashboard also announces itself on the LAN over mDNS as `_weatherdesk._tcp`, with `version`
and `path=/api/v1` in its TXT record, so something looking for it does not have to be told an
address.

## When it doesn't work

**No device appears in Home Assistant.** Check Settings → *Test both* first. If the broker is
green, check that Home Assistant's own MQTT integration points at the same broker, and that the
discovery prefix matches on both sides.

**Sensors appear and immediately go unavailable.** That is `expire_after` doing its job: nothing
has been written to the archive recently. Settings → Diagnostics shows what each station source
last did.

**Everything is 32 °F / 0 °C, or the numbers look scaled.** Home Assistant is being told SI and
converting. If a number looks converted twice, check you have not also left the old browser-side
publisher running — an older WeatherDesk tab open somewhere will publish to the same topics. The
current version stands down when it sees the server publishing, but a tab from before 3.2.0 will
not.

**A `mqtts://` broker won't connect.** WeatherDesk uses the system trust store. A self-signed
broker certificate needs to be trusted by the machine WeatherDesk runs on.

## A note on exposure

WeatherDesk's LAN routes assume a trusted LAN: `/config` serves the settings blob, and
`/ha/states` will list your Home Assistant entities to anything that can reach the port. That is
the documented model. `/public` and `/config-public` are the only pair meant for the open
internet, and a public tunnel needs an access policy in front of it before anything else. See the
README's self-hosting section.
