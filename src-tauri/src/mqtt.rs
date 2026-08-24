// Publish the station to an MQTT broker, so Home Assistant has it whether or not a browser is
// open anywhere in the house.
//
// This used to live in `site/js/home.js`, which meant the sensors went unavailable the moment
// the last tab closed — the one thing a home automation integration must not do. The page keeps
// its Home Assistant *display* panel; publishing is the server's job now.
//
// Everything on the wire is SI, always, whatever the dashboard is set to. Home Assistant
// converts for display, and a unit switch on the dashboard must never rewrite months of its
// history.

use crate::store;
use rumqttc::{Client, LastWill, MqttOptions, QoS};
use std::time::Duration;

/// How often we look for a new row. The archive gains one a minute at best, so this is mostly
/// a cheap "has anything changed" query.
const POLL: Duration = Duration::from_secs(10);
/// Retained discovery is re-sent this often: a broker that lost its retained set (a fresh
/// container, a `mosquitto -c` with no persistence) otherwise never gets it back.
const REANNOUNCE: Duration = Duration::from_secs(900);
/// Home Assistant marks a sensor unavailable this long after its last value. Long enough for a
/// station that reports every five minutes, short enough that a dead poller shows up as dead.
const EXPIRE_AFTER: u64 = 1800;

/// Column, sensor name, device_class, unit, state_class. The columns are `store`'s, so a field
/// added there is one line here rather than a new tuple layout.
const FIELDS: [(&str, &str, Option<&str>, &str, &str); 15] = [
    ("temp", "temperature", Some("temperature"), "°C", "measurement"),
    ("humidity", "humidity", Some("humidity"), "%", "measurement"),
    ("pressure", "pressure", Some("atmospheric_pressure"), "hPa", "measurement"),
    ("wind_avg", "wind", Some("wind_speed"), "m/s", "measurement"),
    ("wind_gust", "gust", Some("wind_speed"), "m/s", "measurement"),
    ("wind_lull", "wind lull", Some("wind_speed"), "m/s", "measurement"),
    ("wind_dir", "wind direction", None, "°", "measurement"),
    ("uv", "uv", None, "UV index", "measurement"),
    ("solar", "solar", Some("irradiance"), "W/m²", "measurement"),
    ("lux", "lux", Some("illuminance"), "lx", "measurement"),
    ("rain", "rain", Some("precipitation"), "mm", "measurement"),
    ("day_rain", "day rain", Some("precipitation"), "mm", "total_increasing"),
    ("battery", "battery", Some("voltage"), "V", "measurement"),
    ("strikes", "strikes", None, "strikes", "measurement"),
    ("strike_dist", "strike distance", Some("distance"), "km", "measurement"),
];

/// Values the archive doesn't hold because they are read off the numbers next to them. Home
/// Assistant can't derive these itself without a template sensor per house.
/// name, device_class, unit, state_class — each optional, because a trend has none of them.
type Derived = (&'static str, Option<&'static str>, Option<&'static str>, Option<&'static str>);
const DERIVED: [Derived; 2] = [
    ("feels_like", Some("temperature"), Some("°C"), Some("measurement")),
    ("pressure_trend", None, None, None),
];

struct Conf {
    url: String,
    user: String,
    pass: String,
    station: String,
    name: String,
    prefix: String,
    port: u16,
}

fn conf(cfg: &std::path::Path) -> Option<Conf> {
    let get = |k: &str| crate::setting(cfg, k).unwrap_or_default().trim_matches('"').to_string();
    let url = get("mqttUrl");
    let station = get("stationId");
    // A broker address and something to key the topics on. Without either there is nothing to
    // publish and nothing to publish it as.
    if url.is_empty() || station.is_empty() {
        return None;
    }
    let prefix = match get("haDiscoveryPrefix") {
        p if p.is_empty() => "homeassistant".to_string(),
        p => p,
    };
    Some(Conf {
        url,
        user: get("mqttUser"),
        pass: get("mqttPass"),
        name: match get("stationName") {
            n if n.is_empty() => format!("WeatherDesk {station}"),
            n => n,
        },
        station,
        prefix,
        port: get("httpPort").parse().unwrap_or(crate::server::DEFAULT_PORT),
    })
}

