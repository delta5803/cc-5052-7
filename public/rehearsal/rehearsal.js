import { calibrateToMedia, naiveMediaTime, DEVICE_ORIGIN } from '/lib/rehearsal/devices.js';
import { judgeHits, compareCalibration, boundaryDifferences, gradeSummary } from '/lib/rehearsal/judgment.js';

const $ = (id) => document.getElementById(id);
const DURATION = 24;

const state = {
  bundle: null,
  // Markers per device: each marker pairs a media time with a device reading.
  markers: { dev1: [], dev2: [] },
  swapped: false,
  deviceVoice: { dev1: 1, dev2: 2 },
  answerOpen: false,
  audio: null,
  activeNodes: [],
  playTimer: null
};

async function load() {
  const res = await fetch('data/bundle.json');
  state.bundle = await res.json();
  for (const id of ['dev1', 'dev2']) {
    state.markers[id] = state.bundle.defaultMarkers[id].map((m) => ({ ...m }));
  }
  renderMarkerEditors();
  renderTimeline();
  renderAnswer();
  renderCounterexamples();
  renderBoundary();
}

// --- Calibration from the current markers ---------------------------------
function currentCalib() {
  const out = {};
  for (const id of ['dev1', 'dev2']) {
    const origin = state.bundle.devices[id].origin;
    out[id] = calibrateToMedia(state.markers[id], origin);
  }
  return out;
}

function recompute() {
  const calib = currentCalib();
  const raw = judgeHits(state.bundle.hits, { mode: 'raw', deviceVoice: state.deviceVoice });
  const calibrated = judgeHits(state.bundle.hits, {
    mode: 'calibrated', calib, deviceVoice: state.deviceVoice
  });
  return {
    calib, raw, calibrated,
    comparison: compareCalibration(state.bundle.hits, calib),
    boundary: boundaryDifferences(calibrated)
  };
}

// --- Timeline --------------------------------------------------------------
function pct(t) { return (t / DURATION) * 100; }

function renderTimeline() {
  const tl = $('timeline');
  tl.innerHTML = '';
  const lanes = [
    { label: '伴奏拍', top: 0 },
    { label: '高声部音符 / dev' + (state.swapped ? 2 : 1), top: 46 },
    { label: '低声部音符 / dev' + (state.swapped ? 1 : 2), top: 92 },
    { label: '原始击打（dev1 橙 / dev2 绿）', top: 138 },
    { label: '校准击打（半透明）', top: 184 }
  ];
  for (const lane of lanes) {
    const el = document.createElement('div');
    el.className = 'lane';
    el.style.top = lane.top + 'px';
    el.innerHTML = `<span class="lane-label">${lane.label}</span>`;
    tl.appendChild(el);
  }
  // Bar ticks.
  for (let i = 0; i <= 40; i++) {
    const t = i * 0.6;
    const tick = document.createElement('div');
    tick.className = 'tick ' + (i % 4 === 0 ? 'barline' : '');
    tick.style.left = pct(t) + '%';
    if (i % 4 === 0) tick.innerHTML = `<span class="tick-label">M${i / 4 + 1}</span>`;
    tl.appendChild(tick);
  }
  // Guide beats.
  for (const g of state.bundle.score.guideBeats) {
    const m = document.createElement('div');
    m.className = 'guide-mark ' + g.kind;
    m.style.left = pct(g.t) + '%';
    m.style.top = '23px';
    m.title = `${g.id} ${g.kind} @${g.t}s`;
    tl.appendChild(m);
  }
  // Notes.
  for (const n of state.bundle.score.notes) {
    const m = document.createElement('div');
    const cls = n.unison ? 'unison' : `v${n.voice}`;
    m.className = `note-dot ${cls}`;
    m.style.left = pct(n.t) + '%';
    m.style.top = n.unison || n.voice === 1 ? '69px' : '115px';
    m.title = `${n.id} ${n.pitch.label} M${n.bar}拍${n.beat}${n.unison ? ' 齐奏' : ''}`;
    tl.appendChild(m);
  }
  // Hits: raw estimate and calibrated estimate.
  const { calib } = recompute();
  for (const h of state.bundle.hits) {
    const origin = state.bundle.devices[h.deviceId].origin;
    const rawT = naiveMediaTime({ id: h.deviceId }, h.deviceTime, origin);
    const calT = calib[h.deviceId].map(h.deviceTime);
    const raw = document.createElement('div');
    raw.className = `hit-mark ${h.deviceId}`;
    raw.style.left = pct(rawT) + '%';
    raw.style.top = '146px';
    raw.title = `${h.hitId} 原始估计 ${rawT.toFixed(3)}s`;
    tl.appendChild(raw);
    const cal = document.createElement('div');
    cal.className = `hit-mark ${h.deviceId} cal`;
    cal.style.left = pct(calT) + '%';
    cal.title = `${h.hitId} 校准估计 ${calT.toFixed(3)}s`;
    tl.appendChild(cal);
  }
  // Draggable markers (dev2 markers are the ones that visibly move the fit).
  for (const id of ['dev1', 'dev2']) {
    state.markers[id].forEach((mk, idx) => {
      const el = document.createElement('div');
      el.className = 'marker ' + (idx === 0 ? 'm1' : 'm2');
      el.style.left = pct(mk.mediaTime) + '%';
      el.innerHTML = `<span class="marker-flag">${id}-M${idx + 1}</span>`;
      enableDrag(el, id, idx);
      tl.appendChild(el);
    });
  }
  const head = document.createElement('div');
  head.className = 'playhead';
  head.id = 'playhead';
  head.style.left = '0%';
  tl.appendChild(head);
}

