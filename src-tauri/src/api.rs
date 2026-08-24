// The versioned read-only API. One endpoint, named fields, SI, no credentials.
//
// Everything else this server answers is shaped for the dashboard and free to change with it —
// `/history/tuples` hands out bare arrays in a column order the page happens to know. That is a
// fine contract with a page shipped in the same binary and a terrible one with a Home Assistant
// integration somebody installed six months ago. `/api/v1` is the one that has to stay still.

use crate::{ingest, server::State, store};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Open-meteo, cached: (fetched_at, body). A forecast is the same for everyone in the house, and
/// Home Assistant polling every minute must not become a request upstream every minute.
fn cache() -> &'static Mutex<Option<(u64, serde_json::Value)>> {
    static C: OnceLock<Mutex<Option<(u64, serde_json::Value)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

const FORECAST_TTL: u64 = 900;

/// Today's high, low, precipitation chance and condition code, for the weather entity. Fetched
/// from the same free endpoint the page uses, in SI whatever the dashboard is set to.
fn forecast(cfg: &std::path::Path) -> Option<serde_json::Value> {
    let now = crate::server::epoch();
    if let Ok(c) = cache().lock() {
        if let Some((at, body)) = c.as_ref() {
            if now.saturating_sub(*at) < FORECAST_TTL {
                return Some(body.clone());
            }
        }
    }
    let num = |k: &str| crate::setting(cfg, k)?.trim_matches('"').parse::<f64>().ok();
    let (lat, lon) = (num("lat")?, num("lon")?);
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}\
         &daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max\
         &forecast_days=5&timezone=auto&timeformat=unixtime"
    );
    let body = match ureq::get(&url).timeout(Duration::from_secs(20)).call() {
        Ok(r) => serde_json::from_str::<serde_json::Value>(&r.into_string().ok()?).ok()?,
        // Status codes only: an upstream URL carries the coordinates of somebody's house.
        Err(ureq::Error::Status(code, _)) => {
            eprintln!("weatherdesk: forecast fetch failed ({code})");
            return None;
        }
        Err(_) => return None,
    };
    let d = body.get("daily")?;
    let day = |k: &str, i: usize| d.get(k).and_then(|a| a.get(i)).cloned().unwrap_or(serde_json::Value::Null);
    let days: Vec<serde_json::Value> = (0..5)
        .map(|i| {
            serde_json::json!({
                "at": day("time", i),
                "high_c": day("temperature_2m_max", i),
                "low_c": day("temperature_2m_min", i),
                "precip_chance": day("precipitation_probability_max", i),
                "wmo_code": day("weather_code", i),
            })
        })
        .collect();
    let out = serde_json::json!({ "days": days });
    if let Ok(mut c) = cache().lock() {
        *c = Some((now, out.clone()));
    }
    Some(out)
}

/// The newest archive row as named fields, plus the two derived values the MQTT publisher also
/// sends. Named, because a Home Assistant integration must not have to know a column order.
fn current(conn: &rusqlite::Connection) -> Option<serde_json::Value> {
    let cols = store::FIELDS.join(", ");
    let (ts, vals) = conn
        .query_row(&format!("SELECT ts, {cols} FROM obs ORDER BY ts DESC LIMIT 1"), [], |r| {
            let ts: i64 = r.get(0)?;
            let mut v = Vec::with_capacity(store::FIELDS.len());
            for i in 1..=store::FIELDS.len() {
                v.push(r.get::<_, Option<f64>>(i)?);
            }
            Ok((ts, v))
        })
        .ok()?;
    let at = |name: &str| store::FIELDS.iter().position(|f| *f == name).and_then(|i| vals[i]);
    let mut obj = serde_json::Map::new();
    obj.insert("at".into(), ts.into());
    for (f, v) in store::FIELDS.iter().zip(&vals) {
        obj.insert((*f).into(), match v {
            Some(x) => serde_json::Value::from(*x),
            None => serde_json::Value::Null,
        });
    }
    if let Some(t) = at("temp") {
        let f = (crate::mqtt::feels_like(t, at("humidity"), at("wind_avg")) * 10.0).round() / 10.0;
        obj.insert("feels_like".into(), f.into());
    }
    if let Some(p) = at("pressure") {
        let was = conn
            .query_row(
                "SELECT pressure FROM obs WHERE ts <= ?1 AND pressure IS NOT NULL ORDER BY ts DESC LIMIT 1",
                [ts - 3 * 3600],
                |r| r.get::<_, Option<f64>>(0),
            )
            .ok()
            .flatten();
        if let Some(was) = was {
            obj.insert("pressure_trend".into(), crate::mqtt::press_trend(p, was).into());
        }
    }
    Some(serde_json::Value::Object(obj))
}

/// The whole payload. Units are SI and stated as such, so a consumer never has to guess which
/// way the dashboard was set when it read this.
pub fn snapshot(state: &Arc<State>) -> String {
    let cfg = &state.cfg_path;
    let get = |k: &str| crate::setting(cfg, k).map(|v| v.trim_matches('"').to_string()).unwrap_or_default();
    let obs = state.db().and_then(|c| current(&c));
    let body = serde_json::json!({
        "api": 1,
        "version": env!("CARGO_PKG_VERSION"),
        "units": "si",
        "station": {
            "id": get("stationId"),
            "name": get("stationName"),
            "source": get("stationSource"),
            "lat": get("lat").parse::<f64>().ok(),
            "lon": get("lon").parse::<f64>().ok(),
        },
        "current": obs,
        "forecast": forecast(cfg),
        "health": serde_json::from_str::<serde_json::Value>(&ingest::diag_json()).unwrap_or_default(),
    });
    body.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Named fields, and the derived pair alongside them — the whole point of the endpoint.
    #[test]
    fn current_is_named_fields_not_a_bare_tuple() {
        let conn = store::open(std::path::Path::new(":memory:")).unwrap();
        let mut row = vec![None; store::FIELDS.len()];
        let put = |row: &mut Vec<Option<f64>>, name: &str, v: f64| {
            row[store::FIELDS.iter().position(|f| *f == name).unwrap()] = Some(v);
        };
        put(&mut row, "temp", 31.5);
        put(&mut row, "humidity", 72.0);
        put(&mut row, "pressure", 1006.4);
        let now = crate::server::epoch() as i64;
        conn.execute(
            &format!(
                "INSERT INTO obs (ts, {}) VALUES ({}, {})",
                store::FIELDS.join(", "),
                now,
                row.iter().map(|v| v.map(|x| x.to_string()).unwrap_or_else(|| "NULL".into())).collect::<Vec<_>>().join(", ")
            ),
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO obs (ts, pressure) VALUES (?1, 1009.9)", [now - 3 * 3600]).unwrap();

        let v = current(&conn).unwrap();
        assert_eq!(v["temp"], 31.5);
        assert_eq!(v["at"], now);
        // A field the station doesn't have is null, not missing and not zero.
        assert!(v["lux"].is_null());
        // Heat index at 31.5 °C and 72% is well above the plain reading.
        assert!(v["feels_like"].as_f64().unwrap() > 38.0);
        assert_eq!(v["pressure_trend"], "falling rapidly");
    }
}
