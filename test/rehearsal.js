// Deterministic logic tests for the rehearsal subsystem. Everything runs on
// the seeded reconstructed performance; no audio or browser APIs are needed.
import { NOTES, GUIDE_BEATS, SCORE } from '../lib/rehearsal/score.js';
import {
  DEVICES, DEVICE_ORIGIN, trueCalibration, calibrateToMedia,
  defaultMarkers, fitCalibration, sampleAt, SAMPLE_RATE
} from '../lib/rehearsal/devices.js';
import { buildPerformance, mulberry32, PERF_CONFIG } from '../lib/rehearsal/performance.js';
import {
  judgeHits, compareCalibration, nearestTarget, gradeDeviation,
  boundaryDifferences, rollupNotes
} from '../lib/rehearsal/judgment.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.log(`  FAIL ${msg}`); }
  else console.log(`  ok   ${msg}`);
}

const hits = buildPerformance();
const calib = {
  dev1: trueCalibration(DEVICES.dev1),
  dev2: trueCalibration(DEVICES.dev2)
};

// 1. Determinism: the same seed rebuilds identical hits and sample frames.
const again = buildPerformance();
assert(JSON.stringify(again) === JSON.stringify(hits), 'seeded performance rebuilds identically');
assert(hits.every((h) => Number.isInteger(h.mediaSample)), 'media samples are integer frames');
assert(hits.every((h) => h.grade === undefined), 'hit records never store a judgment');

// 2. Three time layers are distinct fields with the expected relationship.
const h0 = hits[0];
const dev = DEVICES[h0.deviceId];
assert(typeof h0.deviceTime === 'number' && typeof h0.mediaSample === 'number' &&
  typeof h0.trueMediaTime === 'number', 'device time / media sample / true time kept separate');
assert(Math.abs(h0.mediaSample / SAMPLE_RATE - h0.deviceTime) < 1 / SAMPLE_RATE,
  'media sample corresponds to the device clock reading');

// 3. Stable device: fixed 40ms latency, zero drift; calibration recovers it.
assert(Math.abs(calib.dev1.offset - 0.04) < 1e-9, 'dev1 calibration recovers 40ms offset');
assert(Math.abs(calib.dev1.rate) < 1e-12, 'dev1 calibration rate is zero');
const dev1Raw = judgeHits(hits, { mode: 'raw' }).filter((j) => j.deviceId === 'dev1');
assert(dev1Raw.every((j) => Math.abs(j.decomposition.deviceError - 0.04) < 1e-6 ||
  j.target === null), 'raw dev1 device error is the constant 40ms latency');

// 4. Drifting device: two-point calibration recovers offset and slow rate.
assert(Math.abs(calib.dev2.offset - 0.02) < 1e-9, 'dev2 calibration recovers 20ms base offset');
assert(Math.abs(calib.dev2.rate - 0.0085) < 1e-9, 'dev2 calibration recovers 0.85% drift');

// 5. Opening unison: identical grades across devices at the phrase start.
const cmp = compareCalibration(hits, calib);
const opening = cmp.rows.filter((r) => r.bar === 1);
assert(opening.every((r) => r.calibratedGrade === 'perfect'),
  'calibrated opening unison is perfect on every note');
assert(opening.every((r) => r.rawGrade === opening[0].rawGrade),
  'raw opening unison grades match across the two devices');

// 6. Drift handoff flips exist raw and disappear after calibration.
const rawFlips = cmp.raw.filter((j) => j.attribution === 'handoff-flip');
const calFlips = cmp.calibrated.filter((j) => j.attribution === 'handoff-flip');
assert(rawFlips.length >= 4, `handoff flips present in raw (${rawFlips.length})`);
assert(calFlips.length === 0, 'calibration eliminates every handoff flip');

// 7. Guide-beat ownership: raw guide captures vanish after calibration.
const rawGuides = cmp.raw.filter((j) => j.attribution === 'guide-capture');
const calGuides = cmp.calibrated.filter((j) => j.attribution === 'guide-capture');
assert(rawGuides.length >= 2, `guide-beat captures present in raw (${rawGuides.length})`);
assert(calGuides.length === 0, 'calibration returns guide captures to input notes');
assert(rawGuides.every((j) => j.target.kind === 'guide' &&
  GUIDE_BEATS.some((g) => g.id === j.target.id)), 'guide captures reference real guide beats');

// 8. Tail handoff separates at the end despite the shared opening.
const tail = cmp.rows.find((r) => r.bar === 10);
assert(tail.rawGrade === 'miss' && tail.calibratedGrade === 'perfect',
  'M10 tail note: raw miss, calibrated perfect');