function enableDrag(el, deviceId, idx) {
  const move = (e) => {
    const rect = $('timeline').getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const media = +(x / rect.width * DURATION).toFixed(4);
    state.markers[deviceId][idx].mediaTime = media;
    // The device reading at the marker stays fixed (that is what the device
    // stamped); moving the marker changes only the assumed media position.
    renderTimeline();
    renderMarkerEditors();
    if (state.answerOpen) renderAnswer();
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function renderMarkerEditors() {
  const box = $('marker-editors');
  box.innerHTML = '';
  for (const id of ['dev1', 'dev2']) {
    const dev = state.bundle.devices[id];
    const col = document.createElement('div');
    col.className = 'panel';
    col.style.background = 'var(--panel2)';
    const fit = calibrateToMedia(state.markers[id], dev.origin);
    col.innerHTML = `
      <h2 class="small">${dev.label} <span class="muted">(${id})</span></h2>
      <div class="grid2">
        ${state.markers[id].map((m, i) => `
          <label class="field">标记 M${i + 1} 媒体时刻 (s)
            <input type="number" step="0.01" min="0" max="${DURATION}"
              data-dev="${id}" data-idx="${i}" value="${m.mediaTime}">
          </label>`).join('')}
      </div>
      <div class="small mono muted" style="margin-top:8px">
        拟合 offset=${(fit.offset * 1000).toFixed(2)}ms ·
        rate=${(fit.rate * 100).toFixed(4)}% ·
        真实模型 offset=${dev.offset * 1000}ms / rate=${(dev.rate * 100).toFixed(3)}%
      </div>`;
    box.appendChild(col);
  }
  box.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const v = Math.max(0, Math.min(DURATION, Number(inp.value) || 0));
      state.markers[inp.dataset.dev][Number(inp.dataset.idx)].mediaTime = v;
      renderTimeline();
      if (state.answerOpen) renderAnswer();
    });
  });
}

