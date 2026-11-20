// Minimal valid MusicXML export (part-wise, 4/4, quarter = 100). Each part is
// built bar by bar; every empty slot is filled with properly sized rests so
// the file opens in MuseScore and other readers without repair prompts.
import { NOTES, SCORE_META } from './score.js';

const DUR_TYPE = { 4: 'whole', 2: 'half', 1: 'quarter', 0.5: 'eighth', 0.25: '16th' };
const PART_PITCH = { 1: 0, 2: 1 }; // index into the two pitch tables lives on the note

function pitchXml(note, voiceNum) {
  // Unison notes store the high-voice pitch; the low part transposes down one
  // octave so both staves share the same pitch class at the unison moment.
  const p = note.pitch;
  const octave = note.unison && voiceNum === 2 ? p.octave - 1 : p.octave;
  const alter = p.alter ? `<alter>${p.alter}</alter>` : '';
  return `<pitch><step>${p.step}</step>${alter}<octave>${octave}</octave></pitch>`;
}

function noteXml(n, duration, voiceNum) {
  const divs = Math.round(duration * 4); // divisions=4 per quarter note
  if (n) {
    return `<note>${pitchXml(n, voiceNum)}<duration>${divs}</duration>` +
      `<voice>1</voice><type>${DUR_TYPE[duration]}</type>${n.accent ? '<accent/>' : ''}</note>`;
  }
  return `<note><rest/><duration>${divs}</duration><voice>1</voice>` +
    `<type>${DUR_TYPE[duration]}</type></note>`;
}

// Split a bar's occupied slots into note/rest events covering all four beats.
function barEvents(barNotes) {
  const events = [];
  let cursor = 0;
  for (const n of barNotes) {
    const start = n.beat - 1; // beat units within the bar
    if (start > cursor + 1e-9) events.push({ note: null, dur: +(start - cursor).toFixed(4) });
    let dur = 1;
    if (n.bar >= 4 && n.bar <= 6) dur = 0.25; // hocket 16ths
    else if (n.bar === 10) dur = 2;           // M10 half note
    events.push({ note: n, dur });
    cursor = start + dur;
  }
  if (cursor < 4 - 1e-9) events.push({ note: null, dur: +(4 - cursor).toFixed(4) });
  return events;
}

function partXml(partId, voiceNum) {
  const bars = [];
  for (let bar = 1; bar <= SCORE_META.bars; bar++) {
    const barNotes = NOTES
      .filter((n) => n.bar === bar && (n.voice === voiceNum || n.unison))
      .sort((a, b) => a.beat - b.beat);
    const events = barEvents(barNotes);
    const body = events.map((e) => noteXml(e.note, e.dur, voiceNum)).join('');
    const attrs = bar === 1
      ? `<attributes><divisions>4</divisions><key><fifths>0</fifths></key>` +
        `<time><beats>4</beats><beat-type>4</beat-type></time>` +
        `<clef><sign>${voiceNum === 1 ? 'G' : 'F'}</sign>` +
        `<line>${voiceNum === 1 ? 2 : 4}</line></clef></attributes>`
      : '';
    bars.push(`<measure number="${bar}">${attrs}${body}</measure>`);
  }
  return `<part id="${partId}">${bars.join('')}</part>`;
}

export function buildMusicXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
<work><work-title>${SCORE_META.title}</work-title></work>
<identification><encoding><software>ensemble rehearsal generator</software></encoding></identification>
<part-list>
<score-part id="P1"><part-name>高声部 · 一号乐手</part-name></score-part>
<score-part id="P2"><part-name>低声部 · 二号乐手</part-name></score-part>
</part-list>
${partXml('P1', 1)}
${partXml('P2', 2)}
</score-partwise>`;
}
