// The observation archive. v2 appended every hub broadcast to `log/obs-YYYY-MM.jsonl` and
// re-read the whole thing for every Data-tab visit; v3 keeps a SQLite table instead, so a
// decade of minutes is a GROUP BY instead of a full parse.
//
// The JSONL files are imported once and then left alone forever — they are the escape hatch if
// this file is ever wrong, and they cost nothing to keep.

use rusqlite::{params_from_iter, Connection};
use std::path::{Path, PathBuf};

/// obs_st tuple layout minus its leading timestamp, same order as `site/js/api.js` OBS.
pub const FIELDS: [&str; 18] = [
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

/// Built once. The string never changes, and formatting it per row was work done on the ingest
/// path a few times a second.
fn insert_sql() -> &'static str {
    static SQL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SQL.get_or_init(|| {
        let cols = FIELDS.join(", ");
        let holes = (1..=20).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
        format!("INSERT OR IGNORE INTO obs (ts, {cols}, src) VALUES ({holes})")
    })
}

/// One raw SI tuple, exactly as the hub broadcast it. `INSERT OR IGNORE` on the timestamp
/// primary key is what makes the import, the backfill and a re-broadcasting hub all idempotent.
pub fn insert(conn: &Connection, obs: &[Option<f64>], src: i64) -> bool {
    let Some(Some(ts)) = obs.first().copied() else { return false };
    let mut vals: Vec<Option<f64>> = Vec::with_capacity(20);
    vals.push(Some(ts));
    for i in 1..=FIELDS.len() {
        vals.push(obs.get(i).copied().flatten());
    }
    vals.push(Some(src as f64));
    // prepare_cached: the statement is parsed once per connection instead of once per reading.
    let Ok(mut stmt) = conn.prepare_cached(insert_sql()) else { return false };
    stmt.execute(params_from_iter(vals)).map(|n| n > 0).unwrap_or(false)
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
    let ds = day_start(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        tz_off_min,
    );
    daily_join(&daily_head_json(conn, tz_off_min, ds), daily_today_row(conn, tz_off_min, ds).as_deref())
}

/// Midnight local, as an epoch second. `div_euclid` rather than `/`: a negative offset west of
/// Greenwich would otherwise round towards zero and land the boundary a day out.
pub fn day_start(now: i64, tz_off_min: i64) -> i64 {
    let off = tz_off_min * 60;
    (now + off).div_euclid(86400) * 86400 - off
}

/// Everything before today. This is the expensive half — a full-table GROUP BY of every reading
/// the archive holds — and it is also the half that cannot change any more, so the server caches
/// it across requests and only today's row is recomputed.
pub fn daily_head_json(conn: &Connection, tz_off_min: i64, day_start: i64) -> String {
    rows_json(
        conn,
        "SELECT strftime('%Y-%m-%d', ts + ?1, 'unixepoch'),
                MIN(temp), MAX(temp), MAX(wind_gust), SUM(rain), SUM(strikes), MIN(battery)
         FROM obs WHERE ts < ?2 GROUP BY 1 ORDER BY 1",
        tz_off_min,
        day_start,
    )
    .map(|v| format!("[{}]", v.join(",")))
    .unwrap_or_else(|| "[]".into())
}

/// Today, over the primary key range — an index lookup rather than a scan. `None` on a day with
/// no readings yet, which is what the `GROUP BY` returns for an empty range.
pub fn daily_today_row(conn: &Connection, tz_off_min: i64, day_start: i64) -> Option<String> {
    rows_json(
        conn,
        "SELECT strftime('%Y-%m-%d', ts + ?1, 'unixepoch'),
                MIN(temp), MAX(temp), MAX(wind_gust), SUM(rain), SUM(strikes), MIN(battery)
         FROM obs WHERE ts >= ?2 GROUP BY 1 ORDER BY 1",
        tz_off_min,
        day_start,
    )?
    .pop()
}

/// Glue the cached head and today's row back into one array, without parsing either.
pub fn daily_join(head: &str, today: Option<&str>) -> String {
    match today {
        None => head.to_string(),
        Some(row) if head == "[]" => format!("[{row}]"),
        Some(row) => format!("{},{row}]", head.trim_end_matches(']')),
    }
}

