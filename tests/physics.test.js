// Physics sanity & POH-calibration tests.  Run: npm test   (or: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { FS, makeSim, fly, Autopilot } = require('./helpers');
const { U } = FS;

const GROSS = { front: 340, rear: 340, baggage: 0, fuelGal: 40 };

test('standard atmosphere matches ISA', () => {
  const wx = new FS.Weather({ fieldElevFt: 0, tempC: 15, qnhInHg: 29.92 });
  const sl = wx.at(0);
  assert.ok(Math.abs(sl.rho - 1.225) < 0.002, `rho0 ${sl.rho}`);
  const a5 = wx.at(5000 * U.FT);
  assert.ok(Math.abs(a5.rho - 1.0555) < 0.004, `rho 5000ft ${a5.rho}`);
  assert.ok(Math.abs(a5.densityAlt / U.FT - 5000) < 60);
  // hot & high: 5,500 ft field at 35 C -> density altitude ~ 9,000+ ft
  const hot = new FS.Weather({ fieldElevFt: 5500, tempC: 35, qnhInHg: 29.92 });
  const da = hot.at(hot.fieldElev).densityAlt / U.FT;
  assert.ok(da > 8800 && da < 9900, `DA ${da}`);
});

test('altimeter reads field elevation when set to QNH', () => {
  const wx = new FS.Weather({ fieldElevFt: 600, tempC: 15, qnhInHg: 30.12 });
  const p = wx.at(wx.fieldElev).P;
  const ind = wx.indicatedAltitude(p, 30.12) / U.FT;
  assert.ok(Math.abs(ind - 600) < 15, `indicated ${ind}`);
  // "high to low, look out below": wrong (higher) setting reads too high
  const wrong = wx.indicatedAltitude(p, 30.42) / U.FT;
  assert.ok(wrong > ind + 250);
});

test('weight & balance arithmetic', () => {
  const { ac } = makeSim();
  const r = ac.computeWB({ front: 340, rear: 0, baggage: 0, fuelGal: 0 });
  const exp = (1520 * 86.2 + 340 * 80.5) / 1860;
  assert.ok(Math.abs(r.cgIn - exp) < 1e-6);
  assert.ok(r.ok);
  const over = ac.computeWB({ front: 400, rear: 400, baggage: 100, fuelGal: 48 });
  assert.ok(!over.ok && over.problems.some((p) => /gross/.test(p)));
});

test('trim solver converges across the speed range', () => {
  const { ac } = makeSim({}, GROSS);
  for (const ias of [60, 75, 90, 110]) {
    const t = ac.solveTrim({ altMSL: 3000 * U.FT, ias, gamma: 0 });
    const res = Math.abs(t.residual[0]) + Math.abs(t.residual[1]) + Math.abs(t.residual[2]);
    assert.ok(res < 1e-5, `ias ${ias} residual ${res}`);
    assert.ok(t.throttle > 0.2 && t.throttle < 1, `throttle ${t.throttle}`);
  }
});

test('POH performance: climb, glide, cruise, top speed', () => {
  const { ac } = makeSim({ fieldElevFt: 0 }, GROSS);
  const climb = ac.solveTrim({ altMSL: 0, ias: 79, throttle: 1 });
  const roc = (climb.tas * Math.sin(climb.gamma)) / U.FPM;
  assert.ok(roc > 580 && roc < 800, `Vy climb ${roc} fpm (POH ~640)`);
  const glide = ac.solveTrim({ altMSL: 300, ias: 73, throttle: 0 });
  const ratio = 1 / Math.tan(-glide.gamma);
  assert.ok(ratio > 9 && ratio < 11.8, `glide ratio ${ratio}`);
  const fast = ac.solveTrim({ altMSL: 0, ias: 118, throttle: 1 });
  assert.ok(fast.gamma > 0, 'can hold 118 KIAS level at full throttle');
  const tooFast = ac.solveTrim({ altMSL: 0, ias: 132, throttle: 1 });
  assert.ok(tooFast.gamma < 0, 'cannot hold 132 KIAS level');
});

