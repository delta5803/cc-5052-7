// One-command rebuild of every rehearsal material. All timing is derived from
// the parameter modules; rerunning regenerates byte-identical data because the
// performance RNG is seeded. Assertions here guard the musical guarantees the
// brief asks for, so a broken scenario fails the build.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCORE, NOTES, GUIDE_BEATS } from '../lib/rehearsal/score.js';
import {
  DEVICES, DEVICE_ORIGIN, defaultMarkers, trueCalibration
} from '../lib/rehearsal/devices.js';
import { buildPerformance, audioTimeline, PERF_CONFIG } from '../lib/rehearsal/performance.js';
import {
  judgeHits, compareCalibration, rollupNotes, boundaryDifferences, gradeSummary
} from '../lib/rehearsal/judgment.js';
import { buildCounterexamples } from '../lib/rehearsal/counterexamples.js';
import { buildMusicXml } from '../lib/rehearsal/musicxml.js';
import {
  renderAccompaniment, renderInput, renderMix, writeWav
} from '../lib/rehearsal/audio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'public', 'rehearsal', 'data');
const AUDIO_DIR = path.join(ROOT, 'public', 'rehearsal', 'audio');

function assert(cond, msg) {
  if (!cond) throw new Error(`build assertion failed: ${msg}`);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(AUDIO_DIR, { recursive: true });

  const hits = buildPerformance();
  const calib = {
    dev1: trueCalibration(DEVICES.dev1),
    dev2: trueCalibration(DEVICES.dev2)
  };

  // --- Raw material bundle: observations and parameters only, no grades ---
  const bundle = {
    schema: 'rehearsal-bundle/v1',
    generatedFrom: {
      seed: PERF_CONFIG.seed,
      sampleRate: DEVICES.dev1.sampleRate,
      scoreId: SCORE.id
    },
    score: {
      ...SCORE,
      notes: NOTES,
      guideBeats: GUIDE_BEATS
    },
    devices: Object.fromEntries(Object.values(DEVICES).map((d) => [d.id, {
      id: d.id, label: d.label, offset: d.offset, rate: d.rate,
      sampleRate: d.sampleRate, origin: DEVICE_ORIGIN[d.id]
    }])),
    defaultMarkers: Object.fromEntries(Object.keys(DEVICES).map((id) => [
      id, defaultMarkers(DEVICES[id], DEVICE_ORIGIN[id]).map((m) => ({ ...m }))
    ])),
    // Hit records keep device time, media sample and true time in separate
    // fields; nothing here is a judgment.
    hits: hits.map((h) => ({ ...h }))
  };
  await writeFile(path.join(DATA_DIR, 'bundle.json'), JSON.stringify(bundle, null, 2));

  // --- Audio material ------------------------------------------------------
  const rawTimeline = {
    dev1: audioTimeline(hits.filter((h) => h.deviceId === 'dev1'), 'raw', calib),
    dev2: audioTimeline(hits.filter((h) => h.deviceId === 'dev2'), 'raw', calib)
  };
  const fixedTimeline = {
    dev1: audioTimeline(hits.filter((h) => h.deviceId === 'dev1'), 'calibrated', calib),
    dev2: audioTimeline(hits.filter((h) => h.deviceId === 'dev2'), 'calibrated', calib)
  };

  await writeWav(AUDIO_DIR, 'accompaniment.wav', renderAccompaniment());
  for (const id of ['dev1', 'dev2']) {
    await writeWav(AUDIO_DIR, `${id}-raw.wav`, renderInput(rawTimeline[id], id));
    await writeWav(AUDIO_DIR, `${id}-calibrated.wav`, renderInput(fixedTimeline[id], id));
  }
  await writeWav(AUDIO_DIR, 'mix-raw.wav', renderMix(rawTimeline));
  await writeWav(AUDIO_DIR, 'mix-calibrated.wav', renderMix(fixedTimeline));

  // --- Derived report (grades are always derivable; stored for audit) ------
  const comparison = compareCalibration(hits, calib);
  const boundary = boundaryDifferences(comparison.calibrated);
  const counterexamples = buildCounterexamples(comparison, boundary);
  const report = {
    summary: {
      raw: gradeSummary(comparison.raw),
      calibrated: gradeSummary(comparison.calibrated)
    },
    calibration: Object.fromEntries(Object.keys(calib).map((id) => [id, {
      offset: calib[id].offset, rate: calib[id].rate
    }])),
    noteChanges: comparison.rows,
    guideCapturesRaw: comparison.rawRoll.guideRows,
    boundaryDifferences: boundary,
    counterexamples
  };
  await writeFile(path.join(DATA_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(DATA_DIR, 'score.musicxml'), buildMusicXml());

  // --- Assertions: the guarantees the brief requires -----------------------
  // 1. Opening unison: both devices receive the same grade in each view.
  //    The stable 40ms latency can hold them at good rather than perfect,
  //    but the two devices must never diverge at the phrase start.
  const open = comparison.rows.filter((r) => r.bar === 1 && r.unison);
  assert(open.every((r) => r.rawGrade === open[0].rawGrade &&
    r.calibratedGrade === open[0].calibratedGrade),
    'opening unison scores identically across both devices');
  assert(open.every((r) => r.calibratedGrade === 'perfect'),
    'calibration restores the opening unison to perfect');

  // 2. Tail separation: the M10 note is a raw miss but recovered after calib.
  const tail = comparison.rows.find((r) => r.bar === 10);
  assert(tail.rawGrade === 'miss' && tail.calibratedGrade !== 'miss',
    'tail handoff separates raw but is recovered by calibration');

  // 3. Handoff flips exist in raw and vanish after calibration.
  const rawFlips = comparison.raw.filter((j) => j.attribution === 'handoff-flip');
  const fixedFlips = comparison.calibrated.filter((j) => j.attribution === 'handoff-flip');
  assert(rawFlips.length >= 4, 'drift produces handoff attribution flips');
  assert(fixedFlips.length === 0, 'calibration removes every handoff flip');

  // 4. Guide-beat capture in raw, none after calibration.
  const rawGuide = comparison.raw.filter((j) => j.attribution === 'guide-capture');
  const fixedGuide = comparison.calibrated.filter((j) => j.attribution === 'guide-capture');
  assert(rawGuide.length >= 2, 'late hits claim accompaniment guide beats');
  assert(fixedGuide.length === 0, 'calibration restores guide-captured hits to input notes');

  // 5. Edge unison: the 45 ms strike grades differently across conventions.
  const edge = boundary.find((b) => b.deviceId === 'dev1');
  assert(edge && edge.inclusiveGrade === 'perfect' && edge.exclusiveGrade === 'good',
    'edge unison hit records both convention grades');

  // 6. M8 is a same-voice accent-only measure.
  const m8 = NOTES.filter((n) => n.bar === 8);
  assert(m8.length === 4 && m8.every((n) => n.voice === 1 && n.accent),
    'M8 contains only voice-1 continuous accents');

  // 7. Recovered residuals are human-scale: no calibrated miss on played notes.
  const playedMisses = comparison.calibrated
    .filter((j) => j.target?.kind === 'note' && j.grade === 'miss');
  assert(playedMisses.length === 0, 'calibrated performance has no missed input notes');

  // 8. Every grade change row names a concrete note and hit.
  assert(comparison.rows.every((r) => r.noteId && r.t >= 0),
    'all change rows trace back to a score note');

  console.log('rehearsal material rebuilt:');
  console.log(`  notes=${NOTES.length} hits=${hits.length} ` +
    `flips=${rawFlips.length} guideCaptures=${rawGuide.length} edgeCases=${boundary.length}`);
  console.log(`  raw summary=${JSON.stringify(report.summary.raw)}`);
  console.log(`  calibrated summary=${JSON.stringify(report.summary.calibrated)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