/// `mqtt://host:1883`, `mqtts://host:8883`, or a bare `host` — people paste all three. Returns
/// host, port and whether it is TLS.
fn parse_url(url: &str) -> Option<(String, u16, bool)> {
    let (tls, rest) = match url.split_once("://") {
        Some(("mqtts" | "ssl" | "mqtt+ssl", r)) => (true, r),
        Some(("mqtt" | "tcp", r)) => (false, r),
        // A ws:// URL is what the old in-page publisher wanted; this one speaks the plain
        // protocol, which is the listener a broker has switched on by default.
        Some(_) => return None,
        None => (false, url),
    };
    let rest = rest.trim_end_matches('/');
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().ok()?),
        None => (rest.to_string(), if tls { 8883 } else { 1883 }),
    };
    if host.is_empty() { None } else { Some((host, port, tls)) }
}

fn device(c: &Conf) -> serde_json::Value {
    serde_json::json!({
        "identifiers": [format!("weatherdesk_{}", c.station)],
        "name": c.name,
        "manufacturer": "WeatherDesk",
        "model": "Weather station",
        "sw_version": env!("CARGO_PKG_VERSION"),
        // The link Home Assistant puts on the device page: back to the dashboard itself.
        "configuration_url": format!("http://{}:{}/", crate::server::lan_ip(), c.port),
    })
}

fn announce(client: &Client, c: &Conf) {
    let dev = device(c);
    let avail = format!("weatherdesk/{}/status", c.station);
    let send = |kind: &str, slug: &str, mut cfg: serde_json::Value| {
        cfg["device"] = dev.clone();
        cfg["availability_topic"] = avail.clone().into();
        let topic = format!("{}/{}/wd_{}_{}/config", c.prefix, kind, c.station, slug);
        let _ = client.publish(topic, QoS::AtLeastOnce, true, cfg.to_string());
    };
    for (col, name, dc, unit, sc) in FIELDS {
        let mut cfg = serde_json::json!({
            "name": name,
            "unique_id": format!("wd_{}_{}", c.station, col),
            "state_topic": format!("weatherdesk/{}/{}", c.station, col),
            "unit_of_measurement": unit,
            "state_class": sc,
            "expire_after": EXPIRE_AFTER,
        });
        if let Some(dc) = dc {
            cfg["device_class"] = dc.into();
        }
        send("sensor", col, cfg);
    }
    for (name, dc, unit, sc) in DERIVED {
        let mut cfg = serde_json::json!({
            "name": name.replace('_', " "),
            "unique_id": format!("wd_{}_{}", c.station, name),
            "state_topic": format!("weatherdesk/{}/{}", c.station, name),
            "expire_after": EXPIRE_AFTER,
        });
        if let Some(dc) = dc {
            cfg["device_class"] = dc.into();
        }
        if let Some(u) = unit {
            cfg["unit_of_measurement"] = u.into();
        }
        if let Some(s) = sc {
            cfg["state_class"] = s.into();
        }
        send("sensor", name, cfg);
    }
    let _ = client.publish(avail, QoS::AtLeastOnce, true, "online");
}

/// Apparent temperature, SI in and SI out — the same two formulas `site/js/home.js` used, so the
/// broker and the hero agree. Heat index above 27 °C, wind chill below 10 °C, the plain reading
/// between them.
pub fn feels_like(c: f64, rh: Option<f64>, ms: Option<f64>) -> f64 {
    if c >= 27.0 {
        if let Some(rh) = rh {
            let f = c * 9.0 / 5.0 + 32.0;
            let hi = -42.379 + 2.049_015_23 * f + 10.143_331_27 * rh - 0.224_755_41 * f * rh
                - 6.837_83e-3 * f * f
                - 5.481_717e-2 * rh * rh
                + 1.228_74e-3 * f * f * rh
                + 8.528_2e-4 * f * rh * rh
                - 1.99e-6 * f * f * rh * rh;
            return (hi - 32.0) * 5.0 / 9.0;
        }
    }
    if c <= 10.0 {
        if let Some(ms) = ms.filter(|v| *v > 1.34) {
            let kph = ms * 3.6;
            return 13.12 + 0.6215 * c - 11.37 * kph.powf(0.16) + 0.3965 * c * kph.powf(0.16);
        }
    }
    c
}

/// Three hours of barometer in one word — the thing automations actually branch on, and the same
/// bands the Desk's trend strip uses.
pub fn press_trend(now_mb: f64, then_mb: f64) -> &'static str {
    let d = now_mb - then_mb;
    if d <= -2.0 {
        "falling rapidly"
    } else if d <= -0.5 {
        "falling"
    } else if d >= 2.0 {
        "rising rapidly"
    } else if d >= 0.5 {
        "rising"
    } else {
        "steady"
    }
}

