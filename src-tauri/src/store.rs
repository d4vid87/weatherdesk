// The observation archive. v2 appended every hub broadcast to `log/obs-YYYY-MM.jsonl` and
// re-read the whole thing for every Data-tab visit; v3 keeps a SQLite table instead, so a
// decade of minutes is a GROUP BY instead of a full parse.
//
// The JSONL files are imported once and then left alone forever — they are the escape hatch if
// this file is ever wrong, and they cost nothing to keep.

use rusqlite::{params_from_iter, Connection};
use std::path::{Path, PathBuf};

/// obs_st tuple layout minus its leading timestamp, same order as `site/js/api.js` OBS.
const FIELDS: [&str; 18] = [
    "wind_lull",
    "wind_avg",
    "wind_gust",
    "wind_dir",
    "wind_interval",
    "pressure",
    "temp",
    "humidity",
    "lux",
    "uv",
    "solar",
    "rain",
    "precip_type",
    "strike_dist",
    "strikes",
    "battery",
    "report_interval",
    "day_rain",
];

/// Where the observation is from: the hub on the LAN, WeatherFlow's REST backfill, or the v2
/// JSONL import. Kept so a bad backfill can be deleted without touching what we heard ourselves.
pub const SRC_UDP: i64 = 0;
pub const SRC_BACKFILL: i64 = 1;
pub const SRC_JSONL: i64 = 2;

pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("weatherdesk.db")
}

/// Open (and if need be create) the archive. Every caller gets its own connection — WAL means
/// the UDP writer and a reading request thread don't block each other.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS obs (ts INTEGER PRIMARY KEY, {}, src INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",
        FIELDS.iter().map(|f| format!("{f} REAL")).collect::<Vec<_>>().join(", ")
    ))?;
    Ok(conn)
}

pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).ok()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        [key, value],
    );
}

fn insert_sql() -> String {
    let cols = FIELDS.join(", ");
    let holes = (1..=19).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    format!("INSERT OR IGNORE INTO obs (ts, {cols}, src) VALUES ({holes}, {{src}})")
}

/// One raw SI tuple, exactly as the hub broadcast it. `INSERT OR IGNORE` on the timestamp
/// primary key is what makes the import, the backfill and a re-broadcasting hub all idempotent.
pub fn insert(conn: &Connection, obs: &[Option<f64>], src: i64) -> bool {
    let Some(Some(ts)) = obs.first().copied() else { return false };
    let sql = insert_sql().replace("{src}", &src.to_string());
    let mut vals: Vec<Option<f64>> = Vec::with_capacity(19);
    vals.push(Some(ts));
    for i in 1..=FIELDS.len() {
        vals.push(obs.get(i).copied().flatten());
    }
    conn.execute(&sql, params_from_iter(vals)).map(|n| n > 0).unwrap_or(false)
}

/// Every tuple in the v2 JSONL log, oldest file first. Lines that don't parse are skipped rather
/// than fatal: a half-written last line after a power cut should cost one minute, not the archive.
fn read_log(dir: &Path) -> Vec<Vec<Option<f64>>> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<Vec<serde_json::Value>>(line) else { continue };
            out.push(v.iter().map(|x| x.as_f64()).collect());
        }
    }
    out
}

/// Import the v2 archive once, then never look at it again. The files stay where they are.
pub fn migrate_jsonl(conn: &mut Connection, log_dir: &Path) {
    if meta_get(conn, "jsonl_imported").is_some() || !log_dir.is_dir() {
        return;
    }
    let rows = read_log(log_dir);
    let n = rows.len();
    if let Ok(tx) = conn.transaction() {
        for o in &rows {
            insert(&tx, o, SRC_JSONL);
        }
        let _ = tx.commit();
    }
    meta_set(conn, "jsonl_imported", &n.to_string());
    eprintln!("weatherdesk: imported {n} observations from the JSONL log (files kept as backup)");
}

