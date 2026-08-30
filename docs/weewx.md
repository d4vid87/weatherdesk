# Feeding WeatherDesk from WeeWX

WeeWX already speaks a protocol WeatherDesk already listens for: the Weather Underground
uploader. Point it at WeatherDesk instead of wunderground.com and every archive interval lands
in the same archive as any other station brand — no driver, no extension, no code.

## weewx.conf

In `[StdRESTful]`:

```ini
[[Wunderground]]
    enable = true
    station = anything          # becomes the ID= field; WeatherDesk ignores it unless an
                                # ingest key is set (below)
    password = anything
    server_url = http://<weatherdesk-host>:8088/updateweatherstation.php
    rapidfire = false
```

Restart WeeWX (`sudo systemctl restart weewx`). Within one archive interval a reading appears —
verify with `weatherdesk --check` on the host, or open the dashboard and watch the age chip.

In WeatherDesk's Settings, set **Station brand** to *Weather Underground protocol* so the
dashboard knows where its readings come from.

## With an ingest key

On a network you don't fully trust, set an ingest key in WeatherDesk's Settings and use it as
the WeeWX `password`; WeatherDesk checks the `PASSWORD=` field on the WU path. Readings without
it are refused.

## What maps

The WU uploader sends temperature, humidity, dew point, barometer, wind (speed, gust,
direction), rain (rate and daily), solar radiation and UV — everything the dashboard's gauges
and archive use. Anything WeeWX computes that the protocol has no field for (inside
temperature, extra sensors) stays in WeeWX.
