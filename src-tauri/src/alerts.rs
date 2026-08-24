//! Alert rules and NWS watches, evaluated by the server rather than by whatever browser happens
//! to be open.
//!
//! `site/js/rules.js` has always done this well — but only while a tab is alive, which is the
//! one thing an alert must not depend on. A tablet that sleeps at midnight is a house with no
//! frost warning. Everything here mirrors that file deliberately, latch for latch, so the two
//! never disagree about whether a rule has fired; the page stands down (see `/diag`) when this
//! is running, because two engines on one ntfy topic means every alert arrives twice.
//!
//! The archive is SI. Rules are written in whatever the dashboard shows, so the readings are
//! converted here exactly as `app.js` converts them — a "below 32" rule typed against °F must
//! not fire at 32 °C.

use crate::store;
use std::collections::HashMap;
use std::time::Duration;

/// One pass a minute. The archive gains a row a minute at best, and a rule with a duration is
/// measured in minutes by construction.
const TICK: Duration = Duration::from_secs(60);

/// A rule as the page writes it into the config blob. Every field past `metric`/`op`/`value` is
/// optional because rules saved before v3 have none of them — which is also why this is read
/// field by field rather than derived: a missing key must be a default, never a dropped rule.
#[derive(Debug, Clone)]
pub struct Rule {
    pub metric: String,
    pub op: String,
    pub value: f64,
    pub dur_min: f64,
    pub metric2: Option<String>,
    pub op2: Option<String>,
    pub value2: Option<f64>,
}

impl Rule {
    fn from_json(v: &serde_json::Value) -> Option<Rule> {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
        let f = |k: &str| v.get(k).and_then(|x| x.as_f64());
        Some(Rule {
            metric: s("metric")?,
            op: s("op").unwrap_or_else(|| ">".into()),
            value: f("value")?,
            dur_min: f("durMin").unwrap_or(0.0),
            metric2: s("metric2"),
            op2: s("op2"),
            value2: f("value2"),
        })
    }
}

/// Per-rule latch state, keyed by the rule's index in the saved list — the same key `rules.js`
/// uses, and cleared for the same reason when the list changes.
#[derive(Default, Clone, Copy)]
pub struct Latch {
    pub since: Option<i64>,
    pub latched: bool,
}

/// The metric keys `rules.js` offers, and nothing else: a saved rule naming a metric that no
/// longer exists is skipped rather than treated as zero.
pub const METRICS: [&str; 9] =
    ["temp", "dew", "gust", "wind", "rh", "rain", "uv", "strikes3h", "press3h"];

fn holds(v: f64, op: &str, target: f64) -> bool {
    if op == "<" { v < target } else { v > target }
}

/// Re-arm at 90% of the threshold (110% for a "below" rule). Without it a gust hovering on
/// 30 mph notifies on every single report.
fn rearmed(v: f64, op: &str, target: f64) -> bool {
    if op == "<" { v > target * 1.1 } else { v < target * 0.9 }
}

fn second(m: &HashMap<&str, f64>, r: &Rule) -> bool {
    let Some(k) = r.metric2.as_deref() else { return true };
    if !METRICS.contains(&k) {
        return false;
    }
    let (Some(v), Some(t)) = (m.get(k), r.value2) else { return false };
    holds(*v, r.op2.as_deref().unwrap_or(">"), t)
}

/// Which rules fire on this reading. Pure, so the parity tests can drive it directly with the
/// same numbers `rules.js` asserts on.
pub fn evaluate(
    m: &HashMap<&str, f64>,
    rules: &[Rule],
    state: &mut HashMap<usize, Latch>,
    now: i64,
) -> Vec<(usize, f64)> {
    let mut fired = Vec::new();
    for (i, r) in rules.iter().enumerate() {
        if !METRICS.contains(&r.metric.as_str()) {
            continue;
        }
        let Some(&v) = m.get(r.metric.as_str()) else { continue };
        if v.is_nan() {
            continue;
        }
        let st = state.entry(i).or_default();
        if !holds(v, &r.op, r.value) || !second(m, r) {
            st.since = None;
            if st.latched && rearmed(v, &r.op, r.value) {
                st.latched = false;
            }
            continue;
        }
        st.since.get_or_insert(now);
        if !st.latched && now - st.since.unwrap() >= (r.dur_min * 60.0) as i64 {
            st.latched = true;
            fired.push((i, v));
        }
    }
    fired
}

// --- reading the archive in the units the rule was written in ---

fn imperial(cfg: &std::path::Path) -> bool {
    crate::setting(cfg, "units").unwrap_or_default().trim_matches('"') != "metric"
}

