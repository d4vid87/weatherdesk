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

/// Latest reading plus the rain sums, straight out of the archive.
fn latest(conn: &rusqlite::Connection) -> Option<(i64, Vec<Option<f64>>, f64, f64)> {
    let row = conn
        .query_row(
            "SELECT ts, wind_dir, wind_avg, wind_gust, temp, humidity, pressure FROM obs ORDER BY ts DESC LIMIT 1",
            [],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    vec![r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?],
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
}
