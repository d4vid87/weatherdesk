// Every weather station that isn't a Tempest.
//
// The Tempest `obs_st` tuple is this app's internal format end to end — SQLite columns
// (`store::FIELDS`), the page's `OBS` map, CWOP, MQTT, the rules engine. So the whole of
// multi-brand support is one conversion at this boundary: a foreign report becomes an SI tuple
// and a synthesized Tempest-shaped packet, and nothing downstream branches. Same trick
// `api.js metarObs()` plays with a METAR.
//
// Two directions in:
//   * push — Ecowitt "customized upload" (POST, urlencoded), Ambient's awnet custom server
//     (GET query string), the Weather Underground protocol that half the clones speak, and
//     rtl_433 JSON piped in by curl (that is the AcuRite Iris story: no API exists).
//   * poll — Davis WeatherLink Live on the LAN, Ambient's cloud (which is also how a
//     KestrelMet 6000 is read), and La Crosse's unofficial app API.
//
// The imperial field vocabulary is shared across Ecowitt/Ambient/WU/AWN, so one mapping table
// serves all four. WLL and rtl_433 get their names translated into that vocabulary first.
//
// ponytail: one station per install. The archive keys on timestamp with no station column, so
// two consoles pointed here would interleave into one row set. Documented, not enforced.

use crate::server::{epoch, State};
use crate::store;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// A reading we heard ourselves, over the LAN: push protocols and the Davis poll.
pub const SRC_INGEST: i64 = 3;
/// A reading that came back from somebody's cloud. Separate so an unofficial API going bad is
/// one `DELETE FROM obs WHERE src = 4` away from gone.
pub const SRC_CLOUD: i64 = 4;

/// Consoles report every 16 seconds; the archive is a row a minute. 55 rather than 60 so a
/// console that drifts slightly slow doesn't lose every other minute to the guard.
const MIN_GAP: u64 = 55;

const MPS_PER_MPH: f64 = 0.447_04;
const MB_PER_INHG: f64 = 33.863_9;
const MM_PER_IN: f64 = 25.4;

type Fields = HashMap<String, String>;

// --- Parsing ---

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_pairs(s: &str, into: &mut Fields) {
    for kv in s.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            into.insert(percent_decode(k).to_lowercase(), percent_decode(v));
        }
    }
}

/// Flatten a JSON object one level into the same string map. rtl_433 lines and AWN's `lastData`
/// are both flat objects of numbers, so there is nothing deeper to walk.
fn parse_json(v: &serde_json::Value, into: &mut Fields) {
    if let Some(obj) = v.as_object() {
        for (k, val) in obj {
            let s = val.as_str().map(String::from).unwrap_or_else(|| val.to_string());
            into.insert(k.to_lowercase(), s);
        }
    }
}

/// Whatever the console sent, as one lower-cased map. Query string and body are merged because
/// the WU protocol puts everything in the query and Ecowitt puts everything in the body.
fn collect(url: &str, body: &str) -> Fields {
    let mut f = Fields::new();
    if let Some(q) = url.split('?').nth(1) {
        parse_pairs(q, &mut f);
    }
    let trimmed = body.trim_start();
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            parse_json(&v, &mut f);
        }
    } else if !trimmed.is_empty() {
        parse_pairs(trimmed, &mut f);
    }
    f
}

// --- Mapping ---

fn num(f: &Fields, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| f.get(*k)).and_then(|v| v.trim().parse::<f64>().ok())
}