/// m/s to whatever the wind is displayed in — the dashboard's wind unit is separately
/// overridable, so this is not simply "metric or not".
fn wind_factor(cfg: &std::path::Path) -> f64 {
    let unit = crate::setting(cfg, "windUnit").unwrap_or_default().trim_matches('"').to_string();
    match unit.as_str() {
        "km/h" => 3.6,
        "m/s" => 1.0,
        "kt" => 1.94384,
        "mph" => 2.23694,
        _ if imperial(cfg) => 2.23694,
        _ => 3.6,
    }
}

/// The newest row as the metric map `evaluate` wants, in display units.
///
/// `dew` is absent: the archive holds no dew point column, and `rules.js` leaves it null on the
/// live-tuple path for the same reason. A dew rule simply never fires here, which is what it
/// already does for every non-Tempest station.
fn metrics(conn: &rusqlite::Connection, cfg: &std::path::Path) -> Option<(i64, HashMap<&'static str, f64>)> {
    let imp = imperial(cfg);
    let w = wind_factor(cfg);
    /// ts, then the eight readings a rule can name, each of which any station is free to be
    /// missing.
    type Row = (i64, Opt, Opt, Opt, Opt, Opt, Opt, Opt, Opt);
    type Opt = Option<f64>;
    let (ts, gust, wind, rh, temp, uv, rain, interval, press): Row = conn
        .query_row(
            "SELECT ts, wind_gust, wind_avg, humidity, temp, uv, rain, report_interval, pressure
             FROM obs ORDER BY ts DESC LIMIT 1",
            [],
            |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?))
            },
        )
        .ok()?;

    let mut m: HashMap<&'static str, f64> = HashMap::new();
    let mut put = |k: &'static str, v: Option<f64>| {
        if let Some(v) = v {
            m.insert(k, v);
        }
    };
    put("temp", temp.map(|c| if imp { c * 9.0 / 5.0 + 32.0 } else { c }));
    put("gust", gust.map(|v| v * w));
    put("wind", wind.map(|v| v * w));
    put("rh", rh);
    put("uv", uv);
    // The archive holds the accumulation for one report interval; the rule is written per hour.
    let mins = interval.filter(|v| *v > 0.0).unwrap_or(1.0);
    put("rain", rain.map(|v| v * (60.0 / mins) * if imp { 1.0 / 25.4 } else { 1.0 }));

    // Three hours back, for the two metrics that are a change rather than a reading.
    let then: Option<f64> = conn
        .query_row(
            "SELECT pressure FROM obs WHERE ts <= ?1 AND pressure IS NOT NULL ORDER BY ts DESC LIMIT 1",
            [ts - 3 * 3600],
            |r| r.get(0),
        )
        .ok();
    if let (Some(now), Some(then)) = (press, then) {
        put("press3h", Some((now - then) * if imp { 0.02953 } else { 1.0 }));
    }
    // Strikes are reported per interval, so three hours' worth is a sum, not a difference.
    let strikes: Option<f64> = conn
        .query_row("SELECT SUM(strikes) FROM obs WHERE ts > ?1", [ts - 3 * 3600], |r| r.get(0))
        .ok()
        .flatten();
    put("strikes3h", strikes);
    Some((ts, m))
}

// --- the channels ---

/// Discord and Telegram reject the generic payload; both are recognised from the URL the user
/// pasted, exactly as `app.js webhookBody` does. Public so the parity test can assert the shape.
pub fn webhook_body(url: &str, title: &str, body: &str, category: &str) -> serde_json::Value {
    let text = if body.is_empty() { title.to_string() } else { format!("{title}\n{body}") };
    if url.contains("discord.com/api/webhooks/") || url.contains("discordapp.com/api/webhooks/") {
        return serde_json::json!({ "content": text });
    }
    if url.contains("api.telegram.org/bot") {
        return serde_json::json!({ "text": text });
    }
    serde_json::json!({ "title": title, "body": body, "category": category })
}

