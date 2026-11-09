// Prints the simulated airplane's performance next to POH numbers. Run: node tools/calibrate.js
const FS = require('./load');
const { U } = FS;

function mk(cfg = {}, loading) {
  const wx = new FS.Weather(Object.assign({ fieldElevFt: 0, tempC: 15, qnhInHg: 29.92 }, cfg));
  const ac = new FS.Aircraft(FS.PA28, wx);
  ac.setLoading(loading || { front: 340, rear: 340, baggage: 0, fuelGal: 40 }); // near gross
  return ac;
}

const ac = mk();
console.log('Weight', ac.wb.weightLb.toFixed(0), 'lb  CG', ac.cgIn.toFixed(1), 'in  SM', ac.staticMargin.toFixed(3));

// level flight table at sea level
console.log('\nLevel flight, sea level, gross:');
for (const ias of [55, 60, 65, 73, 79, 90, 100, 110, 120]) {
  const t = ac.solveTrim({ altMSL: 0, ias, gamma: 0, flaps: 0 });
  console.log(`  ${ias} KIAS: alpha ${(t.alpha * U.RAD).toFixed(1)}°  trim ${t.trim.toFixed(2)}  thr ${t.throttle.toFixed(2)}  rpm ${t.rpm.toFixed(0)}  T ${(t.thrust / U.LBF).toFixed(0)} lbf D ${(t.drag / U.LBF).toFixed(0)} lbf  eta ${t.eta.toFixed(2)} res ${t.residual.map((r) => r.toExponential(1)).join(',')}`);
}

// full throttle level speed
const vmax = ac.solveTrim({ altMSL: 0, ias: 125, throttle: 1 });
console.log('\nFull throttle at 125 KIAS: gamma', (vmax.gamma * U.RAD).toFixed(2), 'rpm', vmax.rpm.toFixed(0));
for (let ias = 110; ias <= 140; ias += 2) {
  const t = ac.solveTrim({ altMSL: 0, ias, throttle: 1 });
  if (t.gamma < 0) {
    console.log('  Vmax SL ~', ias, 'KIAS at', t.rpm.toFixed(0), 'rpm');
    break;
  }
}

// climb
console.log('\nFull-throttle climb, sea level:');
for (const ias of [63, 70, 79, 85, 90]) {
  const t = ac.solveTrim({ altMSL: 0, ias, throttle: 1 });
  const roc = t.tas * Math.sin(t.gamma) / U.FPM;
  console.log(`  ${ias} KIAS: ROC ${roc.toFixed(0)} fpm  gamma ${(t.gamma * U.RAD).toFixed(1)}°  rpm ${t.rpm.toFixed(0)} pitch ${((t.alpha + t.gamma) * U.RAD).toFixed(1)}°`);
}
for (const alt of [5000, 8000]) {
  const t = ac.solveTrim({ altMSL: alt * U.FT, ias: 79, throttle: 1 });
  console.log(`  at ${alt} ft: ROC ${(t.tas * Math.sin(t.gamma) / U.FPM).toFixed(0)} fpm`);
}

// glide
console.log('\nIdle glide:');
for (const ias of [65, 70, 73, 76, 80, 90]) {
  const t = ac.solveTrim({ altMSL: 1000, ias, throttle: 0 });
  console.log(`  ${ias} KIAS: ratio ${(1 / Math.tan(-t.gamma)).toFixed(1)}  sink ${(-t.tas * Math.sin(t.gamma) / U.FPM).toFixed(0)} fpm  rpm ${t.rpm.toFixed(0)}`);
}
ac.engineFailed = true;
const tg = ac.solveTrim({ altMSL: 1000, ias: 73, throttle: 0 });
console.log(`  engine dead, 73 KIAS: ratio ${(1 / Math.tan(-tg.gamma)).toFixed(1)}  windmill rpm ${tg.rpm.toFixed(0)}`);
ac.engineFailed = false;

// cruise at 8000 ft
console.log('\nCruise 8000 ft:');
for (const thr of [0.6, 0.7, 0.8, 1]) {
  let lo = 60, hi = 150;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const t = ac.solveTrim({ altMSL: 8000 * U.FT, ias: mid, throttle: thr });
    if (t.gamma > 0) lo = mid;
    else hi = mid;
  }
  const t = ac.solveTrim({ altMSL: 8000 * U.FT, ias: lo, throttle: thr });
  const hp = t.thrust * t.tas / Math.max(0.01, t.eta) / U.HP;
  console.log(`  thr ${thr}: ${lo.toFixed(0)} KIAS / ${(t.tas / U.KT).toFixed(0)} KTAS rpm ${t.rpm.toFixed(0)} ~${hp.toFixed(0)} hp (${((hp / 160) * 100).toFixed(0)}%)`);
}

