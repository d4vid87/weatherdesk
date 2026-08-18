// Tempest hub broadcasts on UDP 50222 — same wind and strike events the cloud websocket carries,
// only without the round trip and without needing the internet at all. Browsers can't hold a UDP
// socket, so the desktop app listens and re-serves the last packet per type at /udp; a plain
// browser install has no such route and this module switches itself off on the first miss.
import { every, num, expires } from './app.js';
import { renderRapid, onStrike } from './signals.js';

// The app window runs on tauri://localhost, so it gets an absolute URL injected at build of the
// webview; the LAN tablet is same-origin with the server and uses the relative path.
const URL = window.__WD_UDP || '/udp';
const SRV = window.__WD_SRV || '';
const FRESH_SEC = 10;
// obs_st is a once-a-minute report, so the 10s window that suits 3s rapid_wind would reject
// every one of them.
const OBS_FRESH_SEC = 120;

let misses = 0, off = false, slow = false, lastObs = 0, streaming = false;

const schedule = (sec) => every('udp', sec, poll);

async function poll() {
  // The stream delivers each packet the moment the hub sends it; polling on top of that is a
  // request every three seconds for something we already have.
  if (off || streaming) return;
  let j;
  try {
    const r = await fetch(URL, { signal: expires(3000) });
    if (!r.ok) throw new Error(r.status);
    j = await r.json();
    misses = 0;
    if (slow) { slow = false; schedule(3); }
  } catch {
    // Three strikes rather than one: a single hiccup on the loopback shouldn't cost the
    // rest of the session's local feed.
    if (++misses < 3) return;
    misses = 0;
    // A plain browser or the Android build has no /udp route at all and never will — switch off.
    // On the desktop the route exists, so a miss means the hub is unplugged or the app just
    // started: back off to a minute and keep looking, because the local feed is the only feed
    // in UDP-only mode.
    if (!window.__WD_UDP) off = true;
    else if (!slow) { slow = true; schedule(60); }
    return;
  }

  apply(j);
}

// One poll's worth of packets, keyed by type — which is also the shape of a single streamed
// packet, so both paths land here.
function apply(j) {
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

  // Same SI tuple the cloud websocket sends, so it rides the same event — the hero, the gauges
  // and the MQTT publisher all get a local feed without a token. Dedupe by the report's own
  // timestamp: a 3s poll sees each minute-old report about twenty times.
  // The hub reports its own health every minute. No freshness gate: a status packet that has
  // stopped arriving is exactly what the health card needs to show, stamp and all.
  if (j.device_status) {
    window.dispatchEvent(new CustomEvent('wd:device-status', { detail: j.device_status }));
  }

  const o = j.obs_st;
  if (o?.obs?.[0] && now - o._at < OBS_FRESH_SEC && o.obs[0][0] !== lastObs) {
    lastObs = o.obs[0][0];
    window.dispatchEvent(new CustomEvent('wd:ws-obs', { detail: o.obs[0] }));
  }
}

// Everything the server hears, pushed as it arrives: a gust shows up in the same second the hub
// broadcast it instead of up to three seconds later. The poll stays as the fallback — a static
// self-host has no /events route, and neither does a v2 desktop app on the LAN.
function stream() {
  if (!('EventSource' in window)) return;
  let es;
  try { es = new EventSource(`${SRV}/events`); } catch { return; }
  es.addEventListener('udp', (e) => {
    let p;
    try { p = JSON.parse(e.data); } catch { return; }
    if (!p?.type) return;
    streaming = true;
    apply({ [p.type]: p });
  });
  // The revision rides along: a screen that already holds it is the one that just wrote it, and
  // re-pulling its own write is how the config sync used to chase its own tail.
  es.addEventListener('config', (e) => {
    let d = null;
    try { d = JSON.parse(e.data); } catch { /* older server sent no body */ }
    window.dispatchEvent(new CustomEvent('wd:config-rev', { detail: d }));
  });
  // EventSource reconnects by itself; the poll covers the gap until a packet proves it back.
  es.onerror = () => { streaming = false; };
}

export function initUdp() {
  schedule(slow ? 60 : 3);
  stream();
}

// ponytail-lite self-check alongside layout.js's: the freshness window is the only arithmetic here.
if (location.search.includes('selftest')) {
  const now = Date.now() / 1000;
  console.assert(now - (now - 3) < FRESH_SEC, 'udp: recent packet counts as fresh');
  console.assert(!(now - (now - 60) < FRESH_SEC), 'udp: minute-old packet is stale');
  console.assert(num(1.5, 1) === '1.5', 'udp: app.js helpers imported');
  console.assert(now - (now - 60) < OBS_FRESH_SEC, 'udp: minute-old obs_st still counts');
  console.assert(!(now - (now - 600) < OBS_FRESH_SEC), 'udp: ten-minute-old obs_st is stale');
}