/// Off the machine. The payloads carry the title, the body and the category and nothing else:
/// ntfy.sh is a public relay by default and a webhook goes wherever it was pointed.
fn push(cfg: &std::path::Path, category: &str, title: &str, body: &str) {
    let get = |k: &str| crate::setting(cfg, k).unwrap_or_default().trim_matches('"').to_string();
    let topic = get("ntfyTopic");
    if !topic.is_empty() {
        let base = {
            let u = get("ntfyUrl");
            if u.is_empty() { "https://ntfy.sh".to_string() } else { u }
        };
        // A header value cannot contain a line break, and NWS headlines do.
        let head: String = title.replace(['\r', '\n'], " ").chars().take(200).collect();
        let r = ureq::post(&format!("{}/{}", base.trim_end_matches('/'), urlencode(&topic)))
            .timeout(Duration::from_secs(15))
            .set("Title", &head)
            .set("Tags", category)
            .send_string(if body.is_empty() { title } else { body });
        if let Err(e) = r {
            // Never the error's Display: an ntfy URL is a credential in its own right.
            eprintln!("weatherdesk: ntfy push failed ({})", err_kind(&e));
        }
    }
    let hook = get("webhookUrl");
    if !hook.is_empty() {
        let r = ureq::post(&hook)
            .timeout(Duration::from_secs(15))
            .set("Content-Type", "application/json")
            .send_string(&webhook_body(&hook, title, body, category).to_string());
        if let Err(e) = r {
            eprintln!("weatherdesk: webhook push failed ({})", err_kind(&e));
        }
    }
    crate::mqtt::send(if category == "rule" { "rule" } else { "alert" }, title);
}