test('stall: clean ~51 KIAS and full flaps ~44 KIAS (slow deceleration)', () => {
  for (const [flaps, lo, hi] of [[0, 47, 56], [40, 40, 49]]) {
    const { ac } = makeSim({}, GROSS);
    const ctl = ac.placeInAir({ altFt: 4000, ias: 80, hdg: 0, flaps });
    const ap = new Autopilot();
    let stallIas = null;
    ctl.throttle = 0;
    fly(ac, ctl, 90, (t, c, dt) => {
      // hold altitude with pitch; with idle power this bleeds ~1 kt/s, like the real maneuver
      const pt = Math.min(25, 0.05 * (4000 - t.altInd) + t.alpha + 2);
      ap.pitch(t, c, pt, dt);
      ap.bank(t, c, 0);
      ap.coordinate(t, c);
    }, (t) => {
      if (t.stalled && stallIas === null) {
        stallIas = t.ias;
        return false;
      }
    });
    assert.ok(stallIas !== null, `flaps ${flaps}: never stalled`);
    assert.ok(stallIas > lo && stallIas < hi, `flaps ${flaps}: stalled at ${stallIas.toFixed(1)} KIAS`);
  }
});

test('stall warning sounds before the stall', () => {
  const { ac } = makeSim({}, GROSS);
  const ctl = ac.placeInAir({ altFt: 4000, ias: 75, hdg: 0 });
  ctl.throttle = 0;
  const ap = new Autopilot();
  let warnIas = null, stallIas = null;
  fly(ac, ctl, 90, (t, c, dt) => {
    ap.pitch(t, c, Math.min(25, 0.05 * (4000 - t.altInd) + t.alpha + 2), dt);
    ap.bank(t, c, 0);
  }, (t) => {
    if (t.stallWarn && warnIas === null) warnIas = t.ias;
    if (t.stalled) {
      stallIas = t.ias;
      return false;
    }
  });
  assert.ok(warnIas - stallIas > 2.5 && warnIas - stallIas < 12, `warn ${warnIas} stall ${stallIas}`);
});

test('trimmed cruise is stable hands-off for a minute', () => {
  const { ac } = makeSim({}, { front: 340, rear: 0, baggage: 20, fuelGal: 40 });
  const ctl = ac.placeInAir({ altFt: 3500, ias: 100, hdg: 90 });
  const t0 = ac.telemetry();
  let maxDev = 0;
  const t = fly(ac, ctl, 60, null, (tt) => {
    maxDev = Math.max(maxDev, Math.abs(tt.altInd - t0.altInd));
  });
  assert.ok(maxDev < 150, `altitude wandered ${maxDev} ft`);
  assert.ok(Math.abs(t.ias - 100) < 6, `ias ${t.ias}`);
  assert.ok(Math.abs(t.bank) < 15, `bank ${t.bank}`);
});

test('fixed-pitch prop: RPM rises in a dive at constant throttle', () => {
  const { ac } = makeSim();
  const ctl = ac.placeInAir({ altFt: 5000, ias: 90, hdg: 0 });
  const rpm0 = ac.telemetry().rpm;
  const ap = new Autopilot();
  const t = fly(ac, ctl, 20, (t, c, dt) => ap.pitch(t, c, -8, dt));
  assert.ok(t.ias > 110 && t.rpm > rpm0 + 150, `ias ${t.ias} rpm ${rpm0}->${t.rpm}`);
});

test('parked airplane stays put and level on its gear', () => {
  const { ac } = makeSim();
  const ctl = ac.placeOnGround(0, 0, 0);
  const t = fly(ac, ctl, 10, null);
  assert.ok(t.onGround && t.mainsOnGround && t.noseOnGround);
  assert.ok(Math.abs(t.pitch) < 2 && Math.abs(t.bank) < 1, `pitch ${t.pitch} bank ${t.bank}`);
  assert.ok(Math.hypot(t.n, t.e) < 0.5, `drifted ${t.n},${t.e}`);
  assert.ok(!ac.crashed);
});

