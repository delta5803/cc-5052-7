import { CHART, WINDOWS } from '/lib/chart.js';

const $ = (id) => document.getElementById(id);
const state = {
  clientId: null,
  audio: null,
  offset: null,          // {lo, hi, rtt} in the server clock vs performance clock
  round: null,
  startLocal: null,      // performance-clock reading at media time 0
  hits: new Map(),
  hitSeq: 0,
  chartNotes: CHART.notes
};

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// --- Clock synchronization -------------------------------------------------
// Two-phase ping/complete. All readings are performance.now() seconds on the
// client and the server's monotonic clock on the server. We keep the tightest
// offset envelope across samples; RTT estimates the network uncertainty.
async function oneSyncSample() {
  const t0 = performance.now() / 1000;
  const ping = await post('/api/sync-ping', { clientId: state.clientId, t0 });
  const t3 = performance.now() / 1000;
  const complete = await post('/api/sync-complete', {
    clientId: state.clientId, nonce: ping.nonce,
    t0, t1: ping.t1, t2: ping.t2, t3
  });
  state.offset = complete.bounds;
  return complete.bounds;
}

async function connect() {
  $('sync-state').textContent = '连接中…';
  $('sync-state').className = 'badge run';
  const audio = new AudioContext();
  await audio.resume();
  state.audio = audio;
  // Reference pair tying the audio presentation clock to the performance clock:
  // performance time at the instant audio time was zero. Every audio timestamp
  // is converted into the performance domain before it leaves the client.
  state.audioZeroPerf = performance.now() / 1000 - audio.currentTime;

  const name = $('name').value.trim() || `player-${Math.random().toString(36).slice(2, 6)}`;
  const reg = await post('/api/register', {
    name,
    outUnc: Number($('out-unc').value) / 1000,
    inUnc: Number($('in-unc').value) / 1000
  });
  state.clientId = reg.client.id;

  const samples = [];
  for (let i = 0; i < 5; i++) samples.push(await oneSyncSample());
  const b = state.offset;
  $('sync-state').textContent = '已同步';
  $('sync-state').className = 'badge ok';
  $('sync-detail').innerHTML =
    `时钟偏移区间 [${fmtMs(b.lo)}, ${fmtMs(b.hi)}] ms · 最佳 RTT ${fmtMs(b.rtt)} ms ` +
    `· 声明输出 ±${reg.client.outUnc * 1000}ms / 输入 ±${reg.client.inUnc * 1000}ms`;
  $('round-panel').hidden = false;
  renderLanes();
  // Keep refreshing the offset envelope; the server keeps only the tightest.
  state.syncTimer = setInterval(async () => {
    try {
      const b = await oneSyncSample();
      $('sync-detail').innerHTML =
        `时钟偏移区间 [${fmtMs(b.lo)}, ${fmtMs(b.hi)}] ms · 最佳 RTT ${fmtMs(b.rtt)} ms ` +
        `· 声明输出 ±${reg.client.outUnc * 1000}ms / 输入 ±${reg.client.inUnc * 1000}ms`;
    } catch { /* transient sync failure keeps prior bounds */ }
  }, 5000);
}

// local = server + offset  =>  server = local - offset(center)
function localToServer(localT) {
  const center = (state.offset.lo + state.offset.hi) / 2;
  return localT - center;
}
function serverToLocal(serverT) {
  const center = (state.offset.lo + state.offset.hi) / 2;
  return serverT + center;
}

// --- Real audio passage ----------------------------------------------------
function schedulePassage(roundView) {
  const ctx = state.audio;
  // Media origin on the performance clock (used for hit mapping), then
  // converted into the audio presentation clock for actual scheduling.
  state.startLocal = serverToLocal(roundView.startS);
  const startAudio = state.startLocal - state.audioZeroPerf;
  const master = ctx.createGain();
  master.gain.value = 0.25;
  master.connect(ctx.destination);

  // Metronome count-in plus each chart note as a short oscillator voice.
  for (const note of CHART.notes) {
    const at = startAudio + note.t;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = note.freq;
    gain.gain.setValueAtTime(0.0001, Math.max(ctx.currentTime, at));
    gain.gain.exponentialRampToValueAtTime(0.9, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + 0.25);
  }
}