fn err_kind(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("HTTP {code}"),
        ureq::Error::Transport(_) => "no answer".into(),
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Fire one real notification through every configured channel. The point is that it is real —
/// a test that takes a different path to the phone tests nothing.
pub fn test_push(cfg: &std::path::Path) -> String {
    let get = |k: &str| crate::setting(cfg, k).unwrap_or_default().trim_matches('"').to_string();
    let channels: Vec<&str> = [
        (!get("ntfyTopic").is_empty()).then_some("ntfy"),
        (!get("webhookUrl").is_empty()).then_some("webhook"),
        (!get("mqttUrl").is_empty()).then_some("broker"),
    ]
    .into_iter()
    .flatten()
    .collect();
    push(cfg, "info", "WeatherDesk test alert", "If this reached you, alerts work.");
    serde_json::json!({
        "sent": !channels.is_empty(),
        "channels": channels,
    })
    .to_string()
}

// --- NWS ---

/// The dedupe key `desk.js` settled on: NWS mints a fresh id for every continuation of the same
/// warning, so keying on the id re-chimed the same tornado warning every five minutes. Key on
/// what the warning IS — a severity change still gets through, which is the one update worth a
/// second chime.
fn alert_key(p: &serde_json::Value) -> String {
    let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("");
    format!("{}|{}|{}", s("event"), s("areaDesc"), s("severity"))
}

fn nws(cfg: &std::path::Path) -> Option<Vec<serde_json::Value>> {
    let num = |k: &str| crate::setting(cfg, k)?.trim_matches('"').parse::<f64>().ok();
    let (lat, lon) = (num("lat")?, num("lon")?);
    let url = format!("https://api.weather.gov/alerts/active?point={lat:.4},{lon:.4}");
    let body = ureq::get(&url)
        .timeout(Duration::from_secs(20))
        .set("User-Agent", concat!("WeatherDesk/", env!("CARGO_PKG_VERSION")))
        .call();
    let body = match body {
        Ok(r) => r.into_string().ok()?,
        Err(e) => {
            eprintln!("weatherdesk: NWS alert poll failed ({})", err_kind(&e));
            return None;
        }
    };
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    Some(v.get("features")?.as_array()?.clone())
}

// --- the loop ---

fn rules(cfg: &std::path::Path) -> Vec<Rule> {
    crate::setting(cfg, "rules")
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(Rule::from_json)
        .collect()
}

/// Label, unit and decimals for the notification text, so a server-sent alert reads exactly like
/// the banner the page would have shown.
fn describe(metric: &str, cfg: &std::path::Path) -> (&'static str, String, usize) {
    let imp = imperial(cfg);
    let wind = crate::setting(cfg, "windUnit")
        .unwrap_or_default()
        .trim_matches('"')
        .to_string();
    let wind = if wind.is_empty() {
        if imp { "mph".to_string() } else { "km/h".to_string() }
    } else {
        wind
    };
    let temp = if imp { "°F" } else { "°C" };
    let press = if imp { "inHg" } else { "mb" };
    let precip = if imp { "in/h" } else { "mm/h" };
    match metric {
        "temp" => ("Temperature", temp.into(), 1),
        "dew" => ("Dew point", temp.into(), 1),
        "gust" => ("Wind gust", wind, 1),
        "wind" => ("Wind average", wind, 1),
        "rh" => ("Humidity", "%".into(), 0),
        "rain" => ("Rain rate", precip.into(), 2),
        "uv" => ("UV index", String::new(), 1),
        "strikes3h" => ("Lightning strikes · 3h", String::new(), 0),
        "press3h" => ("Pressure change · 3h", press.into(), 2),
        _ => ("Reading", String::new(), 1),
    }
}

fn tick(
    data_dir: &std::path::Path,
    cfg: &std::path::Path,
    state: &mut HashMap<usize, Latch>,
    seen: &mut std::collections::HashSet<String>,
    last_rules: &mut String,
) {
    // A changed rule list shifts every index, and a stale latch would then belong to the wrong
    // rule — the same reason the page clears its map when a rule is deleted.
    let raw = crate::setting(cfg, "rules").unwrap_or_default();
    if raw != *last_rules {
        state.clear();
        *last_rules = raw;
    }

    let rs = rules(cfg);
    if !rs.is_empty() {
        if let Ok(conn) = store::open(&store::db_path(data_dir)) {
            if let Some((ts, m)) = metrics(&conn, cfg) {
                for (i, v) in evaluate(&m, &rs, state, ts) {
                    let r = &rs[i];
                    let (label, unit, digits) = describe(&r.metric, cfg);
                    let op = if r.op == "<" { "below" } else { "above" };
                    let title = format!("{label} {op} {:.*}{unit}", digits, r.value);
                    let mut body = format!("Now {:.*}{unit}", digits, v);
                    if r.dur_min > 0.0 {
                        body.push_str(&format!(" for {} min", r.dur_min as i64));
                    }
                    push(cfg, "rule", &title, &body);
                }
            }
        }
    }

    let Some(feats) = nws(cfg) else { return };
    for f in &feats {
        let Some(p) = f.get("properties") else { continue };
        if !is_new(seen, p) {
            continue;
        }
        let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        push(cfg, "severe", &s("event"), &s("headline"));
    }
    if expire(seen, &feats) {
        crate::mqtt::send("alert", "");
    }
}

/// Has this warning been announced already? Announcing sets the memory, so a caller that skips is
/// a caller that has nothing to say.
fn is_new(seen: &mut std::collections::HashSet<String>, props: &serde_json::Value) -> bool {
    seen.insert(alert_key(props))
}

/// Drop warnings that are no longer in the feed, so the next one of the same kind chimes again.
/// Returns true on the all-clear: the moment the last warning went away.
///
/// Without the all-clear the `alert` sensor keeps its last headline forever, and an automation
/// asking "is anything out right now" gets answered by a thunderstorm that ended on Tuesday.
/// Only on the transition, so a quiet month is not a message a minute.
fn expire(seen: &mut std::collections::HashSet<String>, feats: &[serde_json::Value]) -> bool {
    let live: std::collections::HashSet<String> = feats
        .iter()
        .filter_map(|f| f.get("properties").map(alert_key))
        .collect();
    let had = !seen.is_empty();
    seen.retain(|k| live.contains(k));
    had && seen.is_empty()
}

/// Run the engine for as long as the process lives. Silent until a rule is saved or a warning is
/// issued, which is most days.
pub fn start(data_dir: std::path::PathBuf, cfg_path: std::path::PathBuf) {
    std::thread::spawn(move || {
        let mut state: HashMap<usize, Latch> = HashMap::new();
        let mut seen = std::collections::HashSet::new();
        let mut last_rules = String::new();
        // The page checks `/diag` to decide whether to run its own engine; say so before the
        // first tick, not after it.
        crate::ingest::note("alerts", true, "watching", false);
        loop {
            tick(&data_dir, &cfg_path, &mut state, &mut seen, &mut last_rules);
            std::thread::sleep(TICK);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(metric: &str, op: &str, value: f64, dur_min: f64) -> Rule {
        Rule { metric: metric.into(), op: op.into(), value, dur_min, metric2: None, op2: None, value2: None }
    }

    fn m(pairs: &[(&'static str, f64)]) -> HashMap<&'static str, f64> {
        pairs.iter().copied().collect()
    }

    // The same numbers `site/js/rules.js` asserts on. If these two ever disagree, one of the two
    // engines is telling somebody their greenhouse is fine when it isn't.
    #[test]
    fn the_latch_matches_the_page_latch() {
        let rs = [rule("gust", ">", 30.0, 0.0)];
        let mut st = HashMap::new();
        assert_eq!(evaluate(&m(&[("gust", 40.0)]), &rs, &mut st, 0).len(), 1);
        assert_eq!(evaluate(&m(&[("gust", 40.0)]), &rs, &mut st, 60).len(), 0, "latched");
        assert_eq!(evaluate(&m(&[("gust", 29.0)]), &rs, &mut st, 120).len(), 0, "inside the re-arm band");
        assert_eq!(evaluate(&m(&[("gust", 20.0)]), &rs, &mut st, 180).len(), 0, "re-arm is not a fire");
        assert_eq!(evaluate(&m(&[("gust", 40.0)]), &rs, &mut st, 240).len(), 1, "fires again");
    }

    #[test]
    fn a_duration_holds_the_rule_back() {
        let rs = [rule("temp", "<", 32.0, 10.0)];
        let mut st = HashMap::new();
        assert_eq!(evaluate(&m(&[("temp", 30.0)]), &rs, &mut st, 0).len(), 0);
        assert_eq!(evaluate(&m(&[("temp", 30.0)]), &rs, &mut st, 599).len(), 0);
        assert_eq!(evaluate(&m(&[("temp", 30.0)]), &rs, &mut st, 600).len(), 1);
    }

    #[test]
    fn a_missing_reading_never_fires() {
        let rs = [rule("temp", "<", 32.0, 10.0)];
        let mut st = HashMap::new();
        assert_eq!(evaluate(&m(&[]), &rs, &mut st, 0).len(), 0);
    }

    #[test]
    fn an_and_rule_needs_both_halves() {
        let mut r = rule("gust", ">", 25.0, 0.0);
        r.metric2 = Some("rh".into());
        r.op2 = Some("<".into());
        r.value2 = Some(40.0);
        let rs = [r];
        let mut st = HashMap::new();
        assert_eq!(evaluate(&m(&[("gust", 30.0), ("rh", 50.0)]), &rs, &mut st, 0).len(), 0);
        assert_eq!(evaluate(&m(&[("gust", 30.0), ("rh", 30.0)]), &rs, &mut st, 60).len(), 1);
        let mut st = HashMap::new();
        assert_eq!(evaluate(&m(&[("gust", 30.0)]), &rs, &mut st, 0).len(), 0, "missing second reading");
    }

    #[test]
    fn a_rule_saved_before_v3_still_fires() {
        let rs = [rule("gust", ">", 30.0, 0.0)];
        let mut st = HashMap::new();
        assert_eq!(evaluate(&m(&[("gust", 40.0)]), &rs, &mut st, 0).len(), 1);
    }

    fn warning(event: &str, area: &str, sev: &str) -> serde_json::Value {
        serde_json::json!({ "properties": { "event": event, "areaDesc": area, "severity": sev } })
    }

    /// NWS mints a fresh id for every continuation of the same warning, so keying the memory on
    /// the id re-chimed the same tornado warning every five minutes.
    #[test]
    fn a_continued_warning_does_not_chime_twice_but_a_worse_one_does() {
        let mut seen = std::collections::HashSet::new();
        let w = warning("Tornado Warning", "Hartford", "Severe");
        assert!(is_new(&mut seen, w.get("properties").unwrap()));
        assert!(!is_new(&mut seen, w.get("properties").unwrap()), "same warning, continued");
        let worse = warning("Tornado Warning", "Hartford", "Extreme");
        assert!(is_new(&mut seen, worse.get("properties").unwrap()), "a severity change is worth a second chime");
    }

    #[test]
    fn the_all_clear_fires_once_when_the_last_warning_goes_away() {
        let mut seen = std::collections::HashSet::new();
        let w = warning("Flood Warning", "Hartford", "Severe");
        let x = warning("Wind Advisory", "Hartford", "Moderate");
        is_new(&mut seen, w.get("properties").unwrap());
        is_new(&mut seen, x.get("properties").unwrap());
        assert!(!expire(&mut seen, &[w.clone(), x.clone()]), "both still out");
        assert!(!expire(&mut seen, std::slice::from_ref(&w)), "one left is not an all-clear");
        assert!(expire(&mut seen, &[]), "the last one going away is");
        assert!(!expire(&mut seen, &[]), "and a quiet month says nothing further");
    }

    #[test]
    fn the_two_webhooks_that_reject_the_generic_shape() {
        let d = webhook_body("https://discord.com/api/webhooks/1/abc", "Tornado", "take cover", "severe");
        assert!(d["content"].as_str().unwrap().contains("Tornado"));
        let t = webhook_body("https://api.telegram.org/bot1:abc/sendMessage?chat_id=2", "Tornado", "take cover", "severe");
        assert!(t["text"].as_str().unwrap().contains("cover"));
        let g = webhook_body("https://example.com/hook", "Tornado", "take cover", "severe");
        assert_eq!(g["category"], "severe");
    }

    #[test]
    fn a_ntfy_topic_with_a_slash_cannot_escape_its_url() {
        assert_eq!(urlencode("my topic/../admin"), "my%20topic%2F..%2Fadmin");
    }
}