/// The newest row, as (ts, column values in `FIELDS` order), plus the pressure three hours back.
fn newest(conn: &rusqlite::Connection) -> Option<(i64, Vec<Option<f64>>, Option<f64>)> {
    let cols = FIELDS.iter().map(|(c, ..)| *c).collect::<Vec<_>>().join(", ");
    let (ts, vals) = conn
        .query_row(&format!("SELECT ts, {cols} FROM obs ORDER BY ts DESC LIMIT 1"), [], |r| {
            let ts: i64 = r.get(0)?;
            let mut v = Vec::with_capacity(FIELDS.len());
            for i in 0..FIELDS.len() {
                v.push(r.get::<_, Option<f64>>(i + 1)?);
            }
            Ok((ts, v))
        })
        .ok()?;
    let was = conn
        .query_row(
            "SELECT pressure FROM obs WHERE ts <= ?1 AND pressure IS NOT NULL ORDER BY ts DESC LIMIT 1",
            [ts - 3 * 3600],
            |r| r.get::<_, Option<f64>>(0),
        )
        .ok()
        .flatten();
    Some((ts, vals, was))
}

fn publish_row(client: &Client, c: &Conf, vals: &[Option<f64>], was: Option<f64>) {
    let at = |name: &str| {
        FIELDS.iter().position(|(col, ..)| *col == name).and_then(|i| vals[i])
    };
    for ((col, ..), v) in FIELDS.iter().zip(vals) {
        if let Some(v) = v {
            let _ = client.publish(
                format!("weatherdesk/{}/{}", c.station, col),
                QoS::AtLeastOnce,
                true,
                format!("{v}"),
            );
        }
    }
    if let Some(t) = at("temp") {
        let f = (feels_like(t, at("humidity"), at("wind_avg")) * 10.0).round() / 10.0;
        let _ = client.publish(
            format!("weatherdesk/{}/feels_like", c.station),
            QoS::AtLeastOnce,
            true,
            format!("{f}"),
        );
    }
    if let (Some(p), Some(was)) = (at("pressure"), was) {
        let _ = client.publish(
            format!("weatherdesk/{}/pressure_trend", c.station),
            QoS::AtLeastOnce,
            true,
            press_trend(p, was),
        );
    }
}

/// Connect, announce, and publish every new row until the config changes or the broker goes
/// away. Returns so the caller can try again with whatever the config says then.
fn session(data_dir: &std::path::Path, cfg_path: &std::path::Path, c: &Conf) {
    let Some((host, port, tls)) = parse_url(&c.url) else {
        eprintln!("weatherdesk: MQTT address must be mqtt:// or mqtts:// — the page's ws:// URL is a different listener");
        std::thread::sleep(Duration::from_secs(300));
        return;
    };
    let mut opts = MqttOptions::new(format!("weatherdesk-{}", c.station), host, port);
    opts.set_keep_alive(Duration::from_secs(30));
    if !c.user.is_empty() {
        opts.set_credentials(c.user.clone(), c.pass.clone());
    }
    if tls {
        opts.set_transport(rumqttc::Transport::tls_with_default_config());
    }
    // The broker says we are gone the moment this process does, so Home Assistant shows the
    // sensors unavailable instead of serving a frozen reading forever.
    opts.set_last_will(LastWill::new(
        format!("weatherdesk/{}/status", c.station),
        "offline",
        QoS::AtLeastOnce,
        true,
    ));

    let (client, mut connection) = Client::new(opts, 32);
    // The event loop is what actually moves bytes; without something draining it nothing is sent.
    let pump = std::thread::spawn(move || {
        for e in connection.iter() {
            if let Err(e) = e {
                crate::ingest::note("mqtt", false, err_kind(&e), false);
                // Never the error's Display: a rumqttc error can carry the broker URL, and the
                // URL can carry a password.
                eprintln!("weatherdesk: MQTT disconnected ({})", err_kind(&e));
                return;
            }
        }
    });

    announce(&client, c);
    // The page reads this to decide whether to run its own publisher — two publishers on one
    // topic set is a fight nobody wins.
    crate::ingest::note("mqtt", true, "publishing", false);
    let mut last_announce = std::time::Instant::now();
    let mut last_ts = 0i64;
    loop {
        std::thread::sleep(POLL);
        if pump.is_finished() {
            return;
        }
        // A settings change means a different broker, station or prefix: drop the session and
        // let the caller build the next one.
        match conf(cfg_path) {
            Some(next) if next.url == c.url && next.station == c.station && next.prefix == c.prefix => {}
            _ => {
                let _ = client.publish(
                    format!("weatherdesk/{}/status", c.station),
                    QoS::AtLeastOnce,
                    true,
                    "offline",
                );
                let _ = client.disconnect();
                return;
            }
        }
        if last_announce.elapsed() >= REANNOUNCE {
            announce(&client, c);
            last_announce = std::time::Instant::now();
        }
        let Ok(conn) = store::open(&store::db_path(data_dir)) else { continue };
        let Some((ts, vals, was)) = newest(&conn) else { continue };
        if ts == last_ts {
            continue;
        }
        last_ts = ts;
        publish_row(&client, c, &vals, was);
    }
}