/// The whole of multi-brand support, in one table: foreign field names on the right, `obs_st`
/// slot numbers on the left. Slot 0 (time) is the caller's — a push gets `now()` because
/// console clocks lie, a poll gets the payload's own stamp so CWOP's staleness guard still
/// means something.
///
/// Slots left NULL: 1 wind lull and 5 wind interval (nobody else reports them), 9 lux (a
/// Tempest measures it, a WS-2902 does not), 16 battery (every other brand reports a flag, and
/// `env.js` compares that slot against a Tempest's 2.355 V — a flag there would read as a flat
/// battery forever).
///
/// Rain and lightning arrive as running daily totals, but slot 12 is per-interval and slot 15 is
/// a per-interval count, so both are differenced against what we last stored.
fn tuple(f: &Fields, ts: f64, mem: &mut Mem) -> Vec<Option<f64>> {
    let f_to_c = |v: f64| (v - 32.0) / 1.8;

    let temp = num(f, &["tempf", "temp_out_f"])
        .map(f_to_c)
        .or_else(|| num(f, &["temperature_c", "temp_c", "temp"]));
    let wind_avg = num(f, &["windspeedmph"])
        .map(|v| v * MPS_PER_MPH)
        .or_else(|| num(f, &["wind_avg_m_s"]));
    let gust = num(f, &["windgustmph"])
        .map(|v| v * MPS_PER_MPH)
        .or_else(|| num(f, &["wind_max_m_s"]));
    let dir = num(f, &["winddir", "wind_dir_deg"]);
    // Absolute (station) pressure is what the archive holds — every consumer that wants sea
    // level derives it from the station's own altitude. `baromin` is the WU protocol's spelling.
    let press = num(f, &["baromabsin", "baromrelin", "baromin"])
        .map(|v| v * MB_PER_INHG)
        .or_else(|| num(f, &["pressure_hpa", "pressure_mb"]));
    let rh = num(f, &["humidity", "humidity_out"]);
    let uv = num(f, &["uv", "uvi", "uv_index"]);
    let solar = num(f, &["solarradiation", "solar_rad"]);

    // Piezo gauges (the Wittboy's) report under their own names; prefer them when present.
    let day_rain_mm = num(f, &["drain_piezo", "dailyrainin"])
        .map(|v| v * MM_PER_IN)
        .or_else(|| num(f, &["rain_mm", "dailyrainmm"]));
    let rain = day_rain_mm.map(|cur| delta(&mut mem.rain, cur));

    let strike_dist = num(f, &["lightning", "storm_dist_km", "lightning_distance"]);
    let strikes = num(f, &["lightning_num", "strike_count", "lightning_day"])
        .map(|cur| delta(&mut mem.strikes, cur));

    let interval = mem.last_ts.map(|prev| (((ts - prev) / 60.0).round()).clamp(1.0, 30.0));

    vec![
        Some(ts),
        None,                                 // 1 wind lull
        wind_avg,                             // 2
        gust,                                 // 3
        dir,                                  // 4
        None,                                 // 5 wind interval
        press,                                // 6
        temp,                                 // 7
        rh,                                   // 8
        None,                                 // 9 lux
        uv,                                   // 10
        solar,                                // 11
        rain,                                 // 12 this interval
        rain.map(|r| if r > 0.0 { 1.0 } else { 0.0 }), // 13 precip type
        strike_dist,                          // 14
        strikes,                              // 15 this interval
        None,                                 // 16 battery volts
        interval,                             // 17
        day_rain_mm,                          // 18
    ]
}

// --- Running counters ---

/// What the last stored report said, so a running total can be turned into an interval.
#[derive(Default)]
struct Mem {
    rain: Option<f64>,
    strikes: Option<f64>,
    last_ts: Option<f64>,
}

/// Difference a running total against the last stored one. A drop means the console rolled its
/// daily counter over (midnight, or a reset), and the new value is the accumulation since — the
/// alternative, a negative rainfall, would corrupt every SUM downstream. The first report after a
/// start scores zero: we have no idea how much of that total we already recorded.
///
/// ponytail: the counters live in memory, so a restart forfeits one interval. Persist them in the
/// `meta` table if that ever shows up in someone's rain total.
fn delta(prev: &mut Option<f64>, cur: f64) -> f64 {
    let was = prev.replace(cur);
    match was {
        None => 0.0,
        Some(p) if cur < p => cur,
        Some(p) => cur - p,
    }
}

fn mem() -> &'static Mutex<Mem> {
    static M: OnceLock<Mutex<Mem>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(Mem::default()))
}

// --- Publishing ---

/// Make the report look like it came off a Tempest hub: the page's UDP path, the MQTT bridge and
/// the rules engine all read `state.packets` and the `udp` SSE event, and none of them should
/// learn a second shape.
///
/// Cadence matters as much as shape. `rapid_wind` goes out per report, because that is what the
/// gauge animates on. `obs_st` goes out only when a row is stored, because `rules.js` treats
/// each one as a fresh interval and would otherwise count the same rain three times a minute.
fn publish(state: &Arc<State>, kind: &str, body: String) {
    if let Ok(mut map) = state.packets.lock() {
        map.insert(kind.into(), body.clone());
    }
    state.broadcast("udp", &body);
}

