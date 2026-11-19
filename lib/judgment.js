import { WINDOWS, GRADE_RANK } from './chart.js';

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Bounded grade. A grade is only assigned if the whole interval fits it;
// when an interval straddles a boundary the conservative (looser) grade is
// used and the result is explicitly ambiguous. Ambiguous results are never
// upgraded later — the interval itself is the available evidence.
export function gradeInterval(lo, hi) {
  const a = Math.abs(lo);
  const b = Math.abs(hi);
  const maxAbs = Math.max(a, b);
  const minAbs = Math.min(a, b);
  let grade;
  if (maxAbs <= WINDOWS.perfect) grade = 'perfect';
  else if (maxAbs <= WINDOWS.good) grade = 'good';
  else if (minAbs > WINDOWS.good) grade = 'miss';
  else grade = 'good';
  const ambiguous =
    (minAbs <= WINDOWS.perfect && maxAbs > WINDOWS.perfect) ||
    (minAbs <= WINDOWS.good && maxAbs > WINDOWS.good);
  return { grade, ambiguous };
}

// Pick the adopted hit for a note. Prefer the best grade, then the narrowest
// uncertainty (strongest evidence), then the smallest worst-case deviation.
export function chooseAdopted(candidates) {
  return [...candidates].sort((x, y) => {
    const g = GRADE_RANK[x.grade] - GRADE_RANK[y.grade];
    if (g !== 0) return g;
    const wx = x.medHi - x.medLo;
    const wy = y.medHi - y.medLo;
    if (Math.abs(wx - wy) > 1e-9) return wx - wy;
    return Math.max(Math.abs(x.medLo), Math.abs(x.medHi)) -
           Math.max(Math.abs(y.medLo), Math.abs(y.medHi));
  })[0];
}

// Intersect two half-open intervals; null when they do not overlap.
export function intersect(aLo, aHi, bLo, bHi, eps = 0) {
  const lo = Math.max(aLo, bLo);
  const hi = Math.min(aHi, bHi);
  if (lo > hi + eps) return null;
  return [lo, hi];
}

// Cristian-style offset bound from one sync exchange.
// t0/t3 are client (local) clock readings; t1/t2 are server clock readings.
// Local = server + offset, so offset ≈ ((t0 - t1) + (t3 - t2)) / 2.
export function offsetBoundsFromSample(t0, t1, t2, t3) {
  const rtt = (t3 - t0) - (t2 - t1);
  if (rtt < 0) return null;
  const center = ((t0 - t1) + (t3 - t2)) / 2;
  return { center, lo: center - rtt / 2, hi: center + rtt / 2, rtt };
}

// Merge offset samples by keeping the tightest enclosing bound seen so far.
export function mergeOffsetBounds(prev, sample) {
  if (!prev) return { lo: sample.lo, hi: sample.hi, rtt: sample.rtt };
  return {
    lo: Math.max(prev.lo, sample.lo),
    hi: Math.min(prev.hi, sample.hi),
    rtt: Math.min(prev.rtt, sample.rtt)
  };
}
