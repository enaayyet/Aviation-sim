// Lesson engine tests: every lesson sets up and runs; scripted "students" can complete key lessons.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FS, fly, Autopilot } = require('./helpers');
const { U, M } = FS;
const FT = 3.28084;

/** Minimal stand-in for the browser App: just enough for lessons to set themselves up. */
function harness(lesson) {
  const S = lesson.setup;
  const wx = new FS.Weather(Object.assign(FS.Weather.defaults(), S.useSettings ? FS.lessonHelpers.FIELD : S.weather || {}));
  const ac = new FS.Aircraft(FS.PA28, wx);
  ac.setLoading(S.useSettings ? FS.lessonHelpers.LOAD_NORMAL : S.loading || FS.lessonHelpers.LOAD_NORMAL);
  const world = new FS.World();
  let ctl = S.ground ? ac.placeOnGround(S.ground.n, S.ground.e, S.ground.hdg) : ac.placeInAir(S.air);
  ac.kollsman = wx.cfg.qnhInHg;
  const sim = {
    toast() {},
    reloadInAir(loading) {
      const t = ac.telemetry();
      ac.setLoading(loading);
      Object.assign(ctl, ac.placeInAir({ n: t.n, e: t.e, altFt: t.altMSL, hdg: t.hdg, ias: 100 }));
    },
  };
  const runner = new FS.LessonRunner(lesson, ac, world, sim);
  let debrief = null;
  runner.onFinish = (d) => (debrief = d);
  runner.start(ac.telemetry());
  const run = (secs, pilot) => {
    fly(ac, ctl, secs, (t, c, dt) => pilot && pilot(t, c, dt, runner), (t, events, dt) => {
      runner.update(t, dt, events);
      if (runner.done) return false;
    });
    return debrief;
  };
  return { ac, ctl, runner, run, world, get debrief() { return debrief; } };
}

test('every lesson is well-formed and survives 20 s of neutral controls', () => {
  assert.ok(FS.LESSONS.length >= 18);
  const ids = new Set();
  for (const l of FS.LESSONS) {
    assert.ok(!ids.has(l.id), `duplicate id ${l.id}`);
    ids.add(l.id);
    assert.ok(l.title && l.group && l.briefing && l.steps.length, l.id);
    const h = harness(l);
    h.run(20, (t, c, dt, r) => {
      if (r.step && r.step.manual && r.ctx.stepTime > 3) r.ack();
    });
    const t = h.ac.telemetry();
    for (const k of ['ias', 'altInd', 'pitch', 'bank', 'rpm']) assert.ok(Number.isFinite(t[k]), `${l.id}: ${k}=${t[k]}`);
  }
});

test('lesson targets and step text resolve for every step', () => {
  for (const l of FS.LESSONS) {
    const h = harness(l);
    for (let i = 0; i < l.steps.length; i++) {
      h.runner.i = i;
      h.runner.ctx.alt0 = 3500;
      const txt = h.runner.text();
      assert.ok(typeof txt === 'string' && txt.length > 5, `${l.id} step ${i}`);
      h.runner.targets();
    }
  }
});

test('student completes Normal Takeoff & Climb with a satisfactory grade', () => {
  const l = FS.LESSONS.find((x) => x.id === 'takeoff');
  const h = harness(l);
  const ap = new Autopilot();
  const d = h.run(240, (t, c, dt) => {
    c.parkingBrake = false;
    c.throttle = 1;
    if (t.onGround) {
      c.rudder = M.clamp(0.12 * M.wrap180(0 - t.hdg) - 0.08 * t.r - 0.03 * t.e, -1, 1);
      if (t.ias > 55) ap.pitch(t, c, 8, dt);
      else c.elevator = 0;
      ap.bank(t, c, 0);
    } else {
      if (t.agl < 60) ap.pitch(t, c, 8, dt);
      else ap.speedPitch(t, c, 79, dt);
      ap.heading(t, c, 0, 10);
    }
  });
  assert.ok(d, 'lesson finished');
  assert.ok(d.completed, 'all steps completed');
  const fails = d.items.filter((i) => i.status === 'fail');
  assert.equal(fails.length, 0, JSON.stringify(fails));
});

test('student completes Straight-and-Level (with speed changes)', () => {
  const l = FS.LESSONS.find((x) => x.id === 'straight-level');
  const h = harness(l);
  const ap = new Autopilot();
  const d = h.run(400, (t, c, dt, r) => {
    const tg = r.targets() || {};
    ap.altSpeed(t, c, 3500, tg.ias || 100, dt);
    ap.heading(t, c, 90, 10);
  });
  assert.ok(d && d.completed, 'completed');
  const fails = d.items.filter((i) => i.status === 'fail');
  assert.equal(fails.length, 0, JSON.stringify(fails));
});