fn n(v: Option<f64>) -> String {
    v.map(|x| format!("{x}")).unwrap_or_else(|| "null".into())
}

/// One foreign report, whatever spoke it, from parse to stored row. Returns true when a row was
/// written.
///
/// The counters are only advanced on a report we keep — a differenced total against a report we
/// threw away would drop that interval's rain on the floor.
fn take(state: &Arc<State>, f: &Fields, ts: f64, src: i64) -> bool {
    let at = epoch();
    let wind = num(f, &["windspeedmph"]).map(|v| v * MPS_PER_MPH).or_else(|| num(f, &["wind_avg_m_s"]));
    if let (Some(sp), Some(dir)) = (wind, num(f, &["winddir", "wind_dir_deg"])) {
        publish(
            state,
            "rapid_wind",
            format!("{{\"type\":\"rapid_wind\",\"ob\":[{},{sp},{dir}],\"_at\":{at}}}", ts as i64),
        );
    }

    let mut m = mem().lock().unwrap();
    if m.last_ts.map(|prev| ts - prev < MIN_GAP as f64).unwrap_or(false) {
        return false;
    }
    let t = tuple(f, ts, &mut m);
    m.last_ts = Some(ts);
    drop(m);

    if let Some(conn) = state.db() {
        store::insert(&conn, &t, src);
    }
    if let (Some(d), Some(c)) = (t[14], t[15]) {
        if c > 0.0 {
            publish(
                state,
                "evt_strike",
                format!("{{\"type\":\"evt_strike\",\"evt\":[{},{d},{c}],\"_at\":{at}}}", ts as i64),
            );
        }
    }
    publish(
        state,
        "obs_st",
        format!(
            "{{\"type\":\"obs_st\",\"obs\":[[{}]],\"_at\":{at}}}",
            t.iter().map(|v| n(*v)).collect::<Vec<_>>().join(",")
        ),
    );
    true
}

// --- The push route ---

/// `/ingest`, plus the paths consoles default to. Returns the HTTP status; the caller writes the
/// body, which has to be the literal `success` because WU clients check for it.
///
/// `ingestKey`, when set, has to appear as `?key=` or as the last path segment — a Wittboy can
/// only be told a path, not a header. Empty by default: this server already trusts its LAN with
/// `/config`, and a station that needs a shared secret to report is a station nobody sets up.
pub fn accept(state: &Arc<State>, url: &str, body: &str) -> u16 {
    let want = crate::setting(&state.cfg_path, "ingestKey").unwrap_or_default();
    if !want.is_empty() {
        let path = url.split('?').next().unwrap_or("");
        let given = crate::server::query(url, "key").unwrap_or_default();
        if given != want && !path.ends_with(&format!("/{want}")) {
            return 401;
        }
    }
    let f = collect(url, body);
    // Anything with no temperature and no wind in it is not a weather report — a console
    // probing the path, or a browser that wandered in.
    if num(&f, &["tempf", "temperature_c", "temp_c", "temp"]).is_none() && num(&f, &["windspeedmph", "wind_avg_m_s"]).is_none() {
        return 400;
    }
    // Console clocks are wrong often enough that trusting `dateutc` would scatter rows across
    // the archive. What matters is when we heard it.
    take(state, &f, epoch() as f64, SRC_INGEST);
    200
}

// --- Pollers ---

fn get(url: &str) -> Option<serde_json::Value> {
    // Status code only, never the error's Display: these URLs carry API keys in their query
    // strings and this string goes to a log.
    match ureq::get(url).timeout(Duration::from_secs(20)).call() {
        Ok(r) => r.into_string().ok().and_then(|b| serde_json::from_str(&b).ok()),
        Err(ureq::Error::Status(code, _)) => {
            eprintln!("weatherdesk: station poll refused ({code})");
            None
        }
        Err(_) => None,
    }
}