// static rpm
const wx = ac.wx.at(0);
const om = ac.equilibriumOmega(1, 0, wx.rho, wx.sigma);
const st = ac.propeller(0, om, wx.rho);
console.log('\nStatic full-throttle rpm', ((om * 60) / (2 * Math.PI)).toFixed(0), 'thrust', (st.T / U.LBF).toFixed(0), 'lbf');
const omi = ac.equilibriumOmega(0, 0, wx.rho, wx.sigma);
console.log('Idle rpm', ((omi * 60) / (2 * Math.PI)).toFixed(0), 'idle thrust', (ac.propeller(0, omi, wx.rho).T / U.LBF).toFixed(0), 'lbf');

// stall speeds (CLmax quasi-static)
for (const fl of [0, 10, 25, 40]) {
  const a = FS.PA28.aero;
  const inc = a.flaps.find((x) => x.deg === fl);
  const clmax = a.CLmax + inc.dCLmax;
  const W = ac.mass * U.G;
  const v = Math.sqrt((2 * W) / (1.225 * FS.PA28.geom.S * clmax)) / U.KT;
  console.log(`Stall (CLmax ${clmax.toFixed(2)}) flaps ${fl}: ${v.toFixed(1)} KIAS`);
}

// takeoff roll
function takeoff(cfg, loading, flaps = 0, vr = 55) {
  const ac = mk(cfg, loading);
  const ctl = ac.placeOnGround(0, 0, 0, { flaps });
  ctl.flaps = flaps;
  ctl.parkingBrake = false;
  ctl.throttle = 1;
  let liftoff = null;
  let n0 = ac.s.pos[0];
  let t50 = null;
  for (let i = 0; i < 60 * 120; i++) {
    const t = ac.telemetry();
    // simple pilot: rotate at 55, then hold ~ 8° pitch / climb at Vx-ish
    if (t.ias > vr || !t.onGround) {
      const target = t.onGround ? 9 : 8;
      ctl.elevator = FS.M.clamp(0.08 * (target - t.pitch) - 0.05 * t.q, -1, 1);
    } else ctl.elevator = 0;
    ctl.rudder = FS.M.clamp(-0.08 * FS.M.wrap180(t.hdg - 0) - 0.05 * t.r, -1, 1);
    ctl.aileron = FS.M.clamp(-0.05 * t.bank - 0.02 * t.p, -1, 1);
    ac.step(1 / 120, ctl);
    if (ac.crashed) { console.log('crash', ac.crashed); break; }
    if (!liftoff && !ac.onGround && ac.lastAirborne > 0.2) liftoff = { d: ac.s.pos[0] - n0, ias: t.ias, time: ac.time, pitch: t.pitch };
    if (liftoff && t.agl > 50 && !t50) { t50 = { d: ac.s.pos[0] - n0 }; break; }
  }
  return { liftoff, t50 };
}
const to = takeoff({});
console.log('\nTakeoff SL std gross: ground roll', (to.liftoff.d / U.FT).toFixed(0), 'ft liftoff', to.liftoff.ias.toFixed(0), 'KIAS pitch', to.liftoff.pitch.toFixed(1), 'over 50 ft', to.t50 && (to.t50.d / U.FT).toFixed(0), 'ft');
const to25 = takeoff({}, undefined, 25, 50);
console.log('Takeoff SL flaps 25 rotate 50: ground roll', (to25.liftoff.d / U.FT).toFixed(0), 'ft liftoff', to25.liftoff.ias.toFixed(0), 'KIAS, over 50 ft', to25.t50 && (to25.t50.d / U.FT).toFixed(0), 'ft  (POH 975 / 1490)');
const to2 = takeoff({ fieldElevFt: 5000, tempC: 35 });
console.log('Takeoff 5000 ft 35°C: ground roll', (to2.liftoff.d / U.FT).toFixed(0), 'ft, over 50 ft', to2.t50 && (to2.t50.d / U.FT).toFixed(0), 'ft');

// hands-off stability: trimmed cruise, 60s
{
  const ac = mk();
  const ctl = ac.placeInAir({ altFt: 3000, ias: 100, hdg: 0 });
  const t0 = ac.telemetry();
  let maxDev = 0;
  for (let i = 0; i < 120 * 60; i++) {
    ac.step(1 / 120, ctl);
    maxDev = Math.max(maxDev, Math.abs(ac.telemetry().altMSL - t0.altMSL));
  }
  const t = ac.telemetry();
  console.log('\nHands-off 60s from trim: alt dev max', maxDev.toFixed(0), 'ft; ias', t.ias.toFixed(1), 'hdg', t.hdg.toFixed(1), 'bank', t.bank.toFixed(1));
}
