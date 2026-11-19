import {
  CHART, WINDOWS, FINALIZE_GRACE, LATE_REJECT_MARGIN,
  PROC_EPS, MIN_DECLARED_UNC, MAX_DECLARED_UNC
} from './chart.js';
import {
  clamp, gradeInterval, chooseAdopted, intersect,
  offsetBoundsFromSample, mergeOffsetBounds
} from './judgment.js';

// One RhythmSession holds the whole authoritative state. Time is injected so
// tests can run deterministically against a virtual clock while the real
// server passes a monotonic clock. Nothing here reads the network directly.
export class RhythmSession {
  constructor(now, { grace = FINALIZE_GRACE } = {}) {
    this._now = now;
    this.grace = grace;
    this.clients = new Map();
    this.rounds = new Map();
    this.events = [];
  }

  now() { return this._now(); }

  takeEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  _emit(type, data) {
    this.events.push({ type, at: this.now(), data });
  }

  registerClient({ id, name, outUnc, inUnc }) {
    const client = {
      id,
      name: String(name || id).slice(0, 40),
      outUnc: clamp(Number(outUnc) || 0, MIN_DECLARED_UNC, MAX_DECLARED_UNC),
      inUnc: clamp(Number(inUnc) || 0, MIN_DECLARED_UNC, MAX_DECLARED_UNC),
      offset: null,
      pendingSync: null,
      connected: true
    };
    this.clients.set(id, client);
    this._emit('client', { client: this._clientView(client) });
    return client;
  }

  setConnected(id, connected) {
    const c = this.clients.get(id);
    if (c) {
      c.connected = connected;
      this._emit('client', { client: this._clientView(c) });
    }
  }

  // Two-phase sync. The client pings with its reading t0; the server stamps
  // arrival/departure t1/t2 and issues a nonce. The client reports its receive
  // reading t3 with the nonce, and the server derives the offset bound.
  handleSyncPing(id, t0) {
    const client = this.clients.get(id);
    if (!client) return { error: 'unknown-client' };
    if (typeof t0 !== 'number' || !Number.isFinite(t0)) return { error: 'bad-t0' };
    const t = this.now();
    const nonce = `${id}-${Math.round(t * 1000)}-${Math.floor(Math.random() * 1e6)}`;
    client.pendingSync = { nonce, t0, t1: t, t2: t };
    return { nonce, t1: t, t2: t };
  }

  handleSyncComplete(id, msg) {
    const client = this.clients.get(id);
    if (!client) return { error: 'unknown-client' };
    const p = client.pendingSync;
    if (!p || p.nonce !== msg.nonce) return { error: 'bad-nonce' };
    if (msg.t1 !== p.t1 || msg.t2 !== p.t2 || msg.t0 !== p.t0) {
      return { error: 'stamp-mismatch' };
    }
    const sample = offsetBoundsFromSample(p.t0, p.t1, p.t2, Number(msg.t3));
    client.pendingSync = null;
    if (!sample) return { error: 'bad-sample' };
    client.offset = mergeOffsetBounds(client.offset, sample);
    return { bounds: { ...client.offset } };
  }

  startRound({ startDelay = 0.6, roundId = `r${this.rounds.size + 1}` } = {}) {
    const startS = this.now() + startDelay;
    const round = {
      id: roundId,
      startS,
      endS: startS + CHART.duration,
      status: 'scheduled',
      notes: CHART.notes.map((n) => ({
        noteId: n.id, t: n.t, finalized: false,
        deadline: startS + n.t + this.grace,
        result: null
      })),
      hits: new Map()
    };
    this.rounds.set(roundId, round);
    this._emit('round', { round: this._roundView(round) });
    return round;
  }