/// Davis WeatherLink Live, which is how a Vantage Pro2 or a Vantage Vue gets on the network
/// (a Console 6313 serves the same route). Local HTTP, no key, no cloud.
///
/// ponytail: WLL also broadcasts 2.5-second wind over UDP 22222 after an arming request. The
/// 10-second poll is the same data at a resolution the gauge can't show; arm the UDP stream if
/// somebody wants the fast needle.
fn poll_wll(state: &Arc<State>, host: &str) {
    let Some(v) = get(&format!("http://{host}/v1/current_conditions")) else { return };
    let Some(conds) = v.pointer("/data/conditions").and_then(|c| c.as_array()) else { return };
    let ts = v.pointer("/data/ts").and_then(|t| t.as_f64()).unwrap_or(epoch() as f64);

    let mut f = Fields::new();
    for c in conds {
        let g = |k: &str| c.get(k).and_then(|x| x.as_f64());
        // Structure type 1 is the ISS — the outdoor sensor suite. The others are the barometer
        // (3), the indoor sensor (4) and any extra transmitters.
        match c.get("data_structure_type").and_then(|x| x.as_i64()).unwrap_or(0) {
            1 => {
                let put = |f: &mut Fields, k: &str, v: Option<f64>| {
                    if let Some(v) = v {
                        f.insert(k.into(), v.to_string());
                    }
                };
                put(&mut f, "tempf", g("temp"));
                put(&mut f, "humidity", g("hum"));
                put(&mut f, "windspeedmph", g("wind_speed_avg_last_1_min"));
                put(&mut f, "windgustmph", g("wind_speed_hi_last_2_min"));
                put(&mut f, "winddir", g("wind_dir_scalar_avg_last_1_min"));
                put(&mut f, "solarradiation", g("solar_rad"));
                put(&mut f, "uv", g("uv_index"));
                // Davis reports rain as tip counts and tells you separately how big a tip is.
                if let Some(counts) = g("rainfall_daily") {
                    f.insert("dailyrainmm".into(), (counts * rain_bucket_mm(c)).to_string());
                }
            }
            3 => {
                if let Some(bar) = g("bar_absolute") {
                    f.insert("baromabsin".into(), bar.to_string());
                }
            }
            _ => {}
        }
    }
    if !f.is_empty() {
        take(state, &f, ts, SRC_INGEST);
    }
}

/// Millimetres per tip, from the gauge Davis says is installed. Default is the 0.01 in gauge
/// sold in North America, which is what an unset field almost always means.
fn rain_bucket_mm(c: &serde_json::Value) -> f64 {
    match c.get("rain_size").and_then(|x| x.as_i64()).unwrap_or(1) {
        2 => 0.2,
        3 => 0.1,
        4 => 0.0254,
        _ => 0.254,
    }
}

/// Ambient Weather Network. The official API, and the only way to read a KestrelMet 6000 —
/// it has no local protocol at all. Also covers any Ambient console whose owner would rather
/// not point it away from Ambient's own servers.
fn poll_awn(state: &Arc<State>, api_key: &str, app_key: &str) {
    let url = format!("https://rt.ambientweather.net/v1/devices?applicationKey={app_key}&apiKey={api_key}");
    let Some(v) = get(&url) else { return };
    let Some(last) = v.get(0).and_then(|d| d.get("lastData")) else { return };
    let mut f = Fields::new();
    parse_json(last, &mut f);
    // `dateutc` is milliseconds here, unlike everywhere else in this file.
    let ts = last.get("dateutc").and_then(|t| t.as_f64()).map(|ms| ms / 1000.0).unwrap_or(epoch() as f64);
    take(state, &f, ts, SRC_CLOUD);
}

/// La Crosse. Unofficial: there is no published API, and this is the app's own — a Google
/// Identity Toolkit login against a key shipped inside the app, then their gateway. Expect it to
/// break without warning; that is why these rows are `SRC_CLOUD` and can be deleted on their own.
const LACROSSE_KEY: &str = "AIzaSyD-Uo0hkRIeDYJhyyIg-TvAv8HhExARIO4";

