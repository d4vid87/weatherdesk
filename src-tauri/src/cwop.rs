// Report the station to the Citizen Weather Observer Program.
//
// CWOP feeds NOAA's MADIS, which is where a backyard Tempest turns into an input to the models
// that the rest of this dashboard reads back out. Joining is free and the protocol is APRS over
// a plain TCP socket, so this is a socket, a login line and a formatted string every ten
// minutes — no crate, no account, no key.
//
// The passcode for a receive-only citizen station is the constant -1, and callsigns are public
// by design. That is why `cwopId` is not in the server's secret list.

use crate::store;
use std::io::Write;
use std::net::TcpStream;
use std::time::Duration;

const SERVER: &str = "cwop.aprs.net:14580";
const INTERVAL: Duration = Duration::from_secs(600);

/// APRS position format: degrees and decimal minutes, hemisphere last.
fn dm(v: f64, lat: bool) -> String {
    let hemi = if lat { if v < 0.0 { 'S' } else { 'N' } } else if v < 0.0 { 'W' } else { 'E' };
    let a = v.abs();
    let deg = a.floor();
    let min = (a - deg) * 60.0;
    if lat {
        format!("{:02.0}{:05.2}{}", deg, min, hemi)
    } else {
        format!("{:03.0}{:05.2}{}", deg, min, hemi)
    }
}

/// One APRS weather report. Every field is fixed width and zero padded, and a missing reading is
/// dots rather than a zero — a zero here is a real measurement of nothing, which is a lie.
///
/// Units are the protocol's, not the station's: miles per hour, whole degrees Fahrenheit,
/// hundredths of an inch, tenths of a millibar.
#[allow(clippy::too_many_arguments)]
pub fn packet(
    id: &str,
    lat: f64,
    lon: f64,
    utc: (u32, u32, u32), // day of month, hour, minute
    wind_dir: Option<f64>,
    wind_mps: Option<f64>,
    gust_mps: Option<f64>,
    temp_c: Option<f64>,
    rain_1h_mm: Option<f64>,
    rain_24h_mm: Option<f64>,
    rain_day_mm: Option<f64>,
    humidity: Option<f64>,
    pressure_mb: Option<f64>,
) -> String {
    let f3 = |v: Option<f64>| v.map(|x| format!("{:03.0}", x)).unwrap_or_else(|| "...".into());
    let mph = |v: Option<f64>| f3(v.map(|x| x * 2.236_936));
    let hun = |v: Option<f64>| v.map(|x| format!("{:03.0}", x / 25.4 * 100.0)).unwrap_or_else(|| "...".into());
    let temp = temp_c
        .map(|c| {
            let f = c * 9.0 / 5.0 + 32.0;
            // Below zero Fahrenheit APRS wants a signed two-digit field.
            if f < 0.0 { format!("-{:02.0}", f.abs()) } else { format!("{:03.0}", f) }
        })
        .unwrap_or_else(|| "...".into());
    // Humidity is two digits and 100% is sent as "00".
    let hum = humidity
        .map(|h| format!("{:02.0}", if h >= 99.5 { 0.0 } else { h }))
        .unwrap_or_else(|| "..".into());
    let press = pressure_mb.map(|p| format!("b{:05.0}", p * 10.0)).unwrap_or_default();
    format!(
        "{id}>APRS,TCPIP*:@{:02}{:02}{:02}z{}/{}_{}/{}g{}t{}r{}p{}P{}h{}{}WeatherDesk",
        utc.0,
        utc.1,
        utc.2,
        dm(lat, true),
        dm(lon, false),
        f3(wind_dir),
        mph(wind_mps),
        mph(gust_mps),
        temp,
        hun(rain_1h_mm),
        hun(rain_24h_mm),
        hun(rain_day_mm),
        hum,
        press,
    )
}

/// Latest reading plus the rain sums, straight out of the archive. The tail of the vector — UV,
/// solar and the day's rain — is only read by the upload relay; CWOP's packet stops at pressure.
fn latest(conn: &rusqlite::Connection) -> Option<(i64, Vec<Option<f64>>, f64, f64)> {
    let row = conn
        .query_row(
            "SELECT ts, wind_dir, wind_avg, wind_gust, temp, humidity, pressure, uv, solar, day_rain \
             FROM obs ORDER BY ts DESC LIMIT 1",
            [],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    vec![r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?],
                ))
            },
        )
        .ok()?;
    let (ts, vals) = row;
    let sum = |since: i64| -> f64 {
        conn.query_row("SELECT COALESCE(SUM(rain), 0) FROM obs WHERE ts > ?1", [since], |r| r.get(0))
            .unwrap_or(0.0)
    };
    Some((ts, vals, sum(ts - 3600), sum(ts - 86_400)))
}

