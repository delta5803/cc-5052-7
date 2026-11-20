// Reconstructed performance. Every strike is rebuilt from declared parameters
// and a seeded RNG, so the whole dataset is regenerated deterministically.
//
// Each hit record keeps three separate time layers and never stores a grade:
//   deviceTime   - the raw reading on the device's own clock
//   mediaSample  - integer frame the device's capture pipeline stamped
//   trueMediaTime - when the strike actually happened on the phrase timeline
// Calibrated/naive media estimates and judgments are always derived later.
import { NOTES } from './score.js';
import {
  DEVICES, DEVICE_ORIGIN, deviceReading, sampleAt, SAMPLE_RATE
} from './devices.js';

// Deterministic PRNG (mulberry32) so a seed fully determines every jitter.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller gaussian from two uniform draws, clamped to a band.
function gaussian(rand, sigma, clampAbs) {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-clampAbs, Math.min(clampAbs, z * sigma));
}

export const PERF_CONFIG = Object.freeze({
  seed: 20261120,
  jitterSigma: 0.011,      // typical human timing spread (~11 ms)
  jitterClamp: 0.02,       // no single strike deviates more than 20 ms
  tightClamp: 0.006,       // hocket tail: tighter so flips are unambiguous
  // Fixed performance deviations for the unison edge hit (M7 beat 1). Dev1
  // lands exactly on the perfect window edge (45 ms) so inclusive/exclusive
  // conventions disagree even though the performance is correct.
  edgeJitter: Object.freeze({ dev1: 0.045, dev2: -0.006 }),
  // The first two unison strikes are exact so both devices open identically.
  exactUnisonBeats: 2
});

// True media time of the physical strike for a note on a device.
function strikeTime(note, deviceId, rand) {
  const isEdge = note.t === 19.2 && note.unison;
  if (isEdge) return +(note.t + PERF_CONFIG.edgeJitter[deviceId]).toFixed(6);
  const inOpeningUnison = note.bar === 1 && note.unison && note.beat <= PERF_CONFIG.exactUnisonBeats;
  if (inOpeningUnison) return note.t;
  const inHocket = note.bar >= 4 && note.bar <= 6;
  const j = gaussian(rand, PERF_CONFIG.jitterSigma, inHocket ? PERF_CONFIG.tightClamp : PERF_CONFIG.jitterClamp);
  return +(note.t + j).toFixed(6);
}

export function buildPerformance() {
  const rand = mulberry32(PERF_CONFIG.seed);
  const hits = [];
  let hitSeq = 0;
  for (const note of NOTES) {
    // One strike per performing device. Unison notes carry both voices, so
    // both devices strike the same note identity.
    const performers = note.unison ? ['dev1', 'dev2'] : [`dev${note.voice}`];
    for (const deviceId of performers) {
      const device = DEVICES[deviceId];
      const origin = DEVICE_ORIGIN[deviceId];
      const trueMediaTime = strikeTime(note, deviceId, rand);
      const reading = deviceReading(device, trueMediaTime, origin);
      const frame = sampleAt(device, trueMediaTime, origin);
      hitSeq += 1;
      hits.push(Object.freeze({
        hitId: `h${String(hitSeq).padStart(3, '0')}`,
        noteId: note.id,
        deviceId,
        // Layer 1: device clock reading (seconds, device-local origin).
        deviceTime: +reading.toFixed(6),
        // Layer 2: capture pipeline media sample (integer frames).
        mediaSample: frame,
        sampleRate: SAMPLE_RATE,
        // Layer 3: ground-truth phrase time. Kept only for audit/rebuild; the
        // judge never reads this field — it works from calibrated estimates.
        trueMediaTime,
        // Human timing component, separate from device offset/drift, so the
        // report can attribute which deviation came from the performance.
        performanceJitter: +(trueMediaTime - note.t).toFixed(6)
      }));
    }
  }
  return Object.freeze(hits);
}

// Reconstruct a strike timeline for audio rendering. Mode "raw" places each
// blip where the uncalibrated pipeline hears it (origin subtraction only);
// mode "calibrated" places it at the true strike time.
export function audioTimeline(hits, mode, calibByDevice) {
  return hits.map((h) => {
    const renderAt = mode === 'raw'
      ? h.deviceTime - DEVICE_ORIGIN[h.deviceId]
      : calibByDevice[h.deviceId].map(h.deviceTime);
    return Object.freeze({
      hitId: h.hitId,
      deviceId: h.deviceId,
      noteId: h.noteId,
      at: +renderAt.toFixed(6)
    });
  });
}