// --- Answer tables ---------------------------------------------------------
function renderAnswer() {
  const { comparison, calib, raw, calibrated } = recompute();
  $('summary-raw').innerHTML = summaryHtml(gradeSummary(raw));
  $('summary-cal').innerHTML = summaryHtml(gradeSummary(calibrated));

  const judgedRaw = new Map(raw.map((j) => [j.hitId, j]));
  const judgedCal = new Map(calibrated.map((j) => [j.hitId, j]));
  const tbody = $('note-rows');
  tbody.innerHTML = '';
  for (const row of comparison.rows) {
    const tr = document.createElement('tr');
    if (row.changed) tr.className = 'changed';
    const edgeHit = calibrated.find((j) => j.noteId === row.noteId && j.boundary?.onEdge);
    const edge = edgeHit ? `含:${edgeHit.boundary.inclusive} / 严:${edgeHit.boundary.exclusive}` : '';
    const calHit = calibrated.find((j) => j.hitId === row.calibratedHitId);
    tr.innerHTML = `
      <td class="mono">${row.noteId}</td>
      <td>M${row.bar} 拍${row.beat}</td>
      <td>${row.unison ? '齐奏' : 'v' + row.voice}</td>
      <td>${row.unison ? '<span class="tag unison">unison</span>' : ''}</td>
      <td><span class="tag ${row.rawGrade}">${row.rawGrade}</span></td>
      <td>${row.rawAttribution ? `<span class="tag ${row.rawAttribution}">${row.rawAttribution}</span>` : '—'}</td>
      <td><span class="tag ${row.calibratedGrade}">${row.calibratedGrade}</span></td>
      <td>${row.calibratedAttribution ? `<span class="tag ${row.calibratedAttribution}">${row.calibratedAttribution}</span>` : '—'}</td>
      <td class="mono">${calHit ? (calHit.decomposition.deviceError * 1000).toFixed(1) + 'ms' : '—'}</td>
      <td class="mono">${calHit ? (calHit.decomposition.humanError * 1000).toFixed(1) + 'ms' : '—'}</td>
      <td class="small">${edge}</td>`;
    tbody.appendChild(tr);
  }
  renderBoundary();
}

function summaryHtml(summary) {
  return Object.entries(summary).map(([id, s]) => `
    <span class="summary-pill"><span class="dot ${id}"></span>${id}
      <span class="tag perfect">P${s.perfect}</span>
      <span class="tag good">G${s.good}</span>
      <span class="tag miss">M${s.miss}${s.stray ? '/S' + s.stray : ''}</span>
    </span>`).join('');
}

function renderBoundary() {
  if (!state.bundle) return;
  const { boundary } = recompute();
  const box = $('boundary-box');
  if (!boundary.length) { box.textContent = '当前标记下没有落在判定窗边缘的击打。'; return; }
  box.innerHTML = boundary.map((b) => `
    <div style="margin-bottom:6px">
      <span class="mono">${b.hitId}</span>（${b.deviceId} → ${b.targetKind} ${b.targetId}）
      偏差 <b class="mono">${(b.deviation * 1000).toFixed(1)}ms</b>：
      含边界约定 = <span class="tag ${b.inclusiveGrade}">${b.inclusiveGrade}</span>，
      严格约定 = <span class="tag ${b.exclusiveGrade}">${b.exclusiveGrade}</span>。
      演奏本身正确，差异只来自 45ms 边缘的约定与采样量化。
    </div>`).join('');
}

function renderCounterexamples() {
  const { comparison, boundary } = recompute();
  // Reuse the same catalog logic the build report uses, generated client-side.
  const cases = buildClientCases(comparison, boundary);
  const wrap = $('ce-cards');
  wrap.innerHTML = '';
  for (const c of cases) {
    const card = document.createElement('div');
    card.className = 'ce-card';
    const firstNote = state.bundle.score.notes.find((n) => n.id === c.noteIds[0]);
    card.innerHTML = `
      <div><span class="ce-id">${c.id}</span> · <span class="small muted">${c.measure}</span></div>
      <strong>${c.title}</strong>
      <div class="small muted">${c.detail}</div>
      <div class="small mono">${c.audible}</div>`;
    card.addEventListener('click', () => {
      if (firstNote) previewAt(firstNote.t);
    });
    wrap.appendChild(card);
  }
}