async function startRound() {
  const out = await post('/api/round/start', { startDelay: 0.8 });
  state.round = out.round;
  schedulePassage(out.round);
  $('round-state').textContent = '乐段已调度';
  $('round-state').className = 'badge run';
}

// --- Hit capture: three distinct timestamps --------------------------------
function captureHit() {
  if (!state.round || !state.offset || state.startLocal == null) return;
  // inputLocal: input event on the performance clock.
  const inputLocal = performance.now() / 1000;
  // presentRaw: the same instant on the audio presentation clock; presentLocal
  // is its reading converted onto the performance clock so both share a time
  // base with the clock-sync measurements the server actually uses.
  const presentRaw = state.audio.currentTime;
  const presentLocal = state.audioZeroPerf + presentRaw;
  const localMedia = inputLocal - state.startLocal;
  if (localMedia < -0.25 || localMedia > CHART.duration + 2) return;

  const hitId = `${state.clientId}-${++state.hitSeq}-${crypto.randomUUID().slice(0, 8)}`;
  const payload = {
    clientId: state.clientId,
    roundId: state.round.id,
    hitId,
    inputLocal,
    presentLocal,
    presentRaw,
    localMedia
  };
  state.hits.set(hitId, {
    payload, sentAt: performance.now() / 1000, ack: null, status: '发送中'
  });
  sendHit(payload);
  renderHits();
}

async function sendHit(payload, isRetry = false) {
  try {
    const ack = await post('/api/hit', payload);
    const row = state.hits.get(payload.hitId);
    if (row) {
      row.ack = ack;
      row.status = ack.duplicate ? '重传（幂等）' : ack.accepted === false ? `已拒绝:${ack.reason}` : '已采纳为候选';
      renderHits();
    }
  } catch {
    // Retransmission carries the same stable hitId; the server deduplicates.
    if (!isRetry) setTimeout(() => sendHit(payload, true), 400);
  }
}

// --- Rendering -------------------------------------------------------------
function fmtMs(v) { return (v * 1000).toFixed(1); }

function renderLanes() {
  const lanes = $('note-lanes');
  lanes.innerHTML = '';
  for (const n of CHART.notes) {
    const el = document.createElement('div');
    el.className = 'note';
    el.id = `lane-${n.id}`;
    el.style.left = `calc(${(n.t / CHART.duration) * 100}% - 5px)`;
    el.title = `${n.id} @${n.t}s ${n.label}`;
    lanes.appendChild(el);
  }
}

function renderHits() {
  const tbody = $('hit-rows');
  tbody.innerHTML = '';
  for (const [id, h] of state.hits) {
    const tr = document.createElement('tr');
    const ackRecord = h.ack?.record;
    tr.innerHTML = `
      <td class="mono">${id.slice(-10)}</td>
      <td class="mono">${h.payload.inputLocal.toFixed(3)}s</td>
      <td class="mono">${h.payload.presentRaw.toFixed(3)}s → ${h.payload.presentLocal.toFixed(3)}s</td>
      <td class="mono">${ackRecord ? ackRecord.recvS.toFixed(3) + 's' : '—'}</td>
      <td class="mono">${fmtMs(h.payload.localMedia)}ms</td>
      <td class="mono">${ackRecord && ackRecord.medLo != null
        ? `[${fmtMs(ackRecord.medLo)}, ${fmtMs(ackRecord.medHi)}]ms` : '—'}</td>
      <td><span class="tag ${h.ack?.accepted === false ? 'rej' : ''}">${h.status}</span></td>`;
    tbody.appendChild(tr);
  }
}