/// Per-day aggregates, SI, keyed by the viewer's local date — the browser passes its own UTC
/// offset because the process has no notion of a timezone and "yesterday" has to mean the same
/// day the user saw.
pub fn daily_json(conn: &Connection, tz_off_min: i64) -> String {
    let mut stmt = match conn.prepare(
        "SELECT strftime('%Y-%m-%d', ts + ?1, 'unixepoch'),
                MIN(temp), MAX(temp), MAX(wind_gust), SUM(rain), SUM(strikes), MIN(battery)
         FROM obs GROUP BY 1 ORDER BY 1",
    ) {
        Ok(s) => s,
        Err(_) => return "[]".into(),
    };
    let n = |v: Option<f64>| v.map(|x| x.to_string()).unwrap_or_else(|| "null".into());
    let rows = stmt.query_map([tz_off_min * 60], |r| {
        Ok(format!(
            "{{\"day\":\"{}\",\"tempMin\":{},\"tempMax\":{},\"gustMax\":{},\"rain\":{},\"strikes\":{},\"battMin\":{}}}",
            r.get::<_, String>(0)?,
            n(r.get(1)?),
            n(r.get(2)?),
            n(r.get(3)?),
            n(r.get(4)?),
            n(r.get(5)?),
            n(r.get(6)?)
        ))
    });
    let body: Vec<String> = match rows {
        Ok(it) => it.flatten().collect(),
        Err(_) => return "[]".into(),
    };
    format!("[{}]", body.join(","))
}

