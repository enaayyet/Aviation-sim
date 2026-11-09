// Shared test helpers: load the sim into Node and provide a simple autopilot "student pilot".
const FS = require('../tools/load');
const { M } = FS;
const { clamp, wrap180 } = M;

function makeSim(weatherCfg = {}, loading) {
  const wx = new FS.Weather(Object.assign({ fieldElevFt: 600, tempC: 15, qnhInHg: 29.92 }, weatherCfg));
  const ac = new FS.Aircraft(FS.PA28, wx);
  if (loading) ac.setLoading(loading);
  return { wx, ac };
}

/** Step the sim for `secs` at 60 Hz, calling `pilot(t, ctl, dt)` each frame. Returns final telemetry. */
function fly(ac, ctl, secs, pilot, onFrame) {
  const dt = 1 / 60;
  let t = ac.telemetry();
  for (let i = 0; i < secs * 60; i++) {
    if (pilot) pilot(t, ctl, dt);
    ac.wx.update(dt, t.tas * 0.514444, t.agl * 0.3048);
    ac.step(dt, ctl);
    t = ac.telemetry();
    const events = ac.events;
    ac.events = [];
    if (onFrame && onFrame(t, events, dt) === false) break;
    if (ac.crashed) break;
  }
  return t;
}

/** A PID-ish autopilot that flies like a careful student. */
class Autopilot {
  constructor() {
    this.iPitch = 0;
    this.iSpd = 0;
    this.iAlt = 0;
  }
  /** Pitch attitude hold (deg). */
  pitch(t, ctl, target, dt) {
    const e = target - t.pitch;
    this.iPitch = clamp(this.iPitch + e * dt * 0.06, -0.6, 0.6);
    ctl.elevator = clamp(0.09 * e - 0.05 * t.q + this.iPitch, -1, 1);
  }
  bank(t, ctl, target) {
    ctl.aileron = clamp(0.045 * (target - t.bank) - 0.02 * t.p, -1, 1);
  }
  coordinate(t, ctl) {
    ctl.rudder = clamp(0.04 * t.ball, -1, 1);
  }
  heading(t, ctl, hdg, maxBank = 25) {
    const err = wrap180(hdg - t.hdg);
    this.bank(t, ctl, clamp(err * 1.5, -maxBank, maxBank));
    this.coordinate(t, ctl);
  }
  /** Hold altitude with pitch, airspeed with throttle. */
  altSpeed(t, ctl, alt, ias, dt) {
    const pt = clamp(0.03 * (alt - t.altInd) - 0.004 * t.vs + this.basePitch(t), -10, 15);
    this.pitch(t, ctl, pt, dt);
    const e = ias - t.ias;
    this.iSpd = clamp(this.iSpd + e * dt * 0.01, -0.5, 0.5);
    ctl.throttle = clamp(0.55 + 0.04 * e + this.iSpd, 0, 1);
  }
  /** Hold airspeed with pitch (for climbs/descents at fixed power). */
  speedPitch(t, ctl, ias, dt) {
    if (this.spInit === undefined) {
      this.spInit = true;
      this.iAlt = t.pitch;
    }
    const e = t.ias - ias;
    this.iAlt = clamp(this.iAlt + e * dt * 0.25, -12, 18);
    this.pitch(t, ctl, clamp(this.iAlt + 0.35 * e, -12, 20), dt);
  }
  basePitch(t) {
    return t.alpha * 0.9;
  }
}

module.exports = { FS, makeSim, fly, Autopilot };
