import { CHART } from '../lib/chart.js';
import { RhythmSession } from '../lib/session.js';
import { FakeClock, FakeTransport, VirtualClient } from './virtual.js';

// Scenario factory: every offset, skew, delay and loss is a declared constant
// so the runner can assert exact judgment windows and duplicate handling.
export function buildScenario(name, fn) {
  return { name, fn };
}

export function harness({ grace = 0.35 } = {}) {
  const clock = new FakeClock(1000);
  const session = new RhythmSession(() => clock.now(), { grace });
  const transport = new FakeTransport(clock);
  const tick = () => session.tick();
  return {
    clock, session, transport,
    makeClient(opts) { return new VirtualClient(session, transport, clock, opts); },
    runTo(t) { clock.runUntil(t, tick); },
    round(id) { return session.rounds.get(id); }
  };
}

export const scenarios = [
  buildScenario('baseline: on-time hits inside perfect window', (h) => {
    const c = h.makeClient({ id: 'p1' });
    h.runTo(1000.1);
    c.sync();
    h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    c.learnRound(h.session._roundView(r));
    for (const n of CHART.notes) c.scheduleHit(n.t, {});
    h.runTo(r.endS + 1);
    return () => {
      const notes = h.round(r.id).notes;
      assert(notes.every((n) => n.result.grade === 'perfect'), 'all notes perfect');
      assert(notes.every((n) => n.result.adopted.clientId === 'p1'), 'adopted by p1');
      assert(!notes.some((n) => n.result.ambiguous), 'no ambiguous grades');
    };
  }),

  buildScenario('bounded grading: 80ms late is good, 150ms late is miss', (h) => {
    const c = h.makeClient({ id: 'p1', outUnc: 0.005, inUnc: 0.005 });
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    c.learnRound(h.session._roundView(r));
    c.scheduleHit(CHART.notes[0].t, { skew: 0.08 });   // 80ms -> good
    c.scheduleHit(CHART.notes[1].t, { skew: 0.15 });   // past the 120ms good window -> miss
    h.runTo(r.endS + 1);
    return () => {
      const [n1, n2] = h.round(r.id).notes;
      assert(n1.result.grade === 'good', '80ms skew graded good');
      assert(n2.result.grade === 'miss', '150ms skew graded miss');
      assert(n2.result.adopted === null, 'no hit adopted for the missed note');
    };
  }),

  buildScenario('ambiguity: uncertainty straddling perfect/good boundary', (h) => {
    const c = h.makeClient({ id: 'p1', outUnc: 0.03, inUnc: 0.03 }); // I=60ms
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    c.learnRound(h.session._roundView(r));
    // Center 45ms late with +-60ms evidence: interval [-15ms, +105ms]
    // covers both perfect and good, so the bounded result is good+ambiguous.
    c.scheduleHit(CHART.notes[0].t, { skew: 0.045 });
    h.runTo(r.endS + 1);
    return () => {
      const n1 = h.round(r.id).notes[0];
      assert(n1.result.grade === 'good', 'bounded to good');
      assert(n1.result.ambiguous === true, 'flagged ambiguous');
    };
  }),

  buildScenario('window edges: +-120ms inside, 150ms outside', (h) => {
    const c = h.makeClient({ id: 'p1', outUnc: 0.002, inUnc: 0.002 });
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    c.learnRound(h.session._roundView(r));
    c.scheduleHit(CHART.notes[0].t, { skew: -0.12 });
    c.scheduleHit(CHART.notes[1].t, { skew: 0.15 });
    h.runTo(r.endS + 1);
    return () => {
      const [n1, n2] = h.round(r.id).notes;
      assert(n1.result.grade === 'good', '-120ms still good');
      assert(n2.result.grade === 'miss', '150ms miss');
    };
  }),

  buildScenario('idempotent retransmission: same hitId never counted twice', (h) => {
    const c = h.makeClient({ id: 'p1' });
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    c.learnRound(h.session._roundView(r));
    const id = c.scheduleHit(CHART.notes[0].t, {});
    h.runTo(r.startS + CHART.notes[0].t + 0.01);
    const orig = c.sent.find((m) => m.hitId === id);
    c.retransmit(orig, 0.05);
    c.retransmit(orig, 0.10);
    h.runTo(r.endS + 1);
    return () => {
      const stored = [...h.round(r.id).hits.values()].filter((x) => x.hitId === id);
      assert(stored.length === 1, 'exactly one stored record');
      const dupAcks = c.acks.filter((a) => a.retransmit);
      assert(dupAcks.length === 2, 'two retransmit acks');
      assert(dupAcks.every((a) => a.ack.duplicate === true), 'acks marked duplicate');
      const n1 = h.round(r.id).notes[0];
      assert(n1.result.contenders.length === 1, 'one contender, not three');
    };
  }),

  buildScenario('receive order != performance order across two clients', (h) => {
    const a = h.makeClient({
      id: 'a', outUnc: 0.005, inUnc: 0.005,
      network: { delayUp: () => 0.30, delayDown: () => 0.02 }
    });
    const b = h.makeClient({
      id: 'b', outUnc: 0.005, inUnc: 0.005,
      network: { delayUp: () => 0.01, delayDown: () => 0.02 }
    });
    h.runTo(1000.1); a.sync(); b.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    a.learnRound(h.session._roundView(r));
    b.learnRound(h.session._roundView(r));
    // a hits 20ms early (better) but the 300ms uplink makes it arrive after b.
    a.scheduleHit(CHART.notes[0].t, { skew: -0.02 });
    b.scheduleHit(CHART.notes[0].t, { skew: 0.09 });
    h.runTo(r.endS + 1);
    return () => {
      const hits = [...h.round(r.id).hits.values()];
      const ra = hits.find((x) => x.clientId === 'a');
      const rb = hits.find((x) => x.clientId === 'b');
      assert(rb.recvS < ra.recvS, 'b packet is received before a despite playing later');
      // One-way uplink delay observed directly from capture to receipt.
      const oneWayA = ra.recvS - ra.inputS.lo;
      const oneWayB = rb.recvS - rb.inputS.lo;
      assert(oneWayA > 0.25 && oneWayB < 0.05, 'per-link uplink delays are 300ms vs 10ms');
      const n1 = h.round(r.id).notes[0];
      assert(n1.result.adopted.clientId === 'a', 'earlier player a is adopted');
      assert(n1.result.contenders.length === 2, 'both contenders recorded');
    };
  }),

  buildScenario('clock offset is bounded and absorbed, not trusted blindly', (h) => {
    const c = h.makeClient({
      id: 'p1', clockOffset: 0.5,
      network: { delayUp: () => 0.08, delayDown: () => 0.08 }
    });
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    c.learnRound(h.session._roundView(r));
    c.scheduleHit(CHART.notes[0].t, {});
    h.runTo(r.endS + 1);
    return () => {
      const center = (c.bounds.lo + c.bounds.hi) / 2;
      assert(Math.abs(center - 0.5) < 0.01,
        'offset center recovers true 500ms under symmetric delay');
      assert(c.bounds.hi - c.bounds.lo >= 0.15, 'bound spans measured RTT');
      const n1 = h.round(r.id).notes[0];
      assert(n1.result.grade === 'perfect', 'offset-corrected hit is perfect');
    };
  }),

  buildScenario('asymmetric delay: true offset stays inside the declared bound', (h) => {
    const c = h.makeClient({
      id: 'p1', clockOffset: 0.5,
      network: { delayUp: () => 0.08, delayDown: () => 0.06 }
    });
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    return () => {
      assert(c.bounds.lo <= 0.5 && c.bounds.hi >= 0.5,
        'true offset enclosed by bound even with asymmetric paths');
    };
  }),

  buildScenario('late evidence cannot reopen a finalized note', (h) => {
    const c = h.makeClient({
      id: 'p1', outUnc: 0.005, inUnc: 0.005,
      network: {
        delayUp: (m) => (m.kind === 'hit' ? 0.50 : 0.02),
        delayDown: () => 0.02
      }
    });
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    c.learnRound(h.session._roundView(r));
    c.scheduleHit(CHART.notes[0].t, {});
    h.runTo(r.endS + 1);
    return () => {
      const n1 = h.round(r.id).notes[0];
      assert(n1.result.grade === 'miss', 'note finalized as miss');
      const rejection = n1.result.rejected.find((x) => x.reason === 'note-finalized');
      assert(rejection, 'late hit recorded in rejected evidence as note-finalized');
    };
  }),

  buildScenario('forged timestamp outside receive envelope is inconsistent', (h) => {
    const c = h.makeClient({ id: 'p1', network: { delayUp: () => 0.02 } });
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    c.learnRound(h.session._roundView(r));
    const id = c.scheduleHit(CHART.notes[0].t, {});
    h.runTo(r.startS + CHART.notes[0].t + 0.01);
    const real = c.sent.find((m) => m.hitId === id);
    const forged = { ...real,
      hitId: 'forged-1', localMedia: -3.0,
      inputLocal: real.inputLocal - 3.0, presentLocal: real.presentLocal - 3.0 };
    c.clock.setAt(c.clock.now() + 0.01, () => {
      h.transport.sendUp(c, forged, (client, m) => {
        client.acks.push({ kind: 'hit', hitId: m.hitId, ack: client.session.handleHit(client.id, m) });
      });
    });
    h.runTo(r.endS + 1);
    return () => {
      const rec = h.round(r.id).hits.get('forged-1');
      assert(rec.consistent === false, 'forged timestamps fail consistency');
      assert(rec.rejectReason === 'inconsistent-evidence', 'named inconsistency');
      const n1 = h.round(r.id).notes[0];
      assert(n1.result.grade === 'perfect', 'real hit still adopted');
    };
  }),

  buildScenario('declared uncertainties are clamped, zero is not allowed', (h) => {
    const c = h.makeClient({ id: 'p1', outUnc: 0, inUnc: 999 });
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    return () => {
      const view = h.session._clientView(h.session.clients.get('p1'));
      assert(view.outUnc === 0.001, 'zero output uncertainty clamped to minimum');
      assert(view.inUnc === 0.5, 'huge input uncertainty clamped to maximum');
    };
  }),

  buildScenario('two clients: better evidence wins and both results emitted', (h) => {
    const a = h.makeClient({ id: 'a', outUnc: 0.005, inUnc: 0.005 });
    const b = h.makeClient({ id: 'b', outUnc: 0.005, inUnc: 0.005 });
    h.runTo(1000.1); a.sync(); b.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    a.learnRound(h.session._roundView(r));
    b.learnRound(h.session._roundView(r));
    a.scheduleHit(CHART.notes[0].t, { skew: 0.10 }); // good
    b.scheduleHit(CHART.notes[0].t, { skew: 0.01 }); // perfect
    h.runTo(r.endS + 1);
    return () => {
      const n1 = h.round(r.id).notes[0];
      assert(n1.result.adopted.clientId === 'b', 'perfect performer adopted');
      assert(n1.result.contenders.find((x) => x.clientId === 'a').grade === 'good',
        'a retained as good contender');
    };
  }),

  buildScenario('miss when nobody plays a note', (h) => {
    const c = h.makeClient({ id: 'p1' });
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    c.learnRound(h.session._roundView(r));
    c.scheduleHit(CHART.notes[0].t, {});
    h.runTo(r.endS + 1);
    return () => {
      const notes = h.round(r.id).notes;
      assert(notes[0].result.grade === 'perfect', 'played note perfect');
      assert(notes.slice(1).every((n) => n.result.grade === 'miss'), 'rest miss');
    };
  }),

  buildScenario('three independent timestamps are recorded separately', (h) => {
    const c = h.makeClient({
      id: 'p1', network: { delayUp: () => 0.07, delayDown: () => 0.03 }
    });
    h.runTo(1000.1); c.sync(); h.runTo(1001);
    const r = h.session.startRound({ startDelay: 0.5 });
    c.learnRound(h.session._roundView(r));
    c.scheduleHit(CHART.notes[0].t, {});
    h.runTo(r.startS + CHART.notes[0].t + 0.2);
    return () => {
      const rec = [...h.round(r.id).hits.values()][0];
      assert(rec.presentS && rec.inputS, 'presentation and input stored');
      assert(rec.recvS > rec.inputS.lo, 'receive later than capture due to network');
      assert(rec.recvMedia && rec.clkMedia && rec.localMedia,
        'three independent evidence channels retained');
    };
  })
];

let failures = 0;
export function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

export async function runAll() {
  let passed = 0;
  for (const s of scenarios) {
    const h = harness();
    try {
      const check = s.fn(h);
      if (typeof check === 'function') check();
      console.log(`  ok   ${s.name}`);
      passed++;
    } catch (err) {
      failures++;
      console.log(`  FAIL ${s.name}\n       ${err.message}`);
    }
  }
  console.log(`\n${passed}/${scenarios.length} scenarios passed`);
  return failures === 0;
}