fn rows_json(conn: &Connection, sql: &str, tz_off_min: i64, day_start: i64) -> Option<Vec<String>> {
    let mut stmt = conn.prepare(sql).ok()?;
    let n = |v: Option<f64>| v.map(|x| x.to_string()).unwrap_or_else(|| "null".into());
    let rows = stmt.query_map([tz_off_min * 60, day_start], |r| {
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
    rows.ok().map(|it| it.flatten().collect())
}

/// Delete the oldest week of readings that is older than `cutoff`, and say how many went.
///
/// A week at a time on purpose: two connections write to this file (the ingest path and the UDP
/// listener, which gives up after its ten-second busy timeout and silently drops the reading), so
/// nothing here may hold the write lock for longer than milliseconds. The caller loops until it
/// returns 0.
///
/// ponytail: no VACUUM — it holds the whole file and balloons the WAL. Freed pages are reused, so
/// the file plateaus rather than shrinks; `sqlite3 weatherdesk.db VACUUM` with the app stopped is
/// the escape hatch if the size ever actually matters.
pub fn prune(conn: &Connection, cutoff: i64) -> usize {
    conn.execute(
        "DELETE FROM obs WHERE ts < MIN(?1, (SELECT MIN(ts) FROM obs) + 7*86400)",
        [cutoff],
    )
    .unwrap_or(0)
}

/// Cheap cache key for the aggregate above: the table is append-only in practice, so a row
/// count and the newest timestamp change whenever the answer would.
/// Recent rows, whole tuples, newest last — the shape `api.js` already reads for a Tempest's
/// cloud history, so the page's trend code needs no second parser.
pub fn tuples_json(conn: &Connection, from: i64, to: i64) -> String {
    let cols = FIELDS.join(", ");
    let mut stmt = match conn.prepare(&format!(
        "SELECT ts, {cols} FROM obs WHERE ts >= ?1 AND ts <= ?2 ORDER BY ts"
    )) {
        Ok(s) => s,
        Err(_) => return "{\"obs\":[]}".into(),
    };
    let rows = stmt.query_map([from, to], |r| {
        let mut out = vec![r.get::<_, i64>(0)?.to_string()];
        for i in 1..=FIELDS.len() {
            out.push(r.get::<_, Option<f64>>(i)?.map(|v| v.to_string()).unwrap_or_else(|| "null".into()));
        }
        Ok(format!("[{}]", out.join(",")))
    });
    let body: Vec<String> = match rows {
        Ok(it) => it.flatten().collect(),
        Err(_) => return "{\"obs\":[]}".into(),
    };
    format!("{{\"obs\":[{}]}}", body.join(","))
}

/// MIN/MAX over the primary key are index lookups; COUNT(*) was a full scan of an archive that
/// is meant to hold years, run on every /history/daily request.
/// ponytail: the aggregate itself is still recomputed whenever a new row lands — split it into a
/// cached head plus today's bucket if the archive ever makes that visible.
pub fn stamp(conn: &Connection) -> (i64, i64) {
    conn.query_row(
        "SELECT COALESCE(MIN(ts), 0), COALESCE(MAX(ts), 0) FROM obs",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
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

/// Small, redacted facts for the Health Center. `quick_check` is intentionally used instead of
/// `integrity_check`: it catches structural damage without turning a drawer click into a long scan.
pub fn health(conn: &Connection, path: &Path) -> serde_json::Value {
    let (first, last) = stamp(conn);
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM obs", [], |r| r.get(0)).unwrap_or(0);
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).unwrap_or_else(|_| "unavailable".into());
    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    serde_json::json!({ "ok": check == "ok", "check": check, "rows": rows,
        "first": first, "last": last, "bytes": bytes })
}

pub fn checkpoint(conn: &Connection) -> bool {
    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)").is_ok()
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

pub const BACKUP_FORMAT: i64 = 1;

/// A `.wdbak` is a normal SQLite snapshot with two reserved metadata rows. It can still be
/// opened with sqlite3 when WeatherDesk is gone, which is a better recovery format than a custom
/// archive nobody else understands.
pub fn bundle_to(conn: &Connection, dest: &Path, config: &str) -> rusqlite::Result<()> {
    backup_to(conn, dest)?;
    let bundle = open(dest)?;
    let manifest = serde_json::json!({
        "format": BACKUP_FORMAT, "app": env!("CARGO_PKG_VERSION"),
        "created": crate::server::epoch()
    }).to_string();
    bundle.execute("INSERT INTO meta (key,value) VALUES ('backup:manifest',?1)
        ON CONFLICT(key) DO UPDATE SET value=?1", [&manifest])?;
    bundle.execute("INSERT INTO meta (key,value) VALUES ('backup:config',?1)
        ON CONFLICT(key) DO UPDATE SET value=?1", [config])?;
    bundle.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(())
}

pub fn inspect_bundle(path: &Path) -> Result<serde_json::Value, String> {
    use rusqlite::OpenFlags;
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| "not a SQLite backup")?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|_| "integrity check failed")?;
    if check != "ok" { return Err("integrity check failed".into()); }
    let manifest: serde_json::Value = serde_json::from_str(&meta_get(&conn, "backup:manifest").ok_or("missing backup manifest")?)
        .map_err(|_| "invalid backup manifest")?;
    let format = manifest["format"].as_i64().ok_or("invalid backup format")?;
    if format > BACKUP_FORMAT { return Err("backup was made by a newer WeatherDesk".into()); }
    if format < 1 { return Err("unsupported backup format".into()); }
    let config: serde_json::Value = serde_json::from_str(&meta_get(&conn, "backup:config").ok_or("missing backup settings")?)
        .map_err(|_| "invalid backup settings")?;
    if !config.is_object() { return Err("invalid backup settings".into()); }
    let mut stmt = conn.prepare("PRAGMA table_info(obs)").map_err(|_| "missing observation archive")?;
    let cols: Vec<String> = stmt.query_map([], |r| r.get(1)).map_err(|_| "missing observation archive")?
        .flatten().collect();
    let required = std::iter::once("ts").chain(FIELDS.iter().copied()).chain(std::iter::once("src"));
    if required.clone().any(|c| !cols.iter().any(|x| x == c)) { return Err("backup archive schema is incomplete".into()); }
    let (first, last) = stamp(&conn);
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM obs", [], |r| r.get(0)).unwrap_or(0);
    if first < 0 || last < first { return Err("backup contains invalid timestamps".into()); }
    Ok(serde_json::json!({ "format": format, "app": manifest["app"], "created": manifest["created"],
        "station": config.pointer("/settings/stationName").and_then(|v| v.as_str()).unwrap_or("WeatherDesk"),
        "first": first, "last": last, "rows": rows }))
}

pub fn bundle_config(path: &Path) -> Result<String, String> {
    use rusqlite::OpenFlags;
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| "cannot open backup")?;
    meta_get(&conn, "backup:config").ok_or_else(|| "missing backup settings".into())
}

pub fn replace_from_bundle(conn: &Connection, path: &Path) -> rusqlite::Result<()> {
    let cols = format!("ts, {}, src", FIELDS.join(", "));
    conn.execute("ATTACH DATABASE ?1 AS restore", [path.to_string_lossy().to_string()])?;
    let sql = format!("BEGIN IMMEDIATE;
        DELETE FROM obs;
        INSERT INTO obs ({cols}) SELECT {cols} FROM restore.obs;
        DELETE FROM meta;
        INSERT INTO meta SELECT key, value FROM restore.meta WHERE key NOT LIKE 'backup:%';
        COMMIT;");
    let result = conn.execute_batch(&sql);
    if result.is_err() { let _ = conn.execute_batch("ROLLBACK;"); }
    let _ = conn.execute_batch("DETACH DATABASE restore;");
    result
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
    let mut retries = 0;
    while empty < 3 {
        let start = cursor - chunk;
        let url = format!(
            "https://swd.weatherflow.com/swd/rest/observations/device/{device_id}?token={token}&time_start={start}&time_end={cursor}"
        );
        let body = match ureq::get(&url).timeout(std::time::Duration::from_secs(30)).call() {
            Ok(r) => r.into_string().unwrap_or_default(),
            Err(ureq::Error::Status(code, _)) => {
                if (code == 429 || code >= 500) && retries < 5 {
                    retries += 1;
                    eprintln!("weatherdesk: backfill paused on HTTP {code}, retrying in 60s ({retries}/5)");
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    continue;
                }
                eprintln!("weatherdesk: backfill stopped on HTTP {code}");
                break;
            }
            Err(_) if retries < 5 => {
                retries += 1;
                eprintln!("weatherdesk: backfill paused (network), retrying in 60s ({retries}/5)");
                std::thread::sleep(std::time::Duration::from_secs(60));
                continue;
            }
            Err(_) => {
                eprintln!("weatherdesk: backfill gave up on this chunk after 5 retries; skipping it");
                cursor -= chunk;
                retries = 0;
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

    /// The writer's insert has to keep working now that `src` is a bound parameter rather than
    /// a formatted-in literal, and stay idempotent on the timestamp key.
    #[test]
    fn insert_binds_src_and_ignores_duplicates() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        let mut obs = vec![None; 19];
        obs[0] = Some(1_700_000_000.0);
        obs[7] = Some(21.5);
        assert!(insert(&conn, &obs, 3));
        assert!(!insert(&conn, &obs, 3), "same timestamp inserts once");
        let src: i64 = conn.query_row("SELECT src FROM obs", [], |r| r.get(0)).unwrap();
        assert_eq!(src, 3);
    }

    #[test]
    fn portable_backup_round_trips_archive_metadata_and_config() {
        let dir = std::env::temp_dir().join(format!("wd-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = open(&dir.join("source.db")).unwrap();
        let mut obs = vec![None; 19]; obs[0] = Some(1_700_000_000.0); obs[7] = Some(21.5);
        assert!(insert(&source, &obs, 3));
        meta_set(&source, "kept", "yes");
        let bundle = dir.join("weatherdesk.wdbak");
        let config = r#"{"settings":{"stationName":"Back yard","token":"secret"},"layout":{"hero":{}}}"#;
        bundle_to(&source, &bundle, config).unwrap();
        let summary = inspect_bundle(&bundle).unwrap();
        assert_eq!(summary["rows"], 1);
        assert_eq!(summary["station"], "Back yard");
        assert_eq!(bundle_config(&bundle).unwrap(), config);

        let target = open(&dir.join("target.db")).unwrap();
        let mut other = vec![None; 19]; other[0] = Some(1_800_000_000.0);
        insert(&target, &other, 0);
        replace_from_bundle(&target, &bundle).unwrap();
        assert_eq!(target.query_row("SELECT COUNT(*) FROM obs", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(meta_get(&target, "kept").as_deref(), Some("yes"));
        assert!(meta_get(&target, "backup:config").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn portable_backup_rejects_corruption_and_newer_formats() {
        let dir = std::env::temp_dir().join(format!("wd-bundle-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir); std::fs::create_dir_all(&dir).unwrap();
        let corrupt = dir.join("bad.wdbak"); std::fs::write(&corrupt, b"not sqlite").unwrap();
        assert!(inspect_bundle(&corrupt).is_err());
        let source = open(&dir.join("source.db")).unwrap();
        let newer = dir.join("newer.wdbak");
        bundle_to(&source, &newer, "{}").unwrap();
        let edit = open(&newer).unwrap();
        meta_set(&edit, "backup:manifest", &serde_json::json!({"format": BACKUP_FORMAT + 1}).to_string());
        edit.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap(); drop(edit);
        assert!(inspect_bundle(&newer).unwrap_err().contains("newer"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_restore_keeps_the_live_archive() {
        let target = open(std::path::Path::new(":memory:")).unwrap();
        let mut live = vec![None; 19]; live[0] = Some(1_700_000_000.0);
        assert!(insert(&target, &live, 0));
        let missing = std::env::temp_dir().join(format!("wd-missing-{}.wdbak", std::process::id()));
        let _ = std::fs::remove_file(&missing);
        assert!(replace_from_bundle(&target, &missing).is_err());
        assert_eq!(target.query_row("SELECT ts FROM obs", [], |r| r.get::<_, i64>(0)).unwrap(), 1_700_000_000);
    }

    /// The cache key for /history/daily: no COUNT(*), and it still moves when the archive does.
    #[test]
    fn stamp_is_the_range_not_a_count() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        assert_eq!(stamp(&conn), (0, 0));
        let mut obs = vec![None; 19];
        obs[0] = Some(100.0);
        insert(&conn, &obs, 0);
        obs[0] = Some(500.0);
        insert(&conn, &obs, 0);
        assert_eq!(stamp(&conn), (100, 500));
    }
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

    /// Retention deletes in week-sized bites so the write lock is never held long, and it stops
    /// exactly at the cutoff rather than one bite past it.
    #[test]
    fn prune_walks_a_week_at_a_time_and_stops_at_the_cutoff() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let day = 86_400i64;
        for d in [0i64, 5, 10, 20, 30] {
            insert(&c, &obs(d * day, 20.0, 0.0), SRC_UDP);
        }
        let cutoff = 25 * day;
        let mut rounds = 0;
        while prune(&c, cutoff) > 0 {
            rounds += 1;
            assert!(rounds < 10, "prune is not making progress");
        }
        // Days 0/5 go together (one week from the oldest), then 10, then 20 — three rounds.
        assert_eq!(rounds, 3);
        assert_eq!(stamp(&c), (30 * day, 30 * day), "only the rows past the cutoff are left");
        assert_eq!(prune(&c, cutoff), 0, "a settled archive is a no-op");

        let empty = open(std::path::Path::new(":memory:")).unwrap();
        assert_eq!(prune(&empty, cutoff), 0, "an empty archive is not an error");
    }

    /// The expensive half of /history/daily is everything before today, and it must not change
    /// when today's readings land — that is the whole basis for caching it.
    #[test]
    fn today_s_row_is_appended_without_recomputing_the_head() {
        // 2023-11-15 00:00 UTC.
        let midnight = 1_700_006_400i64;
        assert_eq!(day_start(midnight + 3600, 0), midnight);
        assert_eq!(day_start(midnight - 1, 0), midnight - 86400);
        // Five hours west: local midnight is 05:00 UTC, so 02:00 UTC is still yesterday.
        assert_eq!(day_start(midnight + 2 * 3600, -300), midnight - 86400 + 5 * 3600);

        let c = open(std::path::Path::new(":memory:")).unwrap();
        insert(&c, &obs(midnight - 3600, 10.0, 1.0), SRC_UDP);
        let head = daily_head_json(&c, 0, midnight);
        assert!(head.contains("2023-11-14"));
        assert!(daily_today_row(&c, 0, midnight).is_none(), "an empty day has no row");

        insert(&c, &obs(midnight + 3600, 20.0, 2.0), SRC_UDP);
        assert_eq!(daily_head_json(&c, 0, midnight), head, "today's reading never touches the head");
        let today = daily_today_row(&c, 0, midnight).unwrap();
        assert!(today.contains("2023-11-15") && today.contains("\"tempMax\":20"));

        let joined = daily_join(&head, Some(&today));
        let rows: Vec<serde_json::Value> = serde_json::from_str(&joined).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(daily_join("[]", None), "[]");
        assert_eq!(daily_join("[]", Some("{\"day\":\"x\"}")), "[{\"day\":\"x\"}]");
    }

    /// Both ends of the window are honoured — the detail panel asks for a day either side of the
    /// point that was clicked, which is the first caller that ever needed an upper bound.
    #[test]
    fn tuples_honour_both_ends_of_the_window() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        for t in [1_000i64, 2_000, 3_000] {
            insert(&c, &obs(t, 20.0, 0.0), SRC_UDP);
        }
        let body = tuples_json(&c, 1_500, 2_500);
        assert!(body.contains("[2000,"), "the row inside the window is there");
        assert!(!body.contains("[1000,") && !body.contains("[3000,"), "the rows outside it are not");
        assert_eq!(tuples_json(&c, 9_000, 9_999), "{\"obs\":[]}");
    }
}