test('student completes Steep Turns within ACS tolerances', () => {
  const l = FS.LESSONS.find((x) => x.id === 'steep-turns');
  const h = harness(l);
  const ap = new Autopilot();
  let dir = -1;
  const d = h.run(300, (t, c, dt, r) => {
    const i = r.i;
    if (i >= 3) dir = 1;
    const rolling = i === 0 || i === 1 || i === 4 || i === 5;
    ap.bank(t, c, rolling ? 45 * dir : 0);
    ap.coordinate(t, c);
    const pt = M.clamp(0.03 * (3500 - t.altInd) - 0.004 * t.vs + t.alpha * (rolling ? 1.0 : 0.9) + (rolling ? 2.5 : 0), -8, 15);
    ap.pitch(t, c, pt, dt);
    const e = 100 - t.ias;
    c.throttle = M.clamp((rolling ? 0.8 : 0.66) + 0.04 * e, 0, 1);
  });
  assert.ok(d && d.completed, 'completed');
  const fails = d.items.filter((i) => i.status === 'fail');
  assert.equal(fails.length, 0, JSON.stringify(d.items, null, 1));
});

test('student lands from a stabilized final and the landing is graded', () => {
  const l = FS.LESSONS.find((x) => x.id === 'xwind-landing');
  // same lesson geometry, but calm air so the scripted student can focus on the flare
  const calm = Object.assign({}, l, { setup: Object.assign({}, l.setup, { weather: FS.lessonHelpers.FIELD }) });
  const h = harness(calm);
  const ap = new Autopilot();
  const d = h.run(240, (t, c, dt) => {
    c.flaps = 40;
    const dist = Math.max(0, 305 - t.n); // to aim point (m)
    const glideAlt = 600 + Math.tan(3 * U.DEG) * dist * FT;
    if (t.agl > 18 && !t.onGround) {
      // fly the 3-degree path: pitch for path, power for 66 kt
      const vsCmd = -Math.tan(3 * U.DEG) * t.gs * 101.27 + 2.5 * (glideAlt - t.altInd);
      ap.pitch(t, c, M.clamp(t.alpha - 3 + 0.004 * (vsCmd - t.vs) * 10, -10, 12), dt);
      c.throttle = M.clamp(0.4 + 0.05 * (66 - t.ias), 0, 1);
    } else if (!t.onGround) {
      // flare: idle, progressively raise the nose to arrest the sink
      c.throttle = 0;
      ap.pitch(t, c, M.clamp(2 + (18 - t.agl) * 0.45 + (-t.vs - 150) * 0.01, 0, 10), dt);
    } else {
      c.throttle = 0;
      c.elevator = 0.3;
      c.brakeL = c.brakeR = t.gs < 45 ? 1 : 0;
    }
    ap.heading(t, c, M.wrap180(-0.05 * t.e * FT), 12);
    if (t.onGround) c.rudder = M.clamp(-0.05 * t.e - 0.1 * M.wrap180(t.hdg), -1, 1);
  });
  assert.ok(d, 'lesson finished');
  assert.ok(!h.ac.crashed, h.ac.crashed);
  const td = h.ac.touchdown;
  assert.ok(td, 'touched down');
  assert.ok(td.vsFpm < 600, `sink ${td.vsFpm}`);
  assert.ok(d.items.some((i) => i.label === 'Touchdown sink rate'));
  assert.ok(d.items.some((i) => i.label === 'Centreline at touchdown'));
});

test('crash ends a lesson with a failing debrief', () => {
  const l = FS.LESSONS.find((x) => x.id === 'straight-level');
  const h = harness(l);
  const d = h.run(200, (t, c) => {
    c.elevator = -1;
    c.throttle = 1;
  });
  assert.ok(d && d.overall === 'fail' && /CRASH/.test(d.failReason || ''), JSON.stringify(d && d.failReason));
});

test('weight & balance lesson swaps the load in flight', () => {
  const l = FS.LESSONS.find((x) => x.id === 'weight-balance');
  const h = harness(l);
  const cgAft = h.ac.cgIn;
  h.runner.ack();
  h.run(1);
  assert.ok(h.ac.cgIn < cgAft - 4, `cg ${cgAft} -> ${h.ac.cgIn}`);
  assert.ok(h.ac.staticMargin > 0.12);
});