function buildClientCases(comparison, boundary) {
  const raw = comparison.raw;
  const flips = raw.filter((j) => j.attribution === 'handoff-flip');
  const guides = raw.filter((j) => j.attribution === 'guide-capture');
  return [
    { id: 'CE1', measure: 'M1', title: '开头同分', detail: '两台设备齐奏音等级一致，校准后均 perfect。',
      noteIds: comparison.rows.filter((r) => r.bar === 1).map((r) => r.noteId),
      audible: '两轨几乎重合，只有约 40ms 拍边。' },
    { id: 'CE3', measure: 'M4-M6', title: '交接音归属翻转',
      detail: `${flips.length} 个 dev2 击打在原始判定下被记到 dev1 音符。`,
      noteIds: [...new Set(flips.map((j) => j.noteId))], audible: '左右声像接龙抢拍/漏拍。' },
    { id: 'CE4', measure: 'M6/M9', title: '伴奏拍被认领',
      detail: `${guides.length} 个击打越过输入音，最近目标变成木鱼/底鼓。`,
      noteIds: [...new Set(guides.map((j) => j.noteId))], audible: '低音 blip 贴着伴奏点击。' },
    { id: 'CE5', measure: 'M10', title: '尾部分离',
      detail: '末尾交接音原始 miss、校准 perfect。',
      noteIds: comparison.rows.filter((r) => r.bar === 10).map((r) => r.noteId),
      audible: '最后一个低音明显晚于重音。' },
    { id: 'CE6', measure: 'M9', title: '边缘合击的边界差异',
      detail: boundary.map((b) => `${b.hitId}: ${b.inclusiveGrade}/${b.exclusiveGrade}`).join('；'),
      noteIds: [...new Set(boundary.map((b) => b.targetId))], audible: '两侧同时发声但判定对 45ms 敏感。' },
    { id: 'CE7', measure: 'M8', title: '同声部连续重音',
      detail: '整小节只有高声部四个重音，设备延迟贡献可逐音核对。',
      noteIds: comparison.rows.filter((r) => r.bar === 8).map((r) => r.noteId),
      audible: 'raw 轨整齐晚半拍。' }
  ];
}

// --- WebAudio live replay --------------------------------------------------
function ensureAudio() {
  if (!state.audio) state.audio = new AudioContext();
  return state.audio;
}

function blip(ctx, t, freq, { pan = 0, gain = 0.3, dur = 0.2 } = {}) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const p = ctx.createStereoPanner();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  p.pan.value = pan;
  osc.connect(g).connect(p).connect(ctx.destination);
  osc.start(t); osc.stop(t + dur + 0.02);
  state.activeNodes.push(osc);
}

function wood(ctx, t, freq = 1800) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'square'; osc.frequency.value = freq;
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  osc.connect(g).connect(ctx.destination);
  osc.start(t); osc.stop(t + 0.09);
  state.activeNodes.push(osc);
}

function stopPlay() {
  for (const n of state.activeNodes) { try { n.stop(); } catch { /* already stopped */ } }
  state.activeNodes = [];
  clearInterval(state.playTimer);
  const head = $('playhead');
  if (head) head.style.left = '0%';
}

// mode: which layers to schedule. Replay is synthesized live from the current
// marker fit, so "重新演奏" always reflects edits rather than cached WAVs.
function replay(modes) {
  stopPlay();
  const ctx = ensureAudio();
  ctx.resume();
  const t0 = ctx.currentTime + 0.15;
  const { calib } = recompute();
  const noteById = new Map(state.bundle.score.notes.map((n) => [n.id, n]));

  if (modes.includes('acc')) {
    for (const g of state.bundle.score.guideBeats) {
      if (g.kind === 'kick') wood(ctx, t0 + g.t, 120);
      else wood(ctx, t0 + g.t, 1900);
    }
  }
  for (const h of state.bundle.hits) {
    const note = noteById.get(h.noteId);
    const pan = h.deviceId === 'dev1' ? -0.55 : 0.55;
    const soloWanted =
      (h.deviceId === 'dev1' && (modes.includes('d1raw') || modes.includes('d1cal'))) ||
      (h.deviceId === 'dev2' && (modes.includes('d2raw') || modes.includes('d2cal')));
    if (modes.includes('mixcal')) {
      blip(ctx, t0 + calib[h.deviceId].map(h.deviceTime), note.pitch.freq,
        { pan, gain: note.accent ? 0.34 : 0.24 });
    } else if (modes.includes('mixraw')) {
      blip(ctx, t0 + (h.deviceTime - state.bundle.devices[h.deviceId].origin),
        note.pitch.freq, { pan, gain: note.accent ? 0.34 : 0.24 });
    } else if (soloWanted) {
      const useRaw = h.deviceId === 'dev1' ? modes.includes('d1raw') : modes.includes('d2raw');
      const at = useRaw
        ? h.deviceTime - state.bundle.devices[h.deviceId].origin
        : calib[h.deviceId].map(h.deviceTime);
      blip(ctx, t0 + at, note.pitch.freq, { pan, gain: 0.3 });
    }
  }
  const start = performance.now();
  state.playTimer = setInterval(() => {
    const elapsed = (performance.now() - start) / 1000 - 0.15;
    const head = $('playhead');
    if (head) head.style.left = pct(Math.max(0, elapsed)) + '%';
    if (elapsed > DURATION) { clearInterval(state.playTimer); if (head) head.style.left = '0%'; }
  }, 50);
}

