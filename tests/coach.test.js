// The live instructor and the auto-rudder assist.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FS, makeSim, fly, Autopilot } = require('./helpers');
const { U, M } = FS;
const FT = 3.28084;

/** Fly with a Coach listening; returns the ids it called out. */
function listen(ac, ctl, secs, pilot, coach = new FS.Coach(new FS.World())) {
  const said = [];
  fly(ac, ctl, secs, pilot, (t, ev, dt) => {
    const m = coach.update(t, dt);
    if (m) said.push(m);
  });
  return { said, ids: said.map((m) => m.id), coach };
}

test('coach stays silent in trimmed hands-off cruise', () => {
  const { ac } = makeSim();
  const ctl = Object.assign(FS.neutralControls(), ac.placeInAir({ altFt: 3500, ias: 100, hdg: 0, n: -9000, e: 3000 }));
  const { ids } = listen(ac, ctl, 90);
  assert.deepEqual(ids, []);
});

test('coach calls the stall and tallies it for the debrief', () => {
  const { ac } = makeSim();
  const ctl = Object.assign(FS.neutralControls(), ac.placeInAir({ altFt: 4000, ias: 80, hdg: 0, n: -9000, e: 3000 }));
  const ap = new Autopilot();
  const { ids, coach } = listen(ac, ctl, 40, (t, c, dt) => {
    c.throttle = 0;
    c.elevator = M.clamp(c.elevator + 0.08 * dt, -1, 1);
    ap.bank(t, c, 0);
    ap.coordinate(t, c);
  });
  assert.ok(ids.includes('stall'), ids.join());
  const s = coach.summary();
  assert.ok(s.find((x) => x.id === 'stall').count >= 1);
});

test('coach asks for rudder when the ball is held out, and names the correct foot', () => {
  const { ac } = makeSim();
  const ctl = Object.assign(FS.neutralControls(), ac.placeInAir({ altFt: 3500, ias: 100, hdg: 0, n: -9000, e: 3000 }));
  const ap = new Autopilot();
  const { said } = listen(ac, ctl, 25, (t, c) => {
    c.rudder = -0.6; // left rudder held in
    ap.bank(t, c, 0);
  });
  const m = said.find((x) => x.id === 'ball');
  assert.ok(m, said.map((x) => x.id).join());
  assert.match(m.text, /right rudder/);
});

test('coach flags a low, slow approach but not a stabilized one', () => {
  const run = (altFt, ias) => {
    const { ac } = makeSim();
    const ctl = Object.assign(FS.neutralControls(), ac.placeInAir({ altFt, ias, hdg: 0, n: -1852, e: 0, flaps: 25 }));
    const ap = new Autopilot();
    return listen(ac, ctl, 12, (t, c, dt) => {
      c.flaps = 25;
      c.throttle = 0.4;
      ap.speedPitch(t, c, ias, dt);
      ap.heading(t, c, 0, 10);
    }).ids;
  };
  const low = run(600 + 130, 55);
  assert.ok(low.includes('low-path') || low.includes('slow-final'), low.join());
  const good = run(600 + 370, 68);
  assert.deepEqual(good.filter((id) => /path|final|sink/.test(id)), []);
});