  handleHit(clientId, msg) {
    const client = this.clients.get(clientId);
    if (!client) return { accepted: false, reason: 'unknown-client' };
    if (!client.offset) return { accepted: false, reason: 'no-clock-sync' };
    const round = this.rounds.get(msg.roundId);
    if (!round) return { accepted: false, reason: 'unknown-round' };
    if (round.status === 'ended') return { accepted: false, reason: 'round-ended' };
    if (!msg.hitId || typeof msg.hitId !== 'string') {
      return { accepted: false, reason: 'missing-hit-id' };
    }
    const nums = [msg.inputLocal, msg.presentLocal, msg.localMedia];
    if (nums.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      return { accepted: false, reason: 'bad-timestamps' };
    }

    // Stable hit identity: a retransmission of the same id is idempotent.
    const existing = round.hits.get(msg.hitId);
    if (existing) {
      return { accepted: existing.consistent, duplicate: true, record: this._hitView(existing) };
    }

    const rec = this._buildHit(client, round, msg);
    round.hits.set(msg.hitId, rec);
    this._emit('hit', { roundId: round.id, hit: this._hitView(rec) });

    if (!rec.consistent) {
      return { accepted: false, reason: rec.rejectReason, record: this._hitView(rec) };
    }
    if (rec.finalizedNote) {
      return { accepted: false, reason: 'note-finalized', record: this._hitView(rec) };
    }
    if (rec.tooLate) {
      return { accepted: false, reason: 'outside-late-margin', record: this._hitView(rec) };
    }
    return { accepted: true, record: this._hitView(rec) };
  }

  _buildHit(client, round, msg) {
    const off = client.offset;
    const startS = round.startS;
    const recvS = this.now();

    // 1) Clock-mapped evidence. server = local - offset, offset in [lo, hi].
    //    Both the presentation schedule and the capture instant are mapped.
    const mapLocal = (v) => ({ lo: v - off.hi, hi: v - off.lo });
    const inputS = mapLocal(Number(msg.inputLocal));
    const presentS = mapLocal(Number(msg.presentLocal));

    // 2) Local media-duration evidence (capture minus scheduled presentation,
    //    read on the same clock). Bounded only by declared device uncertainty.
    const I = client.outUnc + client.inUnc;
    const localCenter = Number(msg.localMedia);
    const localLo = localCenter - I;
    const localHi = localCenter + I;

    // 3) Receive-time hard envelope. recvS is stamped by the server itself,
    //    so it anchors evidence regardless of what the client filled in.
    //    A one-way path can exceed the measured RTT under asymmetric routing,
    //    so the envelope is an absolute staleness cap rather than RTT-scaled:
    //    beyond it the evidence could only describe a long-settled past.
    const recvMedia = recvS - startS;
    const recvLo = recvMedia - LATE_REJECT_MARGIN;
    const recvHi = recvMedia + PROC_EPS;

    // Clock-derived media interval from the capture instant.
    const clkLo = inputS.lo - startS;
    const clkHi = inputS.hi - startS;

    // Adopted media interval: local-duration evidence corroborated by the
    // clock mapping, then constrained by the independent receive envelope.
    let med = intersect(clkLo, clkHi, localLo, localHi);
    let consistent = med !== null;
    if (med) med = intersect(med[0], med[1], recvLo, recvHi, PROC_EPS);
    if (!med) consistent = false;

    const center = consistent ? (med[0] + med[1]) / 2 : localCenter;

    // Nearest-note matching on the strongest single point estimate.
    let best = null;
    for (const n of CHART.notes) {
      const d = Math.abs(n.t - center);
      if (!best || d < best.d) best = { noteId: n.id, t: n.t, d };
    }
    const noteState = round.notes.find((n) => n.noteId === best.noteId);
    const tooLate = center - best.t > LATE_REJECT_MARGIN;
    const tooEarly = best.t - center > LATE_REJECT_MARGIN;
    const finalizedNote = noteState.finalized;

    const rec = {
      hitId: String(msg.hitId),
      clientId: client.id,
      roundId: round.id,
      noteId: best.noteId,
      recvS,
      inputS, presentS,
      localMedia: { lo: localLo, hi: localHi, center: localCenter, uncertainty: I },
      recvMedia: { lo: recvLo, hi: recvHi, center: recvMedia },
      clkMedia: { lo: clkLo, hi: clkHi },
      medLo: consistent ? med[0] : null,
      medHi: consistent ? med[1] : null,
      consistent,
      rejectReason: consistent
        ? (finalizedNote ? 'note-finalized' : tooLate || tooEarly ? 'outside-late-margin' : null)
        : 'inconsistent-evidence',
      tooLate: tooLate || tooEarly,
      finalizedNote,
      rtt: off.rtt,
      outUnc: client.outUnc,
      inUnc: client.inUnc,
      grade: null,
      ambiguous: null
    };
    return rec;
  }