fn lacrosse_token(email: &str, pass: &str) -> Option<String> {
    let url = format!("https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key={LACROSSE_KEY}");
    let body = serde_json::json!({"email": email, "password": pass, "returnSecureToken": true});
    match ureq::post(&url)
        .timeout(Duration::from_secs(20))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
    {
        Ok(r) => serde_json::from_str::<serde_json::Value>(&r.into_string().ok()?)
            .ok()?
            .get("idToken")?
            .as_str()
            .map(String::from),
        Err(ureq::Error::Status(code, _)) => {
            eprintln!("weatherdesk: La Crosse login refused ({code})");
            None
        }
        Err(_) => None,
    }
}

fn bearer(url: &str, token: &str) -> Option<serde_json::Value> {
    match ureq::get(url).timeout(Duration::from_secs(20)).set("Authorization", &format!("Bearer {token}")).call() {
        Ok(r) => r.into_string().ok().and_then(|b| serde_json::from_str(&b).ok()),
        Err(ureq::Error::Status(code, _)) => {
            eprintln!("weatherdesk: La Crosse read refused ({code})");
            None
        }
        Err(_) => None,
    }
}

fn poll_lacrosse(state: &Arc<State>, token: &str) {
    const GW: &str = "https://lax-gateway.appspot.com/_ah/api/lacrosseClient/v1.1/active-user";
    let Some(locs) = bearer(&format!("{GW}/locations"), token) else { return };
    let Some(loc) = locs.pointer("/items/0/id").and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|i| i.to_string()))) else { return };
    let Some(devs) = bearer(&format!("{GW}/location/{loc}/sensorAssociations?prettyPrint=false"), token) else { return };
    let Some(dev) = devs.pointer("/items/0/sensor") else { return };
    let Some(id) = dev.get("id").and_then(|v| v.as_str()) else { return };

    let feed = format!(
        "https://ingv2.lacrossetechnology.com/api/v1.1/active-user/device-association/ref.user-device.{id}/feed\
         ?fields=temperature,humidity,barometric_pressure,wind_speed,wind_heading,rain_total&aggregates=ai.ticks.1&types=spot"
    );
    let Some(v) = bearer(&feed, token) else { return };
    // The feed nests one object per field, each with its own trailing sample. Walk it rather
    // than index it: which fields come back depends on which sensors the account owns.
    let mut f = Fields::new();
    let mut ts = epoch() as f64;
    for (_, per_device) in v.as_object().into_iter().flatten() {
        for (name, series) in per_device.as_object().into_iter().flatten() {
            let Some(last) = series.pointer("/values").and_then(|a| a.as_array()).and_then(|a| a.last()) else { continue };
            if let Some(u) = last.get("u").and_then(|u| u.as_f64()) {
                ts = u;
            }
            let Some(val) = last.pointer("/s").and_then(|s| s.as_f64()) else { continue };
            let key = match name.as_str() {
                "temperature" => "temperature_c",
                "humidity" => "humidity",
                "barometric_pressure" => "pressure_hpa",
                "wind_speed" => "wind_avg_m_s",
                "wind_heading" => "wind_dir_deg",
                "rain_total" => "rain_mm",
                _ => continue,
            };
            f.insert(key.into(), val.to_string());
        }
    }
    if !f.is_empty() {
        take(state, &f, ts, SRC_CLOUD);
    }
}

/// One thread for every pulled source. Settings are read fresh each tick, the same way
/// `cwop::start` does it, so filling in a WeatherLink address in the drawer takes effect without
/// a restart.
///
/// ponytail: no Ecowitt `get_livedata_info` poller. Push covers every gateway they sell, and it
/// costs the user nothing that their console isn't already configured to spend.
pub fn start_pollers(state: Arc<State>) {
    std::thread::spawn(move || {
        let mut tick: u64 = 0;
        let mut lax: Option<(String, u64)> = None; // token, minted at
        loop {
            std::thread::sleep(Duration::from_secs(10));
            tick += 1;
            let s = |k: &str| crate::setting(&state.cfg_path, k).unwrap_or_default();

            let wll = s("wllHost");
            if !wll.is_empty() {
                poll_wll(&state, &wll);
            }

            // A minute apart: the API allows one request a second, and the station behind it
            // uploads far more slowly than that.
            let (api, app) = (s("awnApiKey"), s("awnAppKey"));
            if tick % 6 == 0 && !api.is_empty() && !app.is_empty() {
                poll_awn(&state, &api, &app);
            }

            let (email, pass) = (s("lacrosseEmail"), s("lacrossePass"));
            if tick % 12 == 0 && !email.is_empty() && !pass.is_empty() {
                // Tokens last an hour; mint a new one at fifty minutes rather than discover the
                // expiry as a 401 on a station that then reads as offline.
                let fresh = lax.as_ref().map(|(_, at)| epoch() - at < 3000).unwrap_or(false);
                if !fresh {
                    lax = lacrosse_token(&email, &pass).map(|t| (t, epoch()));
                }
                if let Some((t, _)) = lax.as_ref() {
                    poll_lacrosse(&state, t);
                }
            }
        }
    });
}