fn send(line: &str, id: &str) -> std::io::Result<()> {
    let mut sock = TcpStream::connect(SERVER)?;
    sock.set_write_timeout(Some(Duration::from_secs(10)))?;
    sock.set_read_timeout(Some(Duration::from_secs(10)))?;
    writeln!(sock, "user {id} pass -1 vers WeatherDesk 3.0")?;
    writeln!(sock, "{line}")?;
    sock.flush()
}

/// Ten minutes apart, forever, while a callsign is set. Reads the callsign fresh each round so
/// turning it off in the drawer takes effect without a restart.
pub fn start(data_dir: std::path::PathBuf, cfg_path: std::path::PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(INTERVAL);
        let Some(id) = crate::setting(&cfg_path, "cwopId").filter(|v| !v.is_empty()) else { continue };
        let (lat, lon) = (
            crate::setting(&cfg_path, "lat").and_then(|v| v.parse::<f64>().ok()),
            crate::setting(&cfg_path, "lon").and_then(|v| v.parse::<f64>().ok()),
        );
        let (Some(lat), Some(lon)) = (lat, lon) else { continue };
        let Ok(conn) = store::open(&store::db_path(&data_dir)) else { continue };
        let Some((ts, v, rain_1h, rain_24h)) = latest(&conn) else { continue };
        // Stale readings are worse than none: a hub that went offline an hour ago would
        // otherwise keep reporting the same temperature into a national dataset.
        if (crate::server::epoch() as i64) - ts > 1800 {
            continue;
        }
        let day = crate::server::utc_dhm(ts);
        let line = packet(
            &id, lat, lon, day, v[0], v[1], v[2], v[3],
            Some(rain_1h), Some(rain_24h), Some(rain_24h), v[4], v[5],
        );
        match send(&line, &id) {
            Ok(()) => eprintln!("weatherdesk: reported to CWOP as {id}"),
            Err(e) => eprintln!("weatherdesk: CWOP send failed ({})", e.kind()),
        }
    });
}

// --- Relaying to Weather Underground and PWSWeather ---
//
// Both speak the same protocol a station would have spoken to them directly, so this is the same
// readings sent on a second time. It exists because pointing a console at this app takes it away
// from wherever it used to upload — Ray's Vevor and every other clone can only be told one
// address. Ten lines here gives them both.

/// The reading as WU protocol query parameters. Imperial, because the protocol is, and a missing
/// reading is left out entirely rather than sent as a zero — a zero is a measurement.
fn wu_params(dateutc: &str, v: &[Option<f64>], rain_1h: f64, rain_day: Option<f64>) -> String {
    let mut q = format!("&dateutc={}&softwaretype=WeatherDesk&action=updateraw", dateutc.replace(' ', "%20"));
    let mut put = |k: &str, val: Option<f64>| {
        if let Some(x) = val {
            q.push_str(&format!("&{k}={x:.2}"));
        }
    };
    put("winddir", v[0]);
    put("windspeedmph", v[1].map(|x| x / MPS_PER_MPH));
    put("windgustmph", v[2].map(|x| x / MPS_PER_MPH));
    put("tempf", v[3].map(|c| c * 9.0 / 5.0 + 32.0));
    put("humidity", v[4]);
    // ponytail: baromin is the station's own pressure, not sea level, so it reads low at
    // altitude — derive SLP from the configured elevation if anyone up a mountain complains.
    put("baromin", v[5].map(|mb| mb / MB_PER_INHG));
    put("UV", v[6]);
    put("solarradiation", v[7]);
    put("dailyrainin", rain_day.map(|mm| mm / 25.4));
    put("rainin", Some(rain_1h / 25.4));
    q
}

const MPS_PER_MPH: f64 = 0.447_04;
const MB_PER_INHG: f64 = 33.863_9;

