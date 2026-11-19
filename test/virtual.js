import { CHART } from '../lib/chart.js';

// Deterministic virtual clock. Timers fire in time order while the clock
// advances; nothing here depends on wall-clock time. One master clock drives
// the whole simulation; virtual clients read it through their own offset.
export class FakeClock {
  constructor(initial = 0) {
    this.t = initial;
    this.queue = [];
    this.seq = 0;
  }
  now() { return this.t; }
  setAt(when, fn) {
    const id = ++this.seq;
    this.queue.push({ when, fn, id, cancelled: false });
    return id;
  }
  cancel(id) {
    const job = this.queue.find((j) => j.id === id);
    if (job) job.cancelled = true;
  }
  runUntil(target, onTick = null) {
    while (true) {
      this.queue.sort((a, b) => a.when - b.when || a.id - b.id);
      const next = this.queue.find((j) => !j.cancelled && j.when <= target);
      if (!next) break;
      this.queue = this.queue.filter((j) => j !== next);
      this.t = next.when;
      next.fn();
      if (onTick) onTick(this.t);
    }
    this.t = target;
    if (onTick) onTick(this.t);
  }
}

// Simulated network: per-link one-way delays with optional loss. Delivery
// time, never send order, decides when a message lands at the other side.
export class FakeTransport {
  constructor(masterClock) {
    this.clock = masterClock;
    this.links = new Map();
  }
  attach(clientId, cfg = {}) {
    this.links.set(clientId, {
      delayUp: cfg.delayUp || (() => 0.02),
      delayDown: cfg.delayDown || (() => 0.02),
      lossUp: cfg.lossUp || (() => false),
      lossDown: cfg.lossDown || (() => false)
    });
  }
  sendUp(client, msg, onDeliver) {
    const link = this.links.get(client.id);
    if (link && link.lossUp(msg)) return;
    const d = link ? link.delayUp(msg) : 0;
    this.clock.setAt(this.clock.now() + d, () => onDeliver(client, msg, this.clock.now()));
  }
  sendDown(clientId, msg, onDeliver) {
    const link = this.links.get(clientId);
    if (link && link.lossDown(msg)) return;
    const d = link ? link.delayDown(msg) : 0;
    this.clock.setAt(this.clock.now() + d, () => onDeliver(msg, this.clock.now()));
  }
}

// A virtual performer. localReading(t) = t + clockOffset, and the audio
// input/output chain carries declared uncertainties exactly like the browser.
export class VirtualClient {
  constructor(session, transport, masterClock, opts) {
    this.session = session;
    this.transport = transport;
    this.clock = masterClock;
    this.id = opts.id;
    this.name = opts.name || opts.id;
    this.clockOffset = opts.clockOffset || 0;
    this.outUnc = opts.outUnc ?? 0.025;
    this.inUnc = opts.inUnc ?? 0.020;
    this.bounds = null;
    this.startLocal = null;
    this.roundId = null;
    this.hitCounter = 0;
    this.acks = [];
    this.sent = [];
    session.registerClient({ id: this.id, name: this.name,
      outUnc: this.outUnc, inUnc: this.inUnc });
    transport.attach(this.id, opts.network || {});
  }

  local(t = this.clock.now()) { return t + this.clockOffset; }

  // Full ping/complete round trip, both legs going through the fake network.
  sync() {
    const t0 = this.local();
    this.transport.sendUp(this, { kind: 'sync-ping', t0 }, (client, msg, recvS) => {
      const pingAck = client.session.handleSyncPing(client.id, msg.t0);
      client.transport.sendDown(client.id, { kind: 'sync-ping-ack', ...pingAck }, (down) => {
        const t3 = client.local();
        client.transport.sendUp(client, {
          kind: 'sync-complete', nonce: down.nonce, t0: msg.t0,
          t1: down.t1, t2: down.t2, t3
        }, (c2, m2) => {
          const complete = c2.session.handleSyncComplete(c2.id, m2);
          c2.bounds = complete.bounds;
          c2.acks.push({ kind: 'sync', complete });
        });
      });
    });
  }

  learnRound(roundView) {
    this.roundId = roundView.id;
    const center = (this.bounds.lo + this.bounds.hi) / 2;
    this.startLocal = roundView.startS + center;
  }

  // Schedule a hit at intended media time plus a known injected skew. The
  // performer schedules against its estimated media origin exactly like the
  // browser client; the true clock offset only affects how the server-side
  // clock mapping reads the resulting local timestamps.
  scheduleHit(mediaTime, { skew = 0, hitId = null, captureSkew = 0 } = {}) {
    const actualMedia = mediaTime + skew;
    const id = hitId || `${this.id}-${++this.hitCounter}`;
    const fireLocal = this.startLocal + actualMedia;
    // The local clock is master time plus the true offset.
    const fireServer = fireLocal - this.clockOffset;
    this.clock.setAt(fireServer, () => {
      const presentLocal = this.startLocal + actualMedia;
      const inputLocal = presentLocal + captureSkew;
      const msg = {
        kind: 'hit',
        hitId: id,
        roundId: this.roundId,
        inputLocal,
        presentLocal,
        localMedia: inputLocal - this.startLocal
      };
      this.sent.push(msg);
      this.transport.sendUp(this, msg, (client, m, recvS) => {
        const ack = client.session.handleHit(client.id, m);
        client.acks.push({ kind: 'hit', hitId: m.hitId, ack, recvS });
      });
    });
    return id;
  }

  // Re-send the exact same payload (same hitId). Must never count twice.
  retransmit(msg, extraDelay = 0) {
    this.clock.setAt(this.clock.now() + extraDelay, () => {
      this.transport.sendUp(this, msg, (client, m, recvS) => {
        const ack = client.session.handleHit(client.id, m);
        client.acks.push({ kind: 'hit', hitId: m.hitId, ack, recvS, retransmit: true });
      });
    });
  }
}

export { CHART };
