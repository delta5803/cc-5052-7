// Shared test passage. Times are media-time seconds relative to the scheduled
// start of the passage (media time 0). The same chart is used by every client
// and by the server, so "note N" has one stable identity for everyone.
export const CHART = Object.freeze({
  id: 'test-passage-1',
  duration: 7.0,
  notes: Object.freeze([
    Object.freeze({ id: 'n1', t: 2.00, freq: 523.25, label: 'C5' }),
    Object.freeze({ id: 'n2', t: 2.50, freq: 587.33, label: 'D5' }),
    Object.freeze({ id: 'n3', t: 3.00, freq: 659.25, label: 'E5' }),
    Object.freeze({ id: 'n4', t: 3.50, freq: 698.46, label: 'F5' }),
    Object.freeze({ id: 'n5', t: 4.00, freq: 783.99, label: 'G5' }),
    Object.freeze({ id: 'n6', t: 4.50, freq: 880.00, label: 'A5' }),
    Object.freeze({ id: 'n7', t: 5.00, freq: 987.77, label: 'B5' }),
    Object.freeze({ id: 'n8', t: 5.50, freq: 1046.5, label: 'C6' })
  ])
});

// Judgment windows in seconds, measured against true media time.
export const WINDOWS = Object.freeze({
  perfect: 0.050,
  good: 0.120
});

// A note is finalized this long after its target time. In-flight evidence
// arriving after the deadline can no longer change a finalized result.
export const FINALIZE_GRACE = 0.350;

// Hard cutoff beyond finalization: hits this late are refused outright.
export const LATE_REJECT_MARGIN = 1.500;

// Server-side tolerance for receive-time consistency checks.
export const PROC_EPS = 0.005;

// Declared device uncertainties are clamped into this band. A client cannot
// claim zero uncertainty, and absurdly large values cannot distort matching.
export const MIN_DECLARED_UNC = 0.001;
export const MAX_DECLARED_UNC = 0.500;

export const GRADE_RANK = Object.freeze({ perfect: 0, good: 1, miss: 2 });
