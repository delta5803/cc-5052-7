// End-to-end smoke test over real HTTP/SSE, exercising the same code path a
// browser uses: register -> sync ping/complete -> start round -> hits with
// three timestamps -> SSE note results.
const BASE = process.env.BASE || 'http://localhost:8080';

async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('  ok  ' + msg);
}

const OFFSET = 0.12; // local clock runs 120ms ahead of the server clock
const client = {
  sync: null,
  startLocal: null,
  // Absolute wall clock, as a real browser/client clock would be; its origin
  // is independent of the server's process-relative monotonic clock.
  local() { return Date.now() / 1000 + OFFSET; }
};

// 1. Register
const reg = await post('/api/register', {
  name: 'http-smoke', outUnc: 0.025, inUnc: 0.02
});
check(reg.client?.id, 'registration returns client id');
const cid = reg.client.id;

// 2. Three sync rounds with simulated legs
for (let i = 0; i < 3; i++) {
  const t0 = client.local();
  await sleep(15); // uplink
  const ping = await post('/api/sync-ping', { clientId: cid, t0 });
  check(!ping.error, 'sync ping stamped: ' + JSON.stringify(ping));
  await sleep(10); // downlink
  const t3 = client.local();
  const done = await post('/api/sync-complete', {
    clientId: cid, nonce: ping.nonce, t0, t1: ping.t1, t2: ping.t2, t3
  });
  check(done.bounds, 'sync complete returns bounds');
  client.sync = done.bounds;
}
const center = (client.sync.lo + client.sync.hi) / 2;
check(Math.abs(center - 0.12) < 0.05, `offset center near true 120ms (got ${(center * 1000).toFixed(1)}ms)`);

// 3. Open SSE and collect note events (raw stream; Node has no global EventSource)
const noteEvents = [];
const sseRes = await fetch(BASE + '/events', {
  headers: { accept: 'text/event-stream' }
});
const sseReader = sseRes.body.getReader();
const sseDone = (async () => {
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await sseReader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop();
    for (const frame of frames) {
      const lines = frame.split('\n');
      const evLine = lines.find((l) => l.startsWith('event:'));
      const dataLine = lines.find((l) => l.startsWith('data:'));
      const evName = evLine ? evLine.slice(6).trim() : '';
      if (evName === 'note' && dataLine) {
        noteEvents.push(JSON.parse(dataLine.slice(5).trim()));
      }
    }
  }
})();
await sleep(200);

// 4. Start a round and schedule two hits (perfect + good)
const round = await post('/api/round/start', { startDelay: 0.5 });
check(round.round?.id, 'round scheduled');
const startS = round.round.startS;
const centerOff = center;
client.startLocal = startS + centerOff;
async function scheduleHit(mediaT, skew, hitId) {
  // Fire relative to the round start expressed on our absolute local clock.
  const delayMs = (client.startLocal + mediaT + skew - client.local()) * 1000;
  await sleep(Math.max(50, delayMs));
  // Capture the real local reading after waking, then derive media time from
  // the same reading so the three timestamps stay internally consistent.
  const inputLocal = client.local();
  const localMedia = inputLocal - client.startLocal;
  const payload = {
    clientId: cid, roundId: round.round.id, hitId,
    inputLocal,
    presentLocal: inputLocal,
    localMedia
  };
  const ack = await post('/api/hit', payload);
  check(!!ack.record, `hit ${hitId} stored: ${ack.accepted} ${ack.reason || ''}`);
  // Immediate retransmission must be idempotent.
  const dup = await post('/api/hit', payload);
  check(dup.duplicate === true, `retransmission of ${hitId} marked duplicate`);
}
await scheduleHit(2.0, 0.0, 'smoke-h1');
await scheduleHit(2.5, 0.08, 'smoke-h2');

// 5. Wait for the grace window and verify finalization over SSE
const targetLocal = client.startLocal + 2.5 + 0.35 + 0.3;
await sleep(Math.max(100, (targetLocal - client.local()) * 1000));
const snap = await (await fetch(BASE + '/api/snapshot')).json();
const rv = snap.rounds.find((r) => r.id === round.round.id);
const n1 = rv.notes.find((n) => n.noteId === 'n1').result;
const n2 = rv.notes.find((n) => n.noteId === 'n2').result;
check(n1 && n1.grade === 'perfect', `n1 finalized perfect (got ${n1?.grade})`);
check(n2 && n2.grade === 'good', `n2 finalized good (got ${n2?.grade})`);
check(n1.adopted.hitId === 'smoke-h1', 'adopted hit has stable identity');
const storedHits = rv.hits.filter((h) => h.hitId === 'smoke-h1');
check(storedHits.length === 1, 'duplicate payload stored exactly once');
check(noteEvents.some((e) => e.result.noteId === 'n1'), 'finalization delivered over SSE');

await sseReader.cancel().catch(() => {});
await sseDone.catch(() => {});
console.log('\nHTTP smoke test passed');
process.exit(0);
