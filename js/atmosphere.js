/*
 * atmosphere.js — the air the airplane flies in.
 *
 *  - Non-standard atmosphere built from the field's altimeter setting (QNH) and surface temperature,
 *    so density altitude, true-vs-indicated altitude and true-vs-indicated airspeed all fall out of real physics.
 *  - Wind with a logarithmic boundary-layer profile (slower near the ground), gusts and Dryden-style turbulence.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { U, M } = FS;

  const ISA = {
    T0: 288.15, // K
    P0: 101325, // Pa
    RHO0: 1.225, // kg/m^3
    L: 0.0065, // K/m lapse rate
    R: 287.053, // J/(kg K)
    g: 9.80665,
  };
  ISA.EXP = ISA.g / (ISA.R * ISA.L); // 5.2559

  /** Altitude (m) in the *standard* atmosphere at which pressure equals p, given reference sea-level pressure pRef. */
  function pressureToAltitude(p, pRef) {
    return (ISA.T0 / ISA.L) * (1 - Math.pow(p / pRef, 1 / ISA.EXP));
  }
  /** Density altitude (m) for a given density. */
  function densityAltitude(rho) {
    return (ISA.T0 / ISA.L) * (1 - Math.pow(rho / ISA.RHO0, 1 / (ISA.EXP - 1)));
  }

  /**
   * Weather: one object holds everything about the air mass.
   * cfg: { fieldElevFt, qnhInHg, tempC (at the field), windDir (deg, FROM), windKt, gustKt, turbulence (0..1), seed }
   */
  class Weather {
    constructor(cfg) {
      this.turb = [0, 0, 0];
      this.turbP = 0; // rolling-gust (rad/s equivalent)
      this.gustFactor = 0;
      this.gustTarget = 0;
      this.gustTimer = 0;
      this.time = 0;
      this.set(cfg || {});
    }

    set(cfg) {
      const d = Weather.defaults();
      this.cfg = Object.assign({}, d, this.cfg || {}, cfg);
      const c = this.cfg;
      this.fieldElev = c.fieldElevFt * U.FT;
      this.qnh = c.qnhInHg * U.INHG;
      const Tfield = c.tempC + 273.15;
      // Temperature at sea level implied by the field temperature and the standard lapse rate.
      this.Tsl = Tfield + ISA.L * this.fieldElev;
      this.rand = M.rng(c.seed >>> 0 || 1234);
    }

    static defaults() {
      return { fieldElevFt: 500, qnhInHg: 29.92, tempC: 14, windDir: 360, windKt: 0, gustKt: 0, turbulence: 0, seed: 1234 };
    }

    /** Air properties at an altitude above mean sea level (m). */
    at(altMSL) {
      const T = Math.max(180, this.Tsl - ISA.L * altMSL);
      const P = this.qnh * Math.pow(T / this.Tsl, ISA.EXP);
      const rho = P / (ISA.R * T);
      return {
        T, // K
        P, // Pa
        rho, // kg/m^3
        sigma: rho / ISA.RHO0,
        oatC: T - 273.15,
        isaDevC: T - (ISA.T0 - ISA.L * pressureToAltitude(P, ISA.P0)),
        pressureAlt: pressureToAltitude(P, ISA.P0),
        densityAlt: densityAltitude(rho),
        speedOfSound: Math.sqrt(1.4 * ISA.R * T),
      };
    }

    /** Altitude an altimeter set to `kollsmanInHg` would show (m) at static pressure p. */
    indicatedAltitude(p, kollsmanInHg) {
      return pressureToAltitude(p, kollsmanInHg * U.INHG);
    }

    /** Advance gusts and turbulence. `tas` in m/s sets the turbulence time scale (frozen-turbulence assumption). */
    update(dt, tas, hAGL) {
      this.time += dt;
      const c = this.cfg;
      const r = this.rand;
      // --- gusts: a slowly wandering factor between 0 (steady wind) and 1 (full gust)
      if (c.gustKt > c.windKt) {
        this.gustTimer -= dt;
        if (this.gustTimer <= 0) {
          this.gustTimer = r.range(1.5, 6);
          this.gustTarget = r() < 0.45 ? r.range(0.4, 1) : r.range(0, 0.25);
        }
        this.gustFactor = M.lowpass(this.gustFactor, this.gustTarget, dt, 1.2);
      } else {
        this.gustFactor = 0;
      }
      // --- Dryden-like turbulence: first-order filtered white noise on each axis
      const intensity = c.turbulence; // 0..1  (0.35 = light, 0.7 = moderate, 1 = severe-ish)
      const sigma = intensity * 2.6; // m/s
      if (sigma > 0) {
        const lowFactor = M.clamp((hAGL + 15) / 80, 0.35, 1); // mechanical turbulence scales near the ground
        const Lu = 180; // m length scale
        const V = Math.max(tas, 15);
        const tau = Lu / V;
        const k = Math.sqrt((2 * dt) / tau);
        for (let i = 0; i < 3; i++) {
          const s = sigma * lowFactor * (i === 2 ? 0.75 : 1);
          this.turb[i] += (-this.turb[i] / tau) * dt + s * k * r.gauss();
        }
        const tauP = 0.6;
        this.turbP += (-this.turbP / tauP) * dt + intensity * 0.12 * lowFactor * Math.sqrt((2 * dt) / tauP) * r.gauss();
      } else {
        this.turb[0] = this.turb[1] = this.turb[2] = 0;
        this.turbP = 0;
      }
    }

    /** Mean wind speed (kt) at height above ground, log boundary layer, normalised to the 10 m reported wind. */
    windSpeedAt(hAGL) {
      const c = this.cfg;
      const base = c.windKt + (Math.max(c.gustKt, c.windKt) - c.windKt) * this.gustFactor;
      const z0 = 0.05; // roughness length for grass/farmland
      const h = Math.max(hAGL, 0.3);
      const f = M.clamp(Math.log(h / z0) / Math.log(10 / z0), 0.35, 1.45);
      return base * f;
    }

    /** Wind vector in world NED (m/s) — the velocity of the air mass, including turbulence. */
    windAt(hAGL) {
      const c = this.cfg;
      const spd = this.windSpeedAt(hAGL) * U.KT;
      const to = (c.windDir + 180) * U.DEG; // air moves TOWARD this heading
      return [
        Math.cos(to) * spd + this.turb[0],
        Math.sin(to) * spd + this.turb[1],
        this.turb[2],
      ];
    }

    /** Head/cross wind components (kt) for a runway heading — positive crosswind = from the right. */
    components(rwyHdgDeg) {
      const c = this.cfg;
      const ang = (c.windDir - rwyHdgDeg) * U.DEG;
      return { head: c.windKt * Math.cos(ang), cross: c.windKt * Math.sin(ang) };
    }

    describe() {
      const c = this.cfg;
      const a = this.at(this.fieldElev);
      const wind = c.windKt < 1 ? 'Calm' : `${String(Math.round(c.windDir)).padStart(3, '0')}° @ ${Math.round(c.windKt)} kt` + (c.gustKt > c.windKt ? ` G${Math.round(c.gustKt)}` : '');
      return {
        wind,
        tempC: c.tempC,
        qnh: c.qnhInHg.toFixed(2),
        densityAltFt: Math.round(a.densityAlt / U.FT),
        pressureAltFt: Math.round(a.pressureAlt / U.FT),
      };
    }
  }

  FS.ISA = ISA;
  FS.Weather = Weather;
  FS.pressureToAltitude = pressureToAltitude;
  FS.densityAltitude = densityAltitude;
})();