// ponytail: the checks that matter are the conversions and the two running counters — a wrong
// factor is a plausible-looking wrong number forever, and a counter that doesn't handle midnight
// turns one day's rain into a negative that poisons every SUM in the archive.
#[cfg(test)]
mod tests {
    use super::*;

    /// A real Ecowitt "customized upload" body, GW2000 firmware, Wittboy attached.
    const ECOWITT: &str = "PASSKEY=A1B2C3&stationtype=GW2000A_V3.1.5&dateutc=2026-08-19+14:30:00\
        &tempf=77.0&humidity=55&winddir=180&windspeedmph=10.0&windgustmph=20.0\
        &baromabsin=29.92&baromrelin=30.01&dailyrainin=0.10&solarradiation=812.4&uv=7\
        &lightning=12&lightning_num=3&freq=915M&model=GW2000A";

    /// The same reading as an Ambient console's awnet custom-server GET.
    const AMBIENT: &str = "/ingest?stationtype=AMBWeatherV4.3.4&PASSKEY=AA:BB:CC&dateutc=2026-08-19+14:30:00\
        &tempf=77.0&humidity=55&winddir=180&windspeedmph=10.0&windgustmph=20.0&baromabsin=29.92&dailyrainin=0.10";

    /// And as a Weather Underground protocol update, which is what the clones speak.
    const WU: &str = "/weatherstation/updateweatherstation.php?ID=KXX1&PASSWORD=x&dateutc=now\
        &tempf=77.0&humidity=55&winddir=180&windspeedmph=10.0&windgustmph=20.0&baromin=29.92&dailyrainin=0.10";

    fn build(url: &str, body: &str) -> Vec<Option<f64>> {
        let f = collect(url, body);
        let mut m = Mem::default();
        tuple(&f, 1_000_000.0, &mut m)
    }

    fn close(a: Option<f64>, b: f64) -> bool {
        a.map(|x| (x - b).abs() < 0.01).unwrap_or(false)
    }

    #[test]
    fn ecowitt_lands_in_the_right_slots() {
        let t = build("/ingest", ECOWITT);
        assert!(close(t[7], 25.0), "77 F is 25 C, got {:?}", t[7]);
        assert!(close(t[8], 55.0));
        assert!(close(t[2], 4.4704), "10 mph in m/s, got {:?}", t[2]);
        assert!(close(t[3], 8.9408));
        assert!(close(t[4], 180.0));
        assert!(close(t[6], 1013.21), "29.92 inHg in mb, got {:?}", t[6]);
        assert!(close(t[11], 812.4));
        assert!(close(t[10], 7.0));
        assert!(close(t[14], 12.0));
        assert!(close(t[18], 2.54), "0.10 in of rain is 2.54 mm, got {:?}", t[18]);
        // Nothing to difference against yet, so the first report claims no rain and no strikes.
        assert_eq!((t[12], t[15]), (Some(0.0), Some(0.0)));
        // Slots no other brand reports stay empty rather than zero.
        assert_eq!((t[1], t[5], t[9], t[16]), (None, None, None, None));
    }

    #[test]
    fn absolute_pressure_wins_over_relative() {
        let t = build("/ingest", ECOWITT);
        assert!(close(t[6], 1013.21), "took the sea-level figure: {:?}", t[6]);
    }

    #[test]
    fn ambient_and_wu_read_the_same_as_ecowitt() {
        let e = build("/ingest", ECOWITT);
        let a = build(AMBIENT, "");
        let w = build(WU, "");
        for slot in [2, 3, 4, 6, 7, 8, 18] {
            assert_eq!(e[slot], a[slot], "slot {slot} differs between Ecowitt and Ambient");
            assert_eq!(e[slot], w[slot], "slot {slot} differs between Ecowitt and WU");
        }
    }

