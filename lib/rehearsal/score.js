// Two-voice rehearsal score. All times are true media seconds from the phrase
// origin (media time 0). The score is the single source of note identity for
// both performers, the audio build and the judge.
export const SCORE_META = Object.freeze({
  id: 'duet-rehearsal-1',
  title: '交接练习 · 双声部十小节',
  bpm: 100,
  beatsPerBar: 4,
  bars: 10,
  duration: 24, // 40 beats at 0.6s each
  beat: 0.6,
  // Judgment windows in seconds; boundary is inclusive (|dev| <= window).
  windows: Object.freeze({ perfect: 0.045, good: 0.090 }),
  // Matching radii in seconds. Input notes demand a tight claim; guide beats
  // are a wider safety net so a badly drifted strike is attributed to the
  // accompaniment it actually landed on rather than dropped as a stray.
  noteMatchRadius: 0.15,
  guideMatchRadius: 0.3
});

const V1_PITCH = [
  { label: 'C5', freq: 523.25, step: 'C', octave: 5, alter: 0 },
  { label: 'D5', freq: 587.33, step: 'D', octave: 5, alter: 0 },
  { label: 'E5', freq: 659.25, step: 'E', octave: 5, alter: 0 },
  { label: 'G5', freq: 783.99, step: 'G', octave: 5, alter: 0 },
  { label: 'A5', freq: 880.0, step: 'A', octave: 5, alter: 0 },
  { label: 'C6', freq: 1046.5, step: 'C', octave: 6, alter: 0 }
];
const V2_PITCH = [
  { label: 'C4', freq: 261.63, step: 'C', octave: 4, alter: 0 },
  { label: 'D4', freq: 293.66, step: 'D', octave: 4, alter: 0 },
  { label: 'E4', freq: 329.63, step: 'E', octave: 4, alter: 0 },
  { label: 'G4', freq: 392.0, step: 'G', octave: 4, alter: 0 },
  { label: 'A4', freq: 440.0, step: 'A', octave: 4, alter: 0 },
  { label: 'C5', freq: 523.25, step: 'C', octave: 5, alter: 0 }
];

let seq = 0;
// beatUnit is in quarter-note units (1 = one beat, 0.25 = a 16th note).
// A unison note is one identity carried by both voices; each device strikes
// it once, but the judge keeps a single target rather than two duplicates.
function note(bar, beatUnit, voice, pitchIdx, { accent = false, unison = false } = {}) {
  return Object.freeze({
    id: `n${String(++seq).padStart(3, '0')}`,
    t: +((bar * 4 + beatUnit) * SCORE_META.beat).toFixed(4),
    bar: bar + 1,
    beat: beatUnit + 1,
    voice,                 // 1, 2, or 0 for unison (both voices)
    voices: unison ? [1, 2] : [voice],
    pitch: (unison ? V1_PITCH : voice === 1 ? V1_PITCH : V2_PITCH)[pitchIdx],
    pitchIdx,
    accent,
    unison
  });
}

function buildNotes() {
  const out = [];

  // M1: four unison quarter notes — both devices start from the same score.
  for (let j = 0; j < 4; j++) out.push(note(0, j, 0, j, { unison: true }));

  // M2-M3: antiphonal quarter notes, voices handing the phrase back and forth.
  const handoffQ = [
    [1, 1, 0], [1, 2, 1], [1, 3, 2], [1, 4, 3],
    [2, 1, 4], [2, 2, 3], [2, 3, 2], [2, 4, 1]
  ];
  for (const [bar, beat, p] of handoffQ) {
    out.push(note(bar, beat - 1, (beat + bar) % 2 === 0 ? 1 : 2, p));
  }

  // M4-M6 (bar index 3-5): three bars of 16th-note hocket. The slow device's
  // drift accumulates across the span: early flips are note-to-note handoff
  // errors, late flips cross all the way to the accompaniment guide beats.
  let p16 = 0;
  for (let bar = 3; bar <= 5; bar++) {
    for (let s = 0; s < 16; s++) {
      out.push(note(bar, s / 4, s % 2 === 0 ? 1 : 2, p16 % 6));
      p16++;
    }
  }

  // M8: one measure of same-voice continuous accents (voice 1 only).
  out.push(note(7, 0, 1, 2, { accent: true }));
  out.push(note(7, 1, 1, 3, { accent: true }));
  out.push(note(7, 2, 1, 4, { accent: true }));
  out.push(note(7, 3, 1, 5, { accent: true }));

  // M9 beat 1: unison edge hit, and nothing else in the measure. The stable
  // device lands exactly on the perfect window edge while the drifting device
  // arrives late: its nearest target is the barline guide kick, so the two
  // beat classes' ownership diverges on this very strike.
  out.push(note(8, 0, 0, 5, { accent: true, unison: true }));

  // M10: tail handoff — where the drifting device parts audibly from the
  // phrase after both devices began with identical scores.
  out.push(note(9, 0, 2, 4));
  return out;
}

export const NOTES = Object.freeze(buildNotes());

export const UNISON_GROUPS = Object.freeze(
  NOTES.filter((n) => n.unison).map((n) => Object.freeze([n.id]))
);

// Accompaniment (guide) beats: woodblock every beat, kick on each barline.
// Guide beats are the second beat class: they carry no input-note ownership
// until a hit is judged against them.
export const GUIDE_BEATS = Object.freeze(
  Array.from({ length: SCORE_META.bars * SCORE_META.beatsPerBar }, (_, i) => Object.freeze({
    id: `g${String(i + 1).padStart(3, '0')}`,
    t: +(i * SCORE_META.beat).toFixed(4),
    bar: Math.floor(i / 4) + 1,
    beat: (i % 4) + 1,
    kind: i % 4 === 0 ? 'kick' : 'wood'
  }))
);

export const SCORE = Object.freeze({
  ...SCORE_META,
  notes: NOTES,
  unisonGroups: UNISON_GROUPS,
  guideBeats: GUIDE_BEATS
});