function takeoffRoll(wxCfg, loading, flaps = 0) {
  const { ac } = makeSim(wxCfg, loading);
  const ctl = ac.placeOnGround(0, 0, 0, { flaps });
  ctl.flaps = flaps;
  ctl.parkingBrake = false;
  ctl.throttle = 1;
  const ap = new Autopilot();
  let lift = null;
  fly(ac, ctl, 90, (t, c, dt) => {
    c.rudder = FS.M.clamp(0.12 * FS.M.wrap180(0 - t.hdg) - 0.08 * t.r - 0.02 * t.e, -1, 1);
    if (t.ias > 54 || !t.onGround) ap.pitch(t, c, 9, dt);
    ap.bank(t, c, 0);
  }, (t, events) => {
    for (const e of events) if (e.type === 'liftoff' && !lift) lift = e.data;
    if (lift && t.agl > 20) return false;
  });
  return { lift, ac };
}

test('takeoff: realistic ground roll and stays on the centreline', () => {
  const { lift, ac } = takeoffRoll({ fieldElevFt: 0, windKt: 0 }, GROSS);
  assert.ok(!ac.crashed, ac.crashed);
  assert.ok(lift, 'lifted off');
  const ft = lift.n / U.FT;
  assert.ok(ft > 850 && ft < 1700, `ground roll ${ft} ft`);
  assert.ok(Math.abs(lift.e) < 6, `centreline ${lift.e} m`);
});

test('density altitude roughly doubles the takeoff roll', () => {
  const sl = takeoffRoll({ fieldElevFt: 0, tempC: 15 }, GROSS).lift.n;
  const hot = takeoffRoll({ fieldElevFt: 5500, tempC: 35 }, GROSS).lift.n;
  assert.ok(hot / sl > 1.5 && hot / sl < 2.8, `ratio ${hot / sl}`);
});

test('a hard arrival is detected as a crash, a gentle one is a touchdown', () => {
  for (const [vs, crash] of [[200, false], [1500, true]]) {
    const { ac } = makeSim();
    const ctl = ac.placeInAir({ altFt: 600 + 8, ias: 62, hdg: 0, flaps: 40 });
    // force a sink rate just above the runway
    ac.s.vel[2] = vs * U.FPM;
    ac.s.q = FS.quat.fromEuler(0, 4 * U.DEG, 0);
    ctl.throttle = 0;
    const ap = new Autopilot();
    let td = null;
    fly(ac, ctl, 20, (t, c, dt) => ap.pitch(t, c, 4, dt), (t, ev) => {
      for (const e of ev) if (e.type === 'touchdown') td = e.data;
      if (td && t.gs < 40) return false;
    });
    assert.ok(td, 'touched down');
    assert.equal(!!ac.crashed, crash, `vs ${vs}: crashed=${ac.crashed} td vs ${td && td.vsFpm}`);
  }
});

test('ground effect cuts induced drag near the runway', () => {
  const { ac } = makeSim();
  ac.placeInAir({ altFt: 600 + 500, ias: 65, hdg: 0 });
  const hi = ac.computeForces(ac.s, ac.ctl, { noWind: true });
  ac.s.pos[2] = -1.6;
  const lo = ac.computeForces(ac.s, ac.ctl, { noWind: true });
  assert.ok(lo.phiGE < 0.75 && lo.drag < hi.drag * 0.92, `phi ${lo.phiGE} drag ${hi.drag}->${lo.drag}`);
});

test('uncoordinated full-power stall drops a wing', () => {
  const { ac } = makeSim();
  const ctl = ac.placeInAir({ altFt: 5000, ias: 65, hdg: 0 });
  ctl.throttle = 1;
  ctl.rudder = -0.6; // left rudder skid
  const ap = new Autopilot();
  let maxBank = 0, stalled = false;
  fly(ac, ctl, 25, (t, c, dt) => {
    ap.pitch(t, c, 25, dt);
    c.aileron = 0;
  }, (t) => {
    if (t.stalled) stalled = true;
    if (stalled) maxBank = Math.max(maxBank, Math.abs(t.bank));
  });
  assert.ok(stalled, 'stalled');
  assert.ok(maxBank > 25, `max bank after skidding stall ${maxBank}`);
});
