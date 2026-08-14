// A publish-only MQTT 3.1.1 client over WebSockets.
//
// ponytail: hand-rolled, ~150 lines, because that is all this dashboard needs — CONNECT, PUBLISH
// at QoS 0, PINGREQ. Nothing here subscribes (the read-back path is Home Assistant's REST API), so
// the parts of the protocol that cost real code — QoS 1/2 flows, inflight windows, retransmit
// timers — never run. Vendoring mqtt.js would add 200 KB to a directory with no build step.
//
// Broker must expose a WebSocket listener with the `mqtt` subprotocol (mosquitto:
// `listener 9001` + `protocol websockets`).

const enc = new TextEncoder();

// MQTT's own length prefix: two bytes big-endian, then the UTF-8 bytes.
function str(s) {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 0xff, ...b];
}

// Remaining Length: 7 bits a byte, high bit continues. Four bytes covers 256 MB, far past
// anything a weather reading needs.
function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

const packet = (type, flags, body) => Uint8Array.from([(type << 4) | flags, ...varint(body.length), ...body]);

export function connectPacket({ clientId, user, pass, will, keepalive = 60 }) {
  // Connect flags: clean session, plus a will and credentials when given.
  let flags = 0x02;
  const body = [...str('MQTT'), 4];
  const tail = [];
  if (will) {
    flags |= 0x04 | (will.retain ? 0x20 : 0); // will QoS stays 0
    tail.push(...str(will.topic), ...str(will.payload));
  }
  if (user) { flags |= 0x80; tail.push(...str(user)); }
  if (pass) { flags |= 0x40; tail.push(...str(pass)); }
  body.push(flags, keepalive >> 8, keepalive & 0xff, ...str(clientId), ...tail);
  return packet(1, 0, body);
}

export function publishPacket(topic, payload, retain = false) {
  // QoS 0: no packet id, no ack, nothing to track.
  return packet(3, retain ? 1 : 0, [...str(topic), ...enc.encode(payload)]);
}

/// Connect, and keep reconnecting. Returns an object with `publish` and the current state; the
/// caller re-publishes its retained topics from `onConnect`.
export function mqtt({ url, user, pass, clientId, will, onConnect, onState }) {
  let ws = null, ping = null, backoff = 1000, closed = false;
  const state = (s) => onState?.(s);

  function open() {
    if (closed) return;
    state('connecting');
    try {
      ws = new WebSocket(url, 'mqtt');
    } catch (e) {
      // A ws:// URL on an https page throws here rather than failing async.
      state('failed: ' + e.message);
      return;
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(connectPacket({ clientId, user, pass, will }));
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data);
      if ((b[0] >> 4) !== 2) return; // only CONNACK matters to a publisher
      if (b[3] !== 0) { // return code: 4 = bad credentials, 5 = not authorized
        state(`refused (code ${b[3]})`);
        closed = true;
        try { ws.close(); } catch { /* already gone */ }
        return;
      }
      backoff = 1000;
      state('connected');
      // Keepalive: a broker with no traffic for 1.5× this drops the connection.
      clearInterval(ping);
      ping = setInterval(() => ws.readyState === 1 && ws.send(packet(12, 0, [])), 30000);
      onConnect?.();
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (closed) return;
      state('reconnecting');
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 60000); // same ladder signals.js uses on the Tempest socket
    };
    ws.onerror = () => { try { ws.close(); } catch { /* onclose retries */ } };
  }

  open();
  return {
    publish(topic, payload, retain) {
      if (ws?.readyState === 1) ws.send(publishPacket(topic, String(payload), retain));
    },
    close() { closed = true; clearInterval(ping); try { ws?.close(); } catch { /* nothing open */ } },
  };
}

// ponytail-lite self-check: `?selftest` asserts the two packets that go on the wire, byte for
// byte. Get a length prefix wrong and a broker just closes the socket with no explanation.
if (typeof location !== 'undefined' && location.search.includes('selftest')) {
  const c = connectPacket({ clientId: 'wd', keepalive: 60 });
  console.assert(
    [...c].join(',') === [16, 14, 0, 4, 77, 81, 84, 84, 4, 2, 0, 60, 0, 2, 119, 100].join(','),
    'CONNECT bytes', [...c],
  );
  const p = publishPacket('a/b', 'hi', true);
  console.assert([...p].join(',') === [49, 7, 0, 3, 97, 47, 98, 104, 105].join(','), 'PUBLISH bytes', [...p]);
  console.assert(varint(321).join(',') === '193,2', 'varint');
}