/// A minute apart while either service has an id and a key. Same settings-per-tick habit as
/// `start`, so filling the fields in takes effect without a restart.
pub fn start_relay(data_dir: std::path::PathBuf, cfg_path: std::path::PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(60));
        let s = |k: &str| crate::setting(&cfg_path, k).unwrap_or_default();
        let (wu_id, wu_key, pws_id, pws_key) = (s("wuId"), s("wuKey"), s("pwsId"), s("pwsKey"));
        let wu = !wu_id.is_empty() && !wu_key.is_empty();
        let pws = !pws_id.is_empty() && !pws_key.is_empty();
        if !wu && !pws {
            continue;
        }
        let Ok(conn) = store::open(&store::db_path(&data_dir)) else { continue };
        let Some((ts, v, rain_1h, _)) = latest(&conn) else { continue };
        // Same reasoning as CWOP: a station that went offline an hour ago must not keep
        // publishing the same temperature.
        if (crate::server::epoch() as i64) - ts > 1800 {
            continue;
        }
        let (y, mo, d, h, mi, sec) = crate::server::utc_ymdhms(ts);
        let params = wu_params(&format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{sec:02}"), &v, rain_1h, v[8]);
        // Status code or error kind only, never the URL or the error's Display: the password
        // rides in the query string, which is how both of these protocols work.
        let post = |what: &str, url: String| match ureq::get(&url).timeout(Duration::from_secs(20)).call() {
            Ok(_) => {}
            Err(ureq::Error::Status(code, _)) => eprintln!("weatherdesk: {what} upload refused ({code})"),
            Err(ureq::Error::Transport(t)) => eprintln!("weatherdesk: {what} upload failed ({:?})", t.kind()),
        };
        if wu {
            post("WU", format!(
                "https://weatherstation.wunderground.com/weatherstation/updateweatherstation.php?ID={wu_id}&PASSWORD={wu_key}{params}"
            ));
        }
        if pws {
            post("PWSWeather", format!(
                "https://pwsupdate.pwsweather.com/api/v1/submitwx?ID={pws_id}&PASSWORD={pws_key}{params}"
            ));
        }
    });
}

// ponytail: one check, against a hand-worked example — every field here is fixed width, and one
// character out of place makes the whole report silently invalid at the other end.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_is_fixed_width_aprs() {
        let line = packet(
            "EW1234",
            33.1234,
            -95.6789,
            (18, 14, 30),
            Some(180.0),
            Some(4.4704),   // 10 mph
            Some(8.9408),   // 20 mph
            Some(25.0),     // 77 °F
            Some(2.54),     // 0.10 in
            Some(25.4),     // 1.00 in
            Some(25.4),
            Some(55.0),
            Some(1013.2),
        );
        assert!(line.starts_with("EW1234>APRS,TCPIP*:@181430z3307.40N/09540.73W_"), "{line}");
        assert!(line.contains("_180/010g020t077"), "wind or temperature field moved: {line}");
        assert!(line.contains("r010p100P100h55b10132"), "rain, humidity or pressure moved: {line}");
    }

    #[test]
    fn missing_readings_are_dots_not_zeroes() {
        let line = packet("EW1", 0.0, 0.0, (1, 0, 0), None, None, None, None, None, None, None, None, None);
        assert!(line.contains("_.../...g...t..."), "a missing reading was reported as zero: {line}");
        assert!(!line.contains('b'), "no pressure means no pressure field: {line}");
    }

    #[test]
    fn relay_params_are_imperial() {
        let v = vec![
            Some(180.0), Some(4.4704), Some(8.9408), Some(25.0), Some(55.0), Some(1013.21),
            Some(7.0), Some(812.4), Some(2.54),
        ];
        let q = wu_params("2026-08-21 14:30:00", &v, 0.0, v[8]);
        assert!(q.contains("&tempf=77.00"), "25 C should upload as 77 F: {q}");
        assert!(q.contains("&windspeedmph=10.00") && q.contains("&windgustmph=20.00"), "{q}");
        assert!(q.contains("&baromin=29.92"), "{q}");
        assert!(q.contains("&dailyrainin=0.10"), "{q}");
        assert!(q.contains("&dateutc=2026-08-21%2014:30:00"), "{q}");
    }

    #[test]
    fn a_missing_relay_reading_is_omitted_not_zeroed() {
        let v = vec![None, None, None, None, Some(55.0), None, None, None, None];
        let q = wu_params("2026-08-21 14:30:00", &v, 0.0, None);
        for absent in ["tempf", "winddir", "baromin", "solarradiation", "dailyrainin"] {
            assert!(!q.contains(absent), "{absent} was sent without a reading behind it: {q}");
        }
        assert!(q.contains("&humidity=55.00"), "{q}");
    }
}