function renderResults(roundView) {
  const wrap = $('results');
  if (!roundView.notes.some((n) => n.result)) return;
  wrap.innerHTML = '';
  for (const n of roundView.notes) {
    if (!n.result) continue;
    const r = n.result;
    const card = document.createElement('div');
    card.className = 'note-card';
    const amb = r.ambiguous ? '<span class="tag amb">有界·存疑</span>' : '';
    let body = '';
    if (r.adopted) {
      const mine = r.adopted.clientId === state.clientId;
      body = `
        <div class="head">
          <strong>${r.noteId} @${r.t}s</strong>
          <span class="tag ${r.grade}">${r.grade.toUpperCase()}</span>${amb}
          <span>采用 ${r.adopted.clientId}${mine ? '（你）' : ''} ·
            偏差区间 [${fmtMs(r.adopted.devLo)}, ${fmtMs(r.adopted.devHi)}] ms</span>
        </div>
        <div class="evidence small mono">
          证据：本地媒体 + 时钟映射取交，再由服务器接收时刻钳制；窗口 perfect ±${WINDOWS.perfect * 1000}ms / good ±${WINDOWS.good * 1000}ms
          ${r.contenders?.length > 1 ? `<br>候选 ${r.contenders.length} 条：` +
            r.contenders.map((c) => `${c.clientId}=${c.grade}`).join('，') : ''}
          ${r.rejected?.length ? `<br>排除：` + r.rejected.map((x) => `${x.clientId}/${x.hitId.slice(-6)}(${x.reason})`).join('，') : ''}
        </div>`;
    } else {
      body = `
        <div class="head"><strong>${r.noteId} @${r.t}s</strong>
          <span class="tag miss">MISS</span><span>${r.reason}</span></div>
        <div class="evidence small mono">
          ${r.rejected?.length ? '排除：' + r.rejected.map((x) => `${x.clientId}(${x.reason})`).join('，') : '窗口内无有效证据'}
        </div>`;
    }
    card.innerHTML = body;
    wrap.appendChild(card);
    const lane = $(`lane-${r.noteId}`);
    if (lane) lane.className = `note hit-${r.grade}`;
  }
}

function renderClients(snapshot) {
  $('clients').innerHTML = snapshot.clients.map((c) => `
    <span class="client-chip">
      <span class="dot ${c.connected ? 'on' : ''}"></span>
      ${c.name} <span class="small muted">${c.id}${c.id === state.clientId ? '（你）' : ''}</span>
      ${c.offset ? `<span class="small muted">RTT ${fmtMs(c.offset.rtt)}ms</span>` : ''}
    </span>`).join('');
}

// --- Animation & live updates ----------------------------------------------
function tick() {
  if (state.round && state.startLocal != null) {
    const media = performance.now() / 1000 - state.startLocal;
    const pct = Math.min(100, Math.max(0, (media / CHART.duration) * 100));
    $('progress').style.width = `${pct}%`;
    $('playhead').style.left = `${pct}%`;
    $('round-state').textContent =
      media < 0 ? `倒计时 ${(-media).toFixed(1)}s` : `播放中 ${media.toFixed(2)}s / ${CHART.duration}s`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

const es = new EventSource('/events');
es.addEventListener('snapshot', (e) => renderClients(JSON.parse(e.data)));
es.addEventListener('client', (e) => fetch('/api/snapshot').then((r) => r.json()).then(renderClients));
es.addEventListener('round', (e) => {
  const rv = JSON.parse(e.data).round;
  if (state.round && rv.id === state.round.id) {
    state.round = rv;
    renderResults(rv);
  }
});
es.addEventListener('note', (e) => {
  const { roundId, result } = JSON.parse(e.data);
  if (state.round && roundId === state.round.id) {
    const note = state.round.notes.find((n) => n.noteId === result.noteId);
    if (note) note.result = result;
    renderResults(state.round);
  }
});

$('connect').addEventListener('click', connect);
$('start-round').addEventListener('click', startRound);
$('hit-btn').addEventListener('click', captureHit);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !$('round-panel').hidden) {
    e.preventDefault();
    captureHit();
  }
});