    #[test]
    fn rain_is_an_interval_and_survives_midnight() {
        let mut m = Mem::default();
        let f = |mm: &str| {
            let mut x = Fields::new();
            x.insert("tempf".into(), "70".into());
            x.insert("dailyrainin".into(), mm.into());
            x
        };
        assert_eq!(tuple(&f("0.10"), 0.0, &mut m)[12], Some(0.0), "first report must not claim the day's rain");
        let t = tuple(&f("0.15"), 60.0, &mut m);
        assert!(close(t[12], 0.05 * MM_PER_IN), "0.05 in fell, got {:?}", t[12]);
        assert_eq!(t[13], Some(1.0), "rain fell but precip type says dry");
        // Midnight: the console's daily total restarts. The drop is a rollover, not negative rain.
        let t = tuple(&f("0.02"), 120.0, &mut m);
        assert!(close(t[12], 0.02 * MM_PER_IN), "rollover mishandled: {:?}", t[12]);
        assert!(t[12].unwrap() >= 0.0, "a negative rainfall would poison every SUM");
        // Dry interval.
        let t = tuple(&f("0.02"), 180.0, &mut m);
        assert_eq!((t[12], t[13]), (Some(0.0), Some(0.0)));
    }

    #[test]
    fn strikes_are_counted_per_interval() {
        let mut m = Mem::default();
        let f = |n: &str| {
            let mut x = Fields::new();
            x.insert("tempf".into(), "70".into());
            x.insert("lightning_num".into(), n.into());
            x
        };
        assert_eq!(tuple(&f("3"), 0.0, &mut m)[15], Some(0.0));
        assert_eq!(tuple(&f("7"), 60.0, &mut m)[15], Some(4.0));
        assert_eq!(tuple(&f("1"), 120.0, &mut m)[15], Some(1.0), "counter reset should not go negative");
    }

    #[test]
    fn report_interval_is_minutes_and_clamped() {
        let mut m = Mem::default();
        let mut f = Fields::new();
        f.insert("tempf".into(), "70".into());
        assert_eq!(tuple(&f, 0.0, &mut m)[17], None, "no previous report, no interval");
        m.last_ts = Some(0.0);
        assert_eq!(tuple(&f, 60.0, &mut m)[17], Some(1.0));
        m.last_ts = Some(0.0);
        assert_eq!(tuple(&f, 86_400.0, &mut m)[17], Some(30.0), "a day's gap must clamp, not scale");
    }

    #[test]
    fn rtl_433_json_maps_through_the_si_names() {
        // What `rtl_433 -C si -F json` prints for an AcuRite 5-in-1.
        let body = r#"{"model":"Acurite-5n1","temperature_C":25.0,"humidity":55,
            "wind_avg_m_s":4.4704,"wind_dir_deg":180,"rain_mm":10.0}"#;
        let t = build("/ingest", body);
        assert!(close(t[7], 25.0));
        assert!(close(t[2], 4.4704));
        assert!(close(t[4], 180.0));
        assert!(close(t[18], 10.0));
    }

    #[test]
    fn davis_rain_counts_use_the_gauge_size() {
        let iss = serde_json::json!({"rain_size": 1});
        assert!((rain_bucket_mm(&iss) - 0.254).abs() < 1e-9, "0.01 in gauge");
        assert!((rain_bucket_mm(&serde_json::json!({"rain_size": 4})) - 0.0254).abs() < 1e-9);
        // An absent field is the North American gauge, not zero millimetres a tip.
        assert!((rain_bucket_mm(&serde_json::json!({})) - 0.254).abs() < 1e-9);
    }

    #[test]
    fn percent_encoding_and_plus_signs_decode() {
        let f = collect("/ingest", "dateutc=2026-08-19+14%3A30%3A00&tempf=77.0");
        assert_eq!(f.get("dateutc").map(String::as_str), Some("2026-08-19 14:30:00"));
        assert_eq!(f.get("tempf").map(String::as_str), Some("77.0"));
    }
}
