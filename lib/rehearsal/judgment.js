// Recomputable judging. Nothing here reads stored grades: given the raw hits,
// a calibration per device and the score, every attribution and grade is
// rebuilt. Moving a sync marker or swapping musicians therefore re-judges the
// exact same raw observations.
import { SCORE, NOTES, GUIDE_BEATS } from './score.js';
import { DEVICES, naiveMediaTime, DEVICE_ORIGIN } from './devices.js';

const { perfect: PERFECT, good: GOOD } = SCORE.windows;

export function gradeDeviation(dev) {
  const a = Math.abs(dev);
  if (a <= PERFECT) return 'perfect';
  if (a <= GOOD) return 'good';
  return 'miss';
}

// Two conventions for a hit sitting exactly on the window edge. Inclusive is
// the game default; exclusive is the stricter variant. A correct performance
// can therefore land on a boundary and differ between conventions.
export function boundaryGrade(dev) {
  const a = Math.abs(dev);
  return {
    inclusive: gradeDeviation(dev),
    exclusive: a < PERFECT ? 'perfect' : a < GOOD ? 'good' : 'miss',
    onEdge: Math.abs(a - PERFECT) < 1e-9 || Math.abs(a - GOOD) < 1e-9
  };
}

// Find the target a hit claims. Input notes outrank guide beats on a tie so a
// strike aimed at a note is never stolen by an accompaniment click at the same
// instant. Guide beats use a wider radius as the fallback attribution class;
// a hit within neither radius is a stray.
export function nearestTarget(mediaEstimate) {
  let best = null;
  for (const n of NOTES) {
    const d = Math.abs(n.t - mediaEstimate);
    if (d <= SCORE.noteMatchRadius && (!best || d < best.d)) {
      best = { kind: 'note', id: n.id, t: n.t, d };
    }
  }
  for (const g of GUIDE_BEATS) {
    const d = Math.abs(g.t - mediaEstimate);
    if (d <= SCORE.guideMatchRadius && (!best || d < best.d ||
        (d === best.d && best.kind === 'guide'))) {
      best = { kind: 'guide', id: g.id, t: g.t, d };
    }
  }
  return best;
}

function estimateMedia(hit, mode, calibByDevice) {
  if (mode === 'raw') {
    return naiveMediaTime(DEVICES[hit.deviceId], hit.deviceTime, DEVICE_ORIGIN[hit.deviceId]);
  }
  return calibByDevice[hit.deviceId].map(hit.deviceTime);
}

// Judge every hit. deviceVoice maps device -> voice label after a possible
// musician swap; attribution labels use the current mapping.
export function judgeHits(hits, { mode = 'calibrated', calib = null, deviceVoice = { dev1: 1, dev2: 2 } } = {}) {
  return hits.map((hit) => {
    const est = estimateMedia(hit, mode, calib || {});
    const target = nearestTarget(est);
    const dev = target ? +(est - target.t).toFixed(6) : null;
    const grade = target ? gradeDeviation(dev) : 'stray';
    const edge = target ? boundaryGrade(dev) : null;
    const note = target?.kind === 'note' ? NOTES.find((n) => n.id === target.id) : null;
    let attribution = 'correct';
    if (!target) attribution = 'stray';
    else if (target.kind === 'guide') attribution = 'guide-capture';
    else if (note.unison) attribution = 'unison';
    else if (`dev${note.voice}` !== hit.deviceId) attribution = 'handoff-flip';
    // Split the calibrated residual into device error and human error. Under
    // calibration the device component is ~0 and the residual is the player's;
    // in raw mode the offset/drift term dominates.
    const deviceError = +(est - hit.trueMediaTime).toFixed(6);
    const humanError = hit.performanceJitter;
    return Object.freeze({
      hitId: hit.hitId,
      noteId: hit.noteId,
      deviceId: hit.deviceId,
      voice: deviceVoice[hit.deviceId],
      mediaEstimate: +est.toFixed(6),
      target: target ? Object.freeze({ ...target }) : null,
      deviation: dev,
      grade,
      attribution,
      boundary: edge,
      decomposition: Object.freeze({ deviceError, humanError,
        total: +(deviceError + humanError).toFixed(6) })
    });
  });
}

