// Dependency-free WAV rendering for Node. The browser rehearsal page uses the
// same synthesis parameters via its own WebAudio voices; these files are the
// canonical rendered material and the source of the audible counterexamples.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SAMPLE_RATE } from './devices.js';
import { NOTES, GUIDE_BEATS, SCORE } from './score.js';

const TAU = Math.PI * 2;

// --- Voices ----------------------------------------------------------------
function blip(buf, at, freq, { gain = 0.5, pan = 0, dur = 0.22, sr = SAMPLE_RATE } = {}) {
  const start = Math.max(0, Math.round(at * sr));
  const n = Math.round(dur * sr);
  const gl = Math.cos((pan + 1) * Math.PI / 4);
  const gr = Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 14) * Math.min(1, t * 400);
    const s = Math.sin(TAU * freq * t) * 0.8 + Math.sin(TAU * freq * 2 * t) * 0.2;
    const idx = start + i;
    if (idx >= buf.length / 2) break;
    buf[idx * 2] += s * env * gain * gl;
    buf[idx * 2 + 1] += s * env * gain * gr;
  }
}

function woodblock(buf, at, { sr = SAMPLE_RATE } = {}) {
  const start = Math.max(0, Math.round(at * sr));
  const n = Math.round(0.09 * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 45);
    const s = Math.sign(Math.sin(TAU * 1800 * t)) * 0.5 + Math.sin(TAU * 2600 * t) * 0.3;
    const idx = start + i;
    if (idx >= buf.length / 2) break;
    buf[idx * 2] += s * env * 0.28;
    buf[idx * 2 + 1] += s * env * 0.28;
  }
}

function kick(buf, at, { sr = SAMPLE_RATE } = {}) {
  const start = Math.max(0, Math.round(at * sr));
  const n = Math.round(0.25 * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 16);
    const f = 120 * Math.exp(-t * 25) + 45;
    const s = Math.sin(TAU * f * t);
    const idx = start + i;
    if (idx >= buf.length / 2) break;
    buf[idx * 2] += s * env * 0.6;
    buf[idx * 2 + 1] += s * env * 0.6;
  }
}

function alloc(seconds, sr = SAMPLE_RATE) {
  return new Float32Array(Math.ceil(seconds * sr) * 2);
}

function normalize(buf, peak = 0.9) {
  let m = 0;
  for (const v of buf) m = Math.max(m, Math.abs(v));
  if (m > peak) {
    const k = peak / m;
    for (let i = 0; i < buf.length; i++) buf[i] *= k;
  }
}

function encodeWav(buf, sr = SAMPLE_RATE) {
  const frames = buf.length / 2;
  const dataBytes = frames * 2 * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);          // PCM
  out.writeUInt16LE(2, 22);          // stereo
  out.writeUInt32LE(sr, 24);
  out.writeUInt32LE(sr * 4, 28);     // byte rate
  out.writeUInt16LE(4, 32);          // block align
  out.writeUInt16LE(16, 34);         // bits per sample
  out.write('data', 36);
  out.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.max(-1, Math.min(1, buf[i]));
    out.writeInt16LE(Math.round(v * 32767), o);
    o += 2;
  }
  return out;
}

const TAIL = 0.6;

// Accompaniment track: kicks on barlines, woodblocks on every other beat.
export function renderAccompaniment() {
  const buf = alloc(SCORE.duration + TAIL);
  for (const g of GUIDE_BEATS) {
    if (g.kind === 'kick') kick(buf, g.t);
    else woodblock(buf, g.t);
  }
  normalize(buf);
  return encodeWav(buf);
}

// One device's input track from a render timeline (raw or calibrated).
export function renderInput(timeline, deviceId) {
  const buf = alloc(SCORE.duration + TAIL);
  const pan = deviceId === 'dev1' ? -0.55 : 0.55;
  for (const item of timeline) {
    const note = NOTES.find((n) => n.id === item.noteId);
    blip(buf, item.at, note.pitch.freq, {
      pan, gain: note.accent ? 0.6 : 0.42, dur: note.accent ? 0.26 : 0.2
    });
  }
  normalize(buf);
  return encodeWav(buf);
}

// Full mix: accompaniment plus both input timelines.
export function renderMix(timelineByDevice) {
  const buf = alloc(SCORE.duration + TAIL);
  for (const g of GUIDE_BEATS) {
    if (g.kind === 'kick') kick(buf, g.t, {});
    else woodblock(buf, g.t);
  }
  for (const deviceId of ['dev1', 'dev2']) {
    const pan = deviceId === 'dev1' ? -0.55 : 0.55;
    for (const item of timelineByDevice[deviceId]) {
      const note = NOTES.find((n) => n.id === item.noteId);
      blip(buf, item.at, note.pitch.freq, {
        pan, gain: note.accent ? 0.5 : 0.34, dur: note.accent ? 0.26 : 0.2
      });
    }
  }
  normalize(buf);
  return encodeWav(buf);
}

export async function writeWav(dir, name, bytes) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), bytes);
}
