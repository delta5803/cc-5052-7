// Audible, traceable counterexamples. Each entry names the score notes and
// hits involved so a listener can open the raw/calibrated tracks and hear the
// exact passage the grade-change table is describing.

export function buildCounterexamples(comparison, boundary) {
  const { raw, calibrated, rawRoll, calibratedRoll } = comparison;
  const cases = [];

  // CE1: opening unison — both devices earn identical grades at the start.
  const opening = comparison.rows.filter((r) => r.bar === 1 && r.unison);
  cases.push(Object.freeze({
    id: 'CE1',
    title: '乐句开头：两台设备同分',
    measure: 'M1',
    detail: '齐奏音在每个判定视图下两台设备等级完全相同；校准后两轨均为 perfect，稳定延迟尚未把差距拉开。',
    noteIds: opening.map((r) => r.noteId),
    expect: { raw: '两设备同分（受 40ms 固定延迟影响）', calibrated: '两设备均 perfect' },
    audible: '两条输入在混音中几乎重合，只有约 40ms 的轻微拍边。'
  }));

  // CE2: stable latency keeps dev1 inside windows but visible as a fixed lag.
  const dev1Mid = calibrated.filter((j) => j.deviceId === 'dev1' && j.target?.kind === 'note')
    .slice(2, 4);
  cases.push(Object.freeze({
    id: 'CE2',
    title: '一号设备：40ms 稳定延迟的固定拖拍',
    measure: 'M2-M3',
    detail: '原始判定把每个 dev1 击打压迟 40ms；校准后残差只剩人为抖动，等级整体回升。',
    noteIds: dev1Mid.map((j) => j.noteId),
    expect: { raw: 'good 边缘居多', calibrated: 'perfect 为主' },
    audible: 'raw 输入轨里高音声部始终慢半拍；calibrated 轨与伴奏对齐。'
  }));

  // CE3: hocket handoff flips in the drifting device.
  const rawFlips = raw.filter((j) => j.attribution === 'handoff-flip');
  cases.push(Object.freeze({
    id: 'CE3',
    title: '二号设备漂移：交接音归属翻转',
    measure: 'M4-M6 十六分音符接龙',
    detail: '未校准时 dev2 的晚到击打越过相邻十六分音符的中线，被记到 dev1 的音符上；校准后各归各位。',
    noteIds: [...new Set(rawFlips.map((j) => j.noteId))].slice(0, 8),
    expect: { raw: 'handoff-flip', calibrated: 'correct' },
    audible: 'raw 混音里接龙的左右声像开始“抢拍/漏拍”；calibrated 轨恢复交替。'
  }));

  // CE4: guide-beat capture — a hit whose nearest target is the accompaniment.
  const guideCaptures = raw.filter((j) => j.attribution === 'guide-capture');
  cases.push(Object.freeze({
    id: 'CE4',
    title: '两类节拍：输入音丢失、伴奏拍被认领',
    measure: 'M6 尾部接龙 与 M9 边缘合击',
    detail: '漂移累积后 dev2 的击打越过最近输入音的匹配半径，最近目标变成木鱼/底鼓伴奏拍；移动同步标记后归属会重算回输入音。',
    noteIds: [...new Set(guideCaptures.map((j) => j.noteId))].slice(0, 6),
    guideIds: [...new Set(guideCaptures.map((j) => j.target.id))].slice(0, 6),
    expect: { raw: 'guide-capture', calibrated: 'correct 输入音符' },
    audible: 'raw 轨中低音声部的 blip 贴着木鱼/底鼓点击出现；校准后回到旋律音。'
  }));

  // CE5: tail handoff separation on the final note.
  const tail = comparison.rows.filter((r) => r.bar === 10);
  cases.push(Object.freeze({
    id: 'CE5',
    title: '乐句尾部：交接音在终点分离',
    measure: 'M10',
    detail: '同一目标音，dev2 原始时刻已漂出 good 窗口判 miss，校准后回到 perfect；开头同分、结尾分家。',
    noteIds: tail.map((r) => r.noteId),
    expect: { raw: 'miss', calibrated: 'perfect/good' },
    audible: 'raw 混音最后一个低音 blip 明显晚于伴奏重音；calibrated 混音同时落下。'
  }));

  // CE6: edge unison — same correct strike, two convention-dependent grades.
  const edgeNotes = boundary.map((b) => (b.targetKind === 'note' ? b.targetId : null)).filter(Boolean);
  cases.push(Object.freeze({
    id: 'CE6',
    title: '允许误差边缘的合击：正确演奏也有边界差异',
    measure: 'M9 beat 1 齐奏',
    detail: 'dev1 偏差恰为 45ms：含边界约定判 perfect，严格约定判 good。记录两种结果，不做静默升级。',
    noteIds: [...new Set(edgeNotes)],
    expect: { inclusive: 'perfect', exclusive: 'good' },
    audible: '该音在立体声中两侧同时发声，听感整齐，但判定对采样量化后的 45.0ms 极其敏感。'
  }));

  // CE7: same-voice continuous accent measure.
  const accentBar = comparison.rows.filter((r) => r.bar === 8);
  cases.push(Object.freeze({
    id: 'CE7',
    title: '同声部连续重音小节',
    measure: 'M8',
    detail: '整小节只有 dev1 的四个重音，没有另一声部掩护；校准前后的命中变化可逐音核对设备延迟贡献。',
    noteIds: accentBar.map((r) => r.noteId),
    expect: { raw: '统一 +40ms 偏移', calibrated: '抖动围绕 0 分布' },
    audible: '四个高音重音在 raw 轨整齐晚半拍，calibrated 轨与底鼓重音对齐。'
  }));

  return Object.freeze(cases);
}