// Roll judged hits up to score notes and guide beats so the report can trace a
// grade change back to a concrete note and the hit that claimed it.
export function rollupNotes(judged) {
  const byNote = new Map();
  for (const n of NOTES) byNote.set(n.id, { note: n, claims: [] });
  const byGuide = new Map();
  for (const g of GUIDE_BEATS) byGuide.set(g.id, { guide: g, claims: [] });

  for (const j of judged) {
    if (!j.target) continue;
    if (j.target.kind === 'note') byNote.get(j.target.id)?.claims.push(j);
    else byGuide.get(j.target.id)?.claims.push(j);
  }

  const noteRows = [...byNote.values()].map(({ note, claims }) => {
    // Unison notes legitimately have one claim per device; single-voice notes
    // treat other-device claims as flips and exclude them from adoption.
    const mine = note.unison ? claims : claims.filter((c) => c.attribution !== 'handoff-flip');
    const adopted = [...mine].sort((a, b) => Math.abs(a.deviation) - Math.abs(b.deviation))[0] || null;
    return Object.freeze({
      note,
      claimed: claims.length > 0,
      grade: adopted ? adopted.grade : 'miss',
      adoptedHitId: adopted?.hitId ?? null,
      claims: Object.freeze(claims.map((c) => Object.freeze({
        hitId: c.hitId, deviceId: c.deviceId, grade: c.grade,
        attribution: c.attribution, deviation: c.deviation
      })))
    });
  });

  const guideRows = [...byGuide.values()]
    .filter(({ claims }) => claims.length > 0)
    .map(({ guide, claims }) => Object.freeze({
      guide,
      claims: Object.freeze(claims.map((c) => Object.freeze({
        hitId: c.hitId, deviceId: c.deviceId, intendedNoteId: c.noteId,
        grade: c.grade, deviation: c.deviation
      })))
    }));

  return Object.freeze({ noteRows: Object.freeze(noteRows), guideRows: Object.freeze(guideRows) });
}

// Full before/after comparison. Both rows are aligned by note id so every
// grade change is traceable to a specific score note.
export function compareCalibration(hits, calib) {
  const raw = judgeHits(hits, { mode: 'raw' });
  const fixed = judgeHits(hits, { mode: 'calibrated', calib });
  const rawRoll = rollupNotes(raw);
  const fixedRoll = rollupNotes(fixed);
  const rows = fixedRoll.noteRows.map((after) => {
    const before = rawRoll.noteRows.find((r) => r.note.id === after.note.id);
    return Object.freeze({
      noteId: after.note.id,
      t: after.note.t,
      bar: after.note.bar,
      beat: after.note.beat,
      voice: after.note.voice,
      unison: after.note.unison,
      rawGrade: before.grade,
      calibratedGrade: after.grade,
      changed: before.grade !== after.grade,
      rawAttribution: before.claims[0]?.attribution ?? null,
      calibratedAttribution: after.claims[0]?.attribution ?? null,
      rawHitId: before.adoptedHitId,
      calibratedHitId: after.adoptedHitId
    });
  });
  return Object.freeze({ raw, calibrated: fixed, rawRoll, calibratedRoll: fixedRoll, rows });
}

// Boundary differences: strikes whose grade depends on the edge convention.
export function boundaryDifferences(judged) {
  return judged
    .filter((j) => j.boundary?.onEdge && j.boundary.inclusive !== j.boundary.exclusive)
    .map((j) => Object.freeze({
      hitId: j.hitId, deviceId: j.deviceId, targetId: j.target.id,
      targetKind: j.target.kind, deviation: j.deviation,
      inclusiveGrade: j.boundary.inclusive, exclusiveGrade: j.boundary.exclusive
    }));
}

// Per-voice grade counts for the summary strip.
export function gradeSummary(judged) {
  const summary = {
    dev1: { perfect: 0, good: 0, miss: 0, stray: 0 },
    dev2: { perfect: 0, good: 0, miss: 0, stray: 0 }
  };
  for (const j of judged) summary[j.deviceId][j.grade] += 1;
  return Object.freeze(summary);
}