/// Connection errors, named without ever quoting what we were connecting to.
fn err_kind(e: &rumqttc::ConnectionError) -> &'static str {
    use rumqttc::ConnectionError;
    match e {
        ConnectionError::Io(_) => "network",
        ConnectionError::ConnectionRefused(_) => "refused",
        ConnectionError::FlushTimeout => "timeout",
        ConnectionError::MqttState(_) => "protocol",
        _ => "error",
    }
}

/// Connect to the configured broker, publish one retained value, and say what happened. The
/// settings drawer's test button: a password typed with a trailing space is otherwise a silent
/// nothing, discovered days later when an automation doesn't fire.
pub fn probe(cfg_path: &std::path::Path) -> (bool, String) {
    let Some(c) = conf(cfg_path) else {
        return (false, "no broker address, or no station id to publish under".into());
    };
    let Some((host, port, tls)) = parse_url(&c.url) else {
        return (false, "address must start mqtt:// or mqtts:// — a ws:// broker is published by the page instead".into());
    };
    let mut opts = MqttOptions::new(format!("weatherdesk-probe-{}", c.station), host, port);
    opts.set_keep_alive(Duration::from_secs(5));
    if !c.user.is_empty() {
        opts.set_credentials(c.user.clone(), c.pass.clone());
    }
    if tls {
        opts.set_transport(rumqttc::Transport::tls_with_default_config());
    }
    let (client, mut connection) = Client::new(opts, 8);
    let _ = client.publish(
        format!("weatherdesk/{}/status", c.station),
        QoS::AtLeastOnce,
        true,
        "online",
    );
    // Wait for the broker to acknowledge the publish, not merely for the socket to open: a
    // broker that rejects the credentials accepts the TCP connection first.
    for _ in 0..40 {
        match connection.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(rumqttc::Event::Incoming(rumqttc::Packet::PubAck(_)))) => {
                let _ = client.disconnect();
                return (true, format!("published to {}", c.prefix));
            }
            Ok(Err(e)) => return (false, err_kind(&e).into()),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    (false, "no answer from the broker".into())
}

pub fn start(data_dir: std::path::PathBuf, cfg_path: std::path::PathBuf) {
    std::thread::spawn(move || loop {
        match conf(&cfg_path) {
            Some(c) => {
            session(&data_dir, &cfg_path, &c);
            crate::ingest::note("mqtt", false, "reconnecting", false);
        }
            // Nothing configured: this is the default state of the app, not a fault.
            None => std::thread::sleep(Duration::from_secs(30)),
        }
        std::thread::sleep(Duration::from_secs(5));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_addresses_people_actually_paste() {
        assert_eq!(parse_url("mqtt://10.0.0.5:1883"), Some(("10.0.0.5".into(), 1883, false)));
        assert_eq!(parse_url("mqtts://broker.lan"), Some(("broker.lan".into(), 8883, true)));
        // A bare host is the commonest thing typed into a box labelled "broker".
        assert_eq!(parse_url("homeassistant.local"), Some(("homeassistant.local".into(), 1883, false)));
        // The old in-page publisher's websocket URL is a different listener; refuse it rather
        // than silently dialling 1883 on a broker that only has 9001 open.
        assert_eq!(parse_url("ws://10.0.0.5:9001"), None);
        assert_eq!(parse_url(""), None);
    }

    #[test]
    fn feels_like_uses_the_right_formula_at_each_end() {
        // 32 °C at 70% is well above the plain reading.
        assert!(feels_like(32.0, Some(70.0), Some(1.0)) > 38.0);
        // -5 °C in a 5 m/s wind is well below it.
        assert!(feels_like(-5.0, Some(60.0), Some(5.0)) < -8.0);
        // In between, and in still air, the reading is the reading.
        assert_eq!(feels_like(18.0, Some(50.0), Some(0.5)), 18.0);
        assert_eq!(feels_like(-5.0, Some(60.0), None), -5.0);
    }

    #[test]
    fn pressure_trend_bands_match_the_desk() {
        assert_eq!(press_trend(1000.0, 1003.0), "falling rapidly");
        assert_eq!(press_trend(1000.0, 1001.0), "falling");
        assert_eq!(press_trend(1000.0, 1000.2), "steady");
        assert_eq!(press_trend(1003.0, 1000.0), "rising rapidly");
    }
}