  // Advance the session: finalize notes whose grace window has elapsed and
  // close rounds whose passage has finished.
  tick() {
    const now = this.now();
    for (const round of this.rounds.values()) {
      if (round.status === 'scheduled' && now >= round.startS) {
        round.status = 'playing';
        this._emit('round', { round: this._roundView(round) });
      }
      for (const note of round.notes) {
        if (!note.finalized && now >= note.deadline) this._finalize(round, note);
      }
      if (round.status !== 'ended' && now >= round.endS) {
        round.status = 'ended';
        this._emit('round', { round: this._roundView(round) });
      }
    }
  }

  _finalize(round, note) {
    note.finalized = true;
    const candidates = [];
    const rejected = [];
    for (const h of round.hits.values()) {
      if (h.noteId !== note.noteId) continue;
      // Hard cutoff: evidence landing after the deadline cannot be adopted,
      // even when intake happened before the note was closed.
      const inTime = h.consistent && !h.tooLate && h.recvS <= note.deadline + PROC_EPS;
      if (!inTime) {
        rejected.push({
          hitId: h.hitId, clientId: h.clientId,
          reason: h.consistent ? 'note-finalized' : h.rejectReason
        });
        continue;
      }
      const devLo = h.medLo - note.t;
      const devHi = h.medHi - note.t;
      const { grade, ambiguous } = gradeInterval(devLo, devHi);
      h.grade = grade;
      h.ambiguous = ambiguous;
      if (grade === 'miss') {
        // The interval sits entirely outside the good window: the evidence
        // is retained for inspection but cannot win the note.
        rejected.push({ hitId: h.hitId, clientId: h.clientId, reason: 'outside-window' });
        continue;
      }
      candidates.push({ hit: h, grade, ambiguous, devLo, devHi });
    }
    let result;
    if (candidates.length === 0) {
      result = {
        noteId: note.noteId, t: note.t, grade: 'miss', ambiguous: false,
        reason: 'no-evidence-in-window', adopted: null, rejected
      };
    } else {
      const adopted = chooseAdopted(candidates.map((c) => ({
        hitId: c.hit.hitId, clientId: c.hit.clientId, grade: c.grade,
        medLo: c.devLo, medHi: c.devHi
      })));
      const chosen = candidates.find((c) => c.hit.hitId === adopted.hitId);
      result = {
        noteId: note.noteId, t: note.t,
        grade: chosen.grade, ambiguous: chosen.ambiguous,
        adopted: {
          hitId: chosen.hit.hitId,
          clientId: chosen.hit.clientId,
          devLo: chosen.devLo, devHi: chosen.devHi,
          medLo: chosen.hit.medLo, medHi: chosen.hit.medHi
        },
        contenders: candidates.map((c) => ({
          hitId: c.hit.hitId, clientId: c.hit.clientId,
          grade: c.grade, ambiguous: c.ambiguous,
          devLo: c.devLo, devHi: c.devHi
        })),
        rejected
      };
    }
    note.result = result;
    this._emit('note', { roundId: round.id, result });
  }

  snapshot() {
    return {
      now: this.now(),
      chart: CHART,
      windows: WINDOWS,
      grace: this.grace,
      clients: [...this.clients.values()].map((c) => this._clientView(c)),
      rounds: [...this.rounds.values()].map((r) => this._roundView(r))
    };
  }

  _clientView(c) {
    return {
      id: c.id, name: c.name, connected: c.connected,
      outUnc: c.outUnc, inUnc: c.inUnc,
      offset: c.offset ? { lo: c.offset.lo, hi: c.offset.hi, rtt: c.offset.rtt } : null
    };
  }

  _roundView(r) {
    return {
      id: r.id, startS: r.startS, endS: r.endS, status: r.status,
      notes: r.notes.map((n) => ({
        noteId: n.noteId, t: n.t, finalized: n.finalized, result: n.result
      })),
      hits: [...r.hits.values()].map((h) => this._hitView(h))
    };
  }

  _hitView(h) {
    return {
      hitId: h.hitId, clientId: h.clientId, roundId: h.roundId, noteId: h.noteId,
      recvS: h.recvS,
      inputS: h.inputS, presentS: h.presentS,
      localMedia: h.localMedia, recvMedia: h.recvMedia, clkMedia: h.clkMedia,
      medLo: h.medLo, medHi: h.medHi,
      consistent: h.consistent, rejectReason: h.rejectReason,
      tooLate: h.tooLate, rtt: h.rtt, outUnc: h.outUnc, inUnc: h.inUnc,
      grade: h.grade, ambiguous: h.ambiguous
    };
  }
}