// 9. Edge unison hit records both convention grades for a correct performance.
const boundary = boundaryDifferences(cmp.calibrated);
const edge = boundary.find((b) => b.deviceId === 'dev1');
assert(edge && edge.deviation === 0.045, 'edge unison sits at exactly 45ms');
assert(edge.inclusiveGrade === 'perfect' && edge.exclusiveGrade === 'good',
  'inclusive vs exclusive conventions disagree on the edge');

// 10. Same-voice continuous accent measure exists and is voice 1 only.
const accentBar = NOTES.filter((n) => n.bar === 8);
assert(accentBar.length === 4 && accentBar.every((n) => n.voice === 1 && n.accent),
  'M8 is a voice-1-only continuous accent measure');

// 11. Calibrated residuals equal human jitter (device error removed).
const calJudged = judgeHits(hits, { mode: 'calibrated', calib });
assert(calJudged.every((j) => Math.abs(j.decomposition.deviceError) < 2e-4),
  'calibration removes device error down to frame quantization');
const withJitter = hits.find((h) => Math.abs(h.performanceJitter) > 0.005);
const jJudge = calJudged.find((j) => j.hitId === withJitter.hitId);
assert(Math.abs(jJudge.decomposition.humanError - withJitter.performanceJitter) < 1e-9,
  'human jitter survives calibration unchanged and is traceable');

// 12. Moving a sync marker changes grades; resetting restores them.
const moved = defaultMarkers(DEVICES.dev2, DEVICE_ORIGIN.dev2).map((m) => ({ ...m }));
moved[1].mediaTime = moved[1].mediaTime - 1.0; // pretend the end marker is off
const badCalib = { ...calib, dev2: calibrateToMedia(moved, DEVICE_ORIGIN.dev2) };
const badJudged = judgeHits(hits, { mode: 'calibrated', calib: badCalib });
const goodDev2 = cmp.calibrated.filter((j) => j.deviceId === 'dev2');
const badDev2 = badJudged.filter((j) => j.deviceId === 'dev2');
assert(JSON.stringify(goodDev2.map((j) => j.grade)) !==
  JSON.stringify(badDev2.map((j) => j.grade)), 'moving a marker recomputes grades');
const restored = judgeHits(hits, { mode: 'calibrated', calib });
assert(JSON.stringify(restored.map((j) => j.grade)) ===
  JSON.stringify(cmp.calibrated.map((j) => j.grade)), 'reset markers restore original grades');

// 13. Musician swap changes the voice label on every judged hit, not the times.
const swapped = judgeHits(hits, {
  mode: 'calibrated', calib, deviceVoice: { dev1: 2, dev2: 1 }
});
assert(swapped.find((j) => j.hitId === hits[0].hitId).voice ===
  (hits[0].deviceId === 'dev1' ? 2 : 1), 'swap relabels device-to-voice mapping');
assert(swapped.every((j, i) => j.mediaEstimate === cmp.calibrated[i].mediaEstimate),
  'swap never changes timing estimates, only ownership labels');

// 14. Nearest-target priority: a note and guide at equal distance pick the note.
const target = nearestTarget(NOTES[0].t);
assert(target.kind === 'note', 'input note outranks a guide beat at the same instant');

// 15. Grade windows behave at the boundary and beyond.
assert(gradeDeviation(0.045) === 'perfect', '45ms inclusive is perfect');
assert(gradeDeviation(0.0451) === 'good', 'just beyond 45ms is good');
assert(gradeDeviation(0.09) === 'good', '90ms inclusive is good');
assert(gradeDeviation(0.091) === 'miss', 'beyond 90ms is miss');

// 16. Rollup: every played score note is claimed after calibration.
const roll = rollupNotes(cmp.calibrated);
const played = new Set(hits.map((h) => h.noteId));
const unclaimed = roll.noteRows.filter((r) => played.has(r.note.id) && !r.claimed);
assert(unclaimed.length === 0, 'every performed note has a calibrated claim');

// 17. RNG determinism of the documented seed.
const r1 = mulberry32(PERF_CONFIG.seed);
const r2 = mulberry32(PERF_CONFIG.seed);
assert(r1() === r2() && r1() === r2(), 'jitter RNG is reproducible from the seed');

console.log(`\n${failures === 0 ? 'all' : `${failures} failed in`} rehearsal tests`);
process.exit(failures === 0 ? 0 : 1);