function previewAt(t) {
  stopPlay();
  const ctx = ensureAudio();
  ctx.resume();
  const t0 = ctx.currentTime + 0.1;
  wood(ctx, t0, 120);
  const nearby = state.bundle.hits.filter((h) => Math.abs(h.trueMediaTime - t) < 0.5);
  const { calib } = recompute();
  for (const h of nearby) {
    const note = state.bundle.score.notes.find((n) => n.id === h.noteId);
    blip(ctx, t0 + Math.max(0, calib[h.deviceId].map(h.deviceTime) - t), note.pitch.freq,
      { pan: h.deviceId === 'dev1' ? -0.55 : 0.55 });
  }
  const head = $('playhead');
  if (head) head.style.left = pct(t) + '%';
}

// --- Wire up controls ------------------------------------------------------
const MODE_BUTTONS = {
  'play-acc': ['acc'],
  'play-d1raw': ['d1raw'], 'play-d1cal': ['d1cal'],
  'play-d2raw': ['d2raw'], 'play-d2cal': ['d2cal'],
  'play-mixraw': ['acc', 'mixraw'], 'play-mixcal': ['acc', 'mixcal']
};
for (const [id, modes] of Object.entries(MODE_BUTTONS)) {
  $(id).addEventListener('click', () => {
    document.querySelectorAll('.toggle').forEach((b) => b.classList.remove('on'));
    $(id).classList.add('on');
    replay(modes);
  });
}
$('stop').addEventListener('click', stopPlay);

$('swap').addEventListener('click', () => {
  state.swapped = !state.swapped;
  state.deviceVoice = state.swapped ? { dev1: 2, dev2: 1 } : { dev1: 1, dev2: 2 };
  $('swap-state').textContent = state.swapped
    ? '当前：dev1→低声部，dev2→高声部（已对调）'
    : '当前：dev1→高声部，dev2→低声部';
  renderTimeline();
  if (state.answerOpen) renderAnswer();
});

$('reset-markers').addEventListener('click', () => {
  for (const id of ['dev1', 'dev2']) {
    state.markers[id] = state.bundle.defaultMarkers[id].map((m) => ({ ...m }));
  }
  renderTimeline(); renderMarkerEditors();
  if (state.answerOpen) renderAnswer();
});

$('toggle-answer').addEventListener('click', () => {
  state.answerOpen = !state.answerOpen;
  $('answer').classList.toggle('hidden', !state.answerOpen);
  $('toggle-answer').classList.toggle('on', state.answerOpen);
  $('toggle-answer').textContent = state.answerOpen ? '收起关卡答案' : '点开关卡答案';
  $('view-badge').textContent = '视图：原始 vs 当前校准';
  if (state.answerOpen) renderAnswer();
});

load().catch((err) => {
  document.querySelector('.wrap').innerHTML =
    `<div class="panel">素材加载失败：${err.message}<br>请先运行 <code>npm run build:rehearsal</code> 生成数据。</div>`;
});