test('coach has no complaints about a well-flown approach and landing', () => {
  const { ac } = makeSim();
  const ctl = Object.assign(FS.neutralControls(), ac.placeInAir({ altFt: 600 + 450, ias: 70, hdg: 0, n: -2600, e: 0, flaps: 40 }));
  const ap = new Autopilot();
  const { said } = listen(ac, ctl, 200, (t, c, dt) => {
    c.flaps = 40;
    const dist = Math.max(0, 305 - t.n);
    const glideAlt = 600 + Math.tan(3 * U.DEG) * dist * FT;
    if (t.agl > 18 && !t.onGround) {
      const vsCmd = -Math.tan(3 * U.DEG) * t.gs * 101.27 + 2.5 * (glideAlt - t.altInd);
      ap.pitch(t, c, M.clamp(t.alpha - 3 + 0.04 * (vsCmd - t.vs), -10, 12), dt);
      c.throttle = M.clamp(0.4 + 0.05 * (66 - t.ias), 0, 1);
    } else if (!t.onGround) {
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
  assert.ok(ac.touchdown && !ac.crashed, 'landed');
  assert.deepEqual(said.map((m) => `${m.id}`), []);
});

test('muted rules stay quiet (a stall lesson does not nag about the stall)', () => {
  const { ac } = makeSim();
  const ctl = Object.assign(FS.neutralControls(), ac.placeInAir({ altFt: 4000, ias: 70, hdg: 0, n: -9000, e: 3000 }));
  const coach = new FS.Coach(new FS.World());
  coach.setMuted(['stall', 'spin']);
  const ap = new Autopilot();
  const { ids } = listen(ac, ctl, 30, (t, c, dt) => {
    c.throttle = 0;
    c.elevator = M.clamp(c.elevator + 0.1 * dt, -1, 1);
    ap.bank(t, c, 0);
    ap.coordinate(t, c);
  }, coach);
  assert.ok(!ids.includes('stall'));
});

test('auto-rudder centres the ball in a full-power climb', () => {
  const climb = (assist) => {
    const { ac } = makeSim();
    const ctl = Object.assign(FS.neutralControls(), ac.placeInAir({ altFt: 2000, ias: 79, hdg: 0, n: -9000, e: 3000 }));
    const ap = new Autopilot();
    const ar = new FS.AutoRudder(new FS.World());
    let worst = 0, n = 0;
    fly(ac, ctl, 40, (t, c, dt) => {
      c.throttle = 1;
      ap.speedPitch(t, c, 79, dt);
      ap.bank(t, c, 0);
      c.rudder = assist ? ar.update(t, dt) : 0;
    }, (t) => {
      if (++n > 60 * 15) worst = Math.max(worst, Math.abs(t.ball));
    });
    return worst;
  };
  const without = climb(false), withIt = climb(true);
  assert.ok(without > 1, `no rudder: ball ${without.toFixed(1)}° — left-turning tendency should show`);
  assert.ok(withIt < 0.4, `auto-rudder: ball ${withIt.toFixed(2)}°`);
});

test('auto-rudder holds the centreline on the takeoff roll', () => {
  const { ac } = makeSim();
  const ctl = Object.assign(FS.neutralControls(), ac.placeOnGround(30, 0, 0, { flaps: 0 }));
  const ar = new FS.AutoRudder(new FS.World());
  let maxOff = 0;
  fly(ac, ctl, 40, (t, c, dt) => {
    c.parkingBrake = false;
    c.throttle = 1;
    c.rudder = ar.update(t, dt);
    c.elevator = t.ias > 55 ? 0.25 : 0;
  }, (t) => {
    if (t.onGround) maxOff = Math.max(maxOff, Math.abs(t.e));
    if (t.agl > 50) return false;
  });
  assert.ok(!ac.crashed, String(ac.crashed));
  assert.ok(ac.telemetry().agl > 20, 'airborne');
  assert.ok(maxOff < 3, `wandered ${maxOff.toFixed(1)} m off the centreline`);
});

// ---------------------------------------------------------------- debrief scoring
test('landing score rewards a soft touchdown in the box and punishes a hard, long, off-centre one', () => {
  const world = new FS.World();
  const D = FS.Debrief;
  const aim = world.runway.aimN;
  const good = D.landingScore({ n: aim + 40, e: 0.5, vsFpm: 120, firstGear: 'mains', pitchDeg: 5, driftKt: 0.3, crabDeg: 1 }, world, 0);
  const bad = D.landingScore({ n: aim + 500, e: 8, vsFpm: 650, firstGear: 'nose', pitchDeg: -1, driftKt: 5, crabDeg: 9 }, world, 0);
  const off = D.landingScore({ n: -80, e: 0, vsFpm: 120, firstGear: 'mains', pitchDeg: 5, driftKt: 0, crabDeg: 0 }, world, 0);
  assert.ok(good.score >= 95, `good ${good.score}`);
  assert.ok(bad.score <= 25, `bad ${bad.score}`);
  assert.ok(off.score <= 30 && !off.onRunway, `short of the runway ${off.score}`);
  // landing on 18 is measured from the other threshold
  const r18 = D.landingScore({ n: world.runway.length - aim - 40, e: -0.5, vsFpm: 120, firstGear: 'mains', pitchDeg: 5, driftKt: 0.3, crabDeg: 1 }, world, 180);
  assert.ok(r18.south && r18.score >= 95, `runway 18 ${r18.score}`);
});

test('approach trace, threshold crossing and stability come out of the recorder samples', () => {
  const world = new FS.World();
  const D = FS.Debrief;
  const samples = [];
  // a perfect 3-degree approach at 65 kt, sampled every 0.25 s
  for (let i = 0; i <= 400; i++) {
    const n = -3000 + i * 8.26;
    const agl = Math.max(0, Math.tan(3 * U.DEG) * (world.runway.aimN - n) * FT);
    samples.push({ t: i * 0.25, n, e: 0, agl, ias: 65 });
  }
  const td = { time: 100, n: world.runway.aimN, e: 0 };
  const trace = D.approachTrace(samples, td, world, 0);
  assert.ok(trace.length > 100);
  const c = D.thresholdCrossing(trace);
  assert.ok(Math.abs(c.agl - 52) < 4, `crossing height ${c.agl}`);
  const st = D.stability(trace, world);
  assert.ok(st.pathRmsFt < 2 && st.latRmsFt < 1, JSON.stringify(st));
});

test('lesson score: all pass = 100, a failed lesson is capped below 50', () => {
  const D = FS.Debrief;
  assert.equal(D.lessonScore([{ status: 'pass' }, { status: 'pass' }, { status: 'info' }]), 100);
  assert.equal(D.lessonScore([{ status: 'pass' }, { status: 'marginal' }]), 80);
  assert.ok(D.lessonScore([{ status: 'pass' }, { status: 'pass' }, { status: 'fail' }], true) <= 49);
  assert.equal(D.lessonScore([]), null);
});