/// Cheap cache key for the aggregate above: the table is append-only in practice, so a row
/// count and the newest timestamp change whenever the answer would.
pub fn stamp(conn: &Connection) -> (i64, i64) {
    conn.query_row("SELECT COUNT(*), COALESCE(MAX(ts), 0) FROM obs", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap_or((0, 0))
}

/// What the almanac needs to say "records since <date>".
pub fn coverage_json(conn: &Connection, backfill: &str) -> String {
    let (first, last, count): (Option<i64>, Option<i64>, i64) = conn
        .query_row("SELECT MIN(ts), MAX(ts), COUNT(*) FROM obs", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap_or((None, None, 0));
    let n = |v: Option<i64>| v.map(|x| x.to_string()).unwrap_or_else(|| "null".into());
    format!(
        "{{\"first\":{},\"last\":{},\"count\":{count},\"backfill\":\"{backfill}\"}}",
        n(first),
        n(last)
    )
}

pub const CSV_HEADER: &str =
    "time,wind_lull,wind_avg,wind_gust,wind_dir,wind_interval,pressure,temp,humidity,lux,uv,solar,rain,precip_type,strike_dist,strikes,battery,report_interval,day_rain\n";

/// The whole archive as CSV, streamed. v2 built the string in memory; a decade of minutes is
/// tens of MB and this now shares a process with a live UDP writer, so it goes out in pages.
pub struct CsvPager {
    conn: Connection,
    after: i64,
    buf: Vec<u8>,
    at: usize,
    done: bool,
}

impl CsvPager {
    pub fn new(conn: Connection) -> Self {
        CsvPager { conn, after: -1, buf: CSV_HEADER.as_bytes().to_vec(), at: 0, done: false }
    }

    fn refill(&mut self) {
        self.buf.clear();
        self.at = 0;
        let sql = format!(
            "SELECT ts, {} FROM obs WHERE ts > ?1 ORDER BY ts LIMIT 10000",
            FIELDS.join(", ")
        );
        let Ok(mut stmt) = self.conn.prepare(&sql) else {
            self.done = true;
            return;
        };
        let mut rows = match stmt.query([self.after]) {
            Ok(r) => r,
            Err(_) => {
                self.done = true;
                return;
            }
        };
        let mut n = 0;
        while let Ok(Some(row)) = rows.next() {
            let ts: i64 = row.get(0).unwrap_or(0);
            self.after = ts;
            let mut line = ts.to_string();
            for i in 1..=FIELDS.len() {
                line.push(',');
                if let Ok(Some(v)) = row.get::<_, Option<f64>>(i) {
                    line.push_str(&v.to_string());
                }
            }
            line.push('\n');
            self.buf.extend_from_slice(line.as_bytes());
            n += 1;
        }
        if n == 0 {
            self.done = true;
        }
    }
}

impl std::io::Read for CsvPager {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.at >= self.buf.len() {
            if self.done {
                return Ok(0);
            }
            self.refill();
            if self.at >= self.buf.len() {
                return Ok(0);
            }
        }
        let n = out.len().min(self.buf.len() - self.at);
        out[..n].copy_from_slice(&self.buf[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

/// A consistent snapshot of the archive to hand out over HTTP. `VACUUM INTO` is the one way to
/// copy a WAL database that is being written to at the same time.
pub fn backup_to(conn: &Connection, dest: &Path) -> rusqlite::Result<()> {
    let _ = std::fs::remove_file(dest);
    conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().to_string()])?;
    Ok(())
}

// --- Backfill: WeatherFlow keeps the station's whole history; we only have what we heard ---

/// Walk backwards from the oldest observation we hold, four days at a time, until the station's
/// own history runs out. Resumable: the cursor is in `meta`, and every insert is idempotent.
///
/// The token rides in the query string of every request here, so failures are reported by status
/// code only — a formatted `ureq` error echoes the URL, and this goes to a log file.
pub fn backfill(conn: &Connection, token: &str, device_id: &str) {
    if meta_get(conn, "backfill_done").is_some() || token.is_empty() || device_id.is_empty() {
        return;
    }
    let chunk = 4 * 86_400;
    let mut cursor: i64 = meta_get(conn, "backfill_cursor")
        .and_then(|v| v.parse().ok())
        .or_else(|| conn.query_row("SELECT MIN(ts) FROM obs", [], |r| r.get::<_, Option<i64>>(0)).ok().flatten())
        .unwrap_or(0);
    if cursor == 0 {
        return; // nothing heard yet — no idea where the station's history ends
    }
    let mut empty = 0;
    while empty < 3 {
        let start = cursor - chunk;
        let url = format!(
            "https://swd.weatherflow.com/swd/rest/observations/device/{device_id}?token={token}&time_start={start}&time_end={cursor}"
        );
        let body = match ureq::get(&url).timeout(std::time::Duration::from_secs(30)).call() {
            Ok(r) => r.into_string().unwrap_or_default(),
            Err(ureq::Error::Status(code, _)) => {
                if code == 429 || code >= 500 {
                    eprintln!("weatherdesk: backfill paused on HTTP {code}, retrying in 60s");
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    continue;
                }
                eprintln!("weatherdesk: backfill stopped on HTTP {code}");
                break;
            }
            Err(_) => {
                eprintln!("weatherdesk: backfill paused (network), retrying in 60s");
                std::thread::sleep(std::time::Duration::from_secs(60));
                continue;
            }
        };
        let rows: Vec<Vec<Option<f64>>> = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("obs").cloned())
            .and_then(|o| o.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .map(|o| o.as_array().map(|a| a.iter().map(|x| x.as_f64()).collect()).unwrap_or_default())
            .collect();
        let mut added = 0;
        for o in &rows {
            if insert(conn, o, SRC_BACKFILL) {
                added += 1;
            }
        }
        eprintln!("weatherdesk: backfill {start}..{cursor} — {} rows, {added} new", rows.len());
        empty = if rows.is_empty() { empty + 1 } else { 0 };
        cursor = start;
        meta_set(conn, "backfill_cursor", &cursor.to_string());
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    meta_set(conn, "backfill_done", "1");
    eprintln!("weatherdesk: backfill complete");
}

// ponytail: one check, on the two things here that can be silently wrong — an insert that
// silently drops a field, and a day boundary that puts yesterday's high on the wrong row.
#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(&format!(
            "CREATE TABLE obs (ts INTEGER PRIMARY KEY, {}, src INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);",
            FIELDS.iter().map(|f| format!("{f} REAL")).collect::<Vec<_>>().join(", ")
        ))
        .unwrap();
        c
    }

    fn obs(ts: i64, temp: f64, rain: f64) -> Vec<Option<f64>> {
        let mut o = vec![Some(ts as f64); 19];
        o[7] = Some(temp);
        o[12] = Some(rain);
        o
    }

    #[test]
    fn insert_is_idempotent_and_keeps_every_field() {
        let c = mem();
        assert!(insert(&c, &obs(1_700_000_000, 21.5, 0.4), SRC_UDP));
        assert!(!insert(&c, &obs(1_700_000_000, 99.0, 9.0), SRC_UDP), "same timestamp inserted twice");
        let (temp, rain, day_rain): (f64, f64, f64) = c
            .query_row("SELECT temp, rain, day_rain FROM obs", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!((temp, rain), (21.5, 0.4));
        assert_eq!(day_rain, 1_700_000_000.0, "last tuple field lost — column list is off by one");
    }

    #[test]
    fn daily_rows_follow_the_viewer_s_timezone() {
        let c = mem();
        // 2023-11-15 04:00 UTC is still the 14th in US Central
        insert(&c, &obs(1_700_020_800, 10.0, 1.0), SRC_UDP);
        assert!(daily_json(&c, 0).contains("2023-11-15"));
        assert!(daily_json(&c, -300).contains("2023-11-14"));
    }
}
