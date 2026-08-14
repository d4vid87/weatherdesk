// Tempest hub broadcasts on UDP 50222 — same wind and strike events the cloud websocket carries,
// only without the round trip and without needing the internet at all. Browsers can't hold a UDP
// socket, so the desktop app listens and re-serves the last packet per type at /udp; a plain
// browser install has no such route and this module switches itself off on the first miss.
import { every, num } from './app.js';
import { renderRapid, onStrike } from './signals.js';

// The app window runs on tauri://localhost, so it gets an absolute URL injected at build of the
// webview; the LAN tablet is same-origin with the server and uses the relative path.
const URL = window.__WD_UDP || '/udp';
const FRESH_SEC = 10;

let misses = 0, off = false;

async function poll() {
  if (off) return;
  let j;
  try {
    const r = await fetch(URL, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(r.status);
    j = await r.json();
    misses = 0;
  } catch {
    // Three strikes rather than one: a single hiccup on the loopback shouldn't cost the
    // rest of the session's local feed.
    if (++misses >= 3) off = true;
    return;
  }

  const now = Date.now() / 1000;
  const fresh = (p) => p && now - p._at < FRESH_SEC;

  const w = j.rapid_wind;
  if (fresh(w) && w.ob) {
    renderRapid(w.ob[1], w.ob[2]);
    const el = document.getElementById('ws-state');
    if (el) { el.textContent = 'live · local UDP'; el.className = 'ok'; }
  }

  const s = j.evt_strike;
  if (fresh(s) && s.evt) onStrike(s.evt);
}

export function initUdp() {
  every('udp', 3, poll);
}

// ponytail-lite self-check alongside layout.js's: the freshness window is the only arithmetic here.
if (location.search.includes('selftest')) {
  const now = Date.now() / 1000;
  console.assert(now - (now - 3) < FRESH_SEC, 'udp: recent packet counts as fresh');
  console.assert(!(now - (now - 60) < FRESH_SEC), 'udp: minute-old packet is stale');
  console.assert(num(1.5, 1) === '1.5', 'udp: app.js helpers imported');
}
