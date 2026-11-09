/*
 * physics.js — six-degree-of-freedom flight model.
 *
 * The airplane is a rigid body pushed around by four families of forces:
 *   1. Weight      — gravity acting at the centre of gravity (CG).
 *   2. Aerodynamic — lift, drag and side force from the wing/tail, computed from angle of attack (alpha),
 *                    sideslip (beta), rotation rates and control deflections via stability derivatives.
 *   3. Thrust      — from a fixed-pitch propeller driven by a piston engine. RPM is a *result*: the engine
 *                    torque and the propeller's aerodynamic torque fight it out, exactly like the real thing.
 *   4. Ground      — spring/damper struts with tyre friction, brakes and nose-wheel steering.
 *
 * Newton's 2nd law (F = m a) moves the CG; Euler's equations (M = I dw/dt + w x Iw) rotate the airframe.
 * Integration is semi-implicit Euler at 240 Hz, which is stable for the stiff landing-gear springs.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { U, v3, quat, M } = FS;
  const { clamp, smoothstep, mulMV, mulMTV } = M;

  const SUBSTEP = 1 / 240;
  const ROUND = 0.07; // rad over which the lift curve rounds over into the stall

  /** Lift coefficient vs. angle of attack, including a gentle PA-28-style stall and flat-plate behaviour beyond. */
  function clCurve(a, cl0, cla, clmax, clmin) {
    const aS = (clmax - cl0) / cla + ROUND / 2;
    const aN = (clmin - cl0) / cla - ROUND / 2;
    if (a > aS - ROUND) {
      if (a <= aS) {
        const t = a - (aS - ROUND);
        return cl0 + cla * (aS - ROUND) + cla * t - (cla * t * t) / (2 * ROUND);
      }
      const post = 0.11;
      const clPost = 0.74 * clmax;
      let cl = clPost;
      if (a <= aS + post) {
        const t = (a - aS) / post;
        cl = clmax - (clmax - clPost) * (0.5 - 0.5 * Math.cos(Math.PI * t));
      }
      const w = smoothstep(aS + post, aS + post + 0.45, a);
      return (1 - w) * cl + w * 1.15 * Math.sin(2 * a);
    }
    if (a < aN + ROUND) {
      if (a >= aN) {
        const t = aN + ROUND - a;
        return cl0 + cla * (aN + ROUND) - cla * t + (cla * t * t) / (2 * ROUND);
      }
      const post = 0.11;
      const clPost = 0.74 * clmin;
      let cl = clPost;
      if (a >= aN - post) {
        const t = (aN - a) / post;
        cl = clmin - (clmin - clPost) * (0.5 - 0.5 * Math.cos(Math.PI * t));
      }
      const w = smoothstep(-(aN - post), -(aN - post - 0.45), -a);
      return (1 - w) * cl + w * 1.15 * Math.sin(2 * a);
    }
    return cl0 + cla * a;
  }
  const stallAlpha = (cl0, cla, clmax) => (clmax - cl0) / cla + ROUND / 2;

  function flapIncrements(table, deg) {
    if (deg <= table[0].deg) return table[0];
    for (let i = 1; i < table.length; i++) {
      const a = table[i - 1], b = table[i];
      if (deg <= b.deg) {
        const t = (deg - a.deg) / (b.deg - a.deg);
        return {
          dCL: a.dCL + (b.dCL - a.dCL) * t,
          dCLmax: a.dCLmax + (b.dCLmax - a.dCLmax) * t,
          dCD: a.dCD + (b.dCD - a.dCD) * t,
          dCm: a.dCm + (b.dCm - a.dCm) * t,
        };
      }
    }
    return table[table.length - 1];
  }

  /** Default control inputs (all neutral, idle). */
  function neutralControls() {
    return { elevator: 0, aileron: 0, rudder: 0, throttle: 0, trim: 0, flaps: 0, brakeL: 0, brakeR: 0, parkingBrake: false };
  }

  class Aircraft {
    constructor(data, weather) {
      this.d = data;
      this.wx = weather;
      this.rand = M.rng(98765);
      const g = data.geom;
      this.AR = (g.b * g.b) / g.S;
      this.kInduced = 1 / (Math.PI * this.AR * data.aero.e);
      this.diskArea = (Math.PI * data.prop.D * data.prop.D) / 4;
      const e = data.engine;
      const wR = (e.ratedRPM * 2 * Math.PI) / 60;
      this.Qmax = e.ratedPowerW / wR + e.frictionQ0 + e.frictionQ1 * wR; // indicated torque at full throttle, sea level
      this.kollsman = 29.92;
      this.engineFailed = false;
      this.setLoading({ front: 340, rear: 0, baggage: 20, fuelGal: 40 });
      this.reset();
    }

    // ------------------------------------------------------------------ weight & balance
    /** loading: { front, rear, baggage (lb), fuelGal } */
    setLoading(loading) {
      this.loading = Object.assign({}, loading);
      this.fuelGal = loading.fuelGal;
      this.updateMass();
    }

    computeWB(loading) {
      const wb = this.d.wb;
      let w = wb.emptyLb, mom = wb.emptyLb * wb.emptyArm;
      for (const s of wb.stations) {
        const lb = loading[s.id] || 0;
        w += lb;
        mom += lb * s.arm;
      }
      const fuelLb = (loading.fuelGal || 0) * U.GAL;
      w += fuelLb;
      mom += fuelLb * wb.fuelArm;
      const cg = mom / w;
      const env = Aircraft.envelopeAt(wb.envelope, w);
      const problems = [];
      if (w > wb.maxGrossLb + 0.5) problems.push(`Over max gross weight by ${Math.round(w - wb.maxGrossLb)} lb`);
      if (cg < env.fwd - 0.01) problems.push(`CG ${cg.toFixed(1)} in is forward of the ${env.fwd.toFixed(1)} in limit`);
      if (cg > env.aft + 0.01) problems.push(`CG ${cg.toFixed(1)} in is aft of the ${env.aft.toFixed(1)} in limit`);
      for (const s of wb.stations) if ((loading[s.id] || 0) > s.max) problems.push(`${s.label} over ${s.max} lb limit`);
      if ((loading.fuelGal || 0) > wb.fuelUsableGal) problems.push(`Fuel over ${wb.fuelUsableGal} gal capacity`);
      return { weightLb: w, cgIn: cg, momentInLb: mom, fwdLimit: env.fwd, aftLimit: env.aft, ok: problems.length === 0, problems };
    }

    static envelopeAt(env, w) {
      if (w <= env[0][0]) return { fwd: env[0][1], aft: env[0][2] };
      for (let i = 1; i < env.length; i++) {
        if (w <= env[i][0]) {
          const t = (w - env[i - 1][0]) / (env[i][0] - env[i - 1][0]);
          return { fwd: env[i - 1][1] + (env[i][1] - env[i - 1][1]) * t, aft: env[i - 1][2] + (env[i][2] - env[i - 1][2]) * t };
        }
      }
      const l = env[env.length - 1];
      return { fwd: l[1], aft: l[2] };
    }

    updateMass() {
      const wbr = this.computeWB(Object.assign({}, this.loading, { fuelGal: this.fuelGal }));
      this.wb = wbr;
      this.mass = wbr.weightLb * U.LB;
      this.cgIn = wbr.cgIn;
      const s = wbr.weightLb / this.d.wb.maxGrossLb;
      const I = this.d.inertia;
      // inertia scales roughly with mass; rear-seat / baggage loads add pitch & yaw inertia
      const aftMass = ((this.loading.rear || 0) + (this.loading.baggage || 0) * 1.6) / this.d.wb.maxGrossLb;
      this.I = [I.Ixx * (0.75 + 0.25 * s), I.Iyy * (0.7 + 0.3 * s + 0.35 * aftMass), I.Izz * (0.7 + 0.3 * s + 0.3 * aftMass)];
      this.xcgFrac = (this.cgIn - this.d.wb.refCgIn) / this.d.geom.macIn;
      this.staticMargin = (this.d.wb.neutralPointIn - this.cgIn) / this.d.geom.macIn;
    }

    // ------------------------------------------------------------------ state
    reset() {
      this.s = {
        pos: [0, 0, -1],
        vel: [0, 0, 0],
        q: quat.identity(),
        w: [0, 0, 0],
        omegaP: 0,
        flapDeg: 0,
        alpha: 0,
        alphaDot: 0,
      };
      this.time = 0;
      this.events = [];
      this.crashed = null;
      this.onGround = false;
      this.mainsOnGround = false;
      this.noseOnGround = false;
      this.lastAirborne = 0;
      this.touchdown = null;
      this.vsiInd = 0;
      this.ballInd = 0;
      this.maxG = 1;
      this.minG = 1;
      this.warnings = {};
      this.propAngle = 0;
      this.out = null;
      this.ctl = neutralControls();
      this.engineFailed = false;
      this.stallWasOn = false;
    }

    /** Park on the ground at (north, east) heading hdg, settled on the gear, engine idling. */
    placeOnGround(n, e, hdgDeg, opts = {}) {
      this.reset();
      const s = this.s;
      s.pos = [n, e, -0.94];
      s.q = quat.fromEuler(0, 0.0 * U.DEG, hdgDeg * U.DEG);
      s.omegaP = (800 * 2 * Math.PI) / 60;
      s.flapDeg = opts.flaps || 0;
      const ctl = Object.assign(neutralControls(), { parkingBrake: true, flaps: s.flapDeg, throttle: 0, trim: opts.trim || 0 });
      // let the struts settle
      const wind = this.wx.cfg.windKt;
      for (let i = 0; i < 240 * 3; i++) this.substep(SUBSTEP, ctl);
      s.vel = [0, 0, 0];
      s.w = [0, 0, 0];
      s.pos[0] = n;
      s.pos[1] = e;
      for (let i = 0; i < 240; i++) this.substep(SUBSTEP, ctl);
      this.time = 0;
      this.events = [];
      this.touchdown = null;
      this.crashed = null;
      this.maxG = this.minG = 1;
      this.lastAirborne = 0;
      void wind;
      return ctl;
    }

    /**
     * Start in the air, trimmed.
     * opts: { n, e, altFt (MSL), hdg, ias, gammaDeg, flaps, throttle (optional: if given, solve climb angle), bankDeg }
     * Returns the controls that hold the trim (throttle, trim).
     */
    placeInAir(opts) {
      this.reset();
      const s = this.s;
      const flaps = opts.flaps || 0;
      const alt = opts.altFt * U.FT;
      const t = this.solveTrim({ altMSL: alt, ias: opts.ias, gamma: (opts.gammaDeg || 0) * U.DEG, flaps, throttle: opts.throttle });
      const hdg = opts.hdg * U.DEG;
      const theta = t.alpha + t.gamma;
      s.q = quat.fromEuler((opts.bankDeg || 0) * U.DEG, theta, hdg);
      s.pos = [opts.n || 0, opts.e || 0, -(alt - this.wx.fieldElev)];
      const hAGL = -s.pos[2];
      const wind = this.wx.windAt(hAGL);
      const vAir = [t.tas * Math.cos(t.gamma) * Math.cos(hdg), t.tas * Math.cos(t.gamma) * Math.sin(hdg), -t.tas * Math.sin(t.gamma)];
      s.vel = v3.add(vAir, wind);
      s.omegaP = t.omegaP;
      s.flapDeg = flaps;
      s.alpha = t.alpha;
      const ctl = Object.assign(neutralControls(), { throttle: t.throttle, trim: t.trim, flaps });
      this.ctl = ctl;
      this.lastAirborne = 10;
      this.trimInfo = t;
      return ctl;
    }

    // ------------------------------------------------------------------ engine & propeller
    engineTorque(thr, omega, sigma) {
      const e = this.d.engine;
      if (this.engineFailed || this.fuelGal <= 0) return { ind: 0, fric: omega > 0.5 ? e.frictionQ0 + e.frictionQ1 * omega : 0 };
      const map = e.idleMap + (1 - e.idleMap) * clamp(thr, 0, 1);
      const frac = Math.max(0, (map - e.mapZeroTorque) / (1 - e.mapZeroTorque));
      const ind = this.Qmax * sigma * frac;
      const fric = omega > 0.5 ? e.frictionQ0 + e.frictionQ1 * omega : 0;
      return { ind, fric, map };
    }

    propeller(vAxial, omega, rho) {
      const p = this.d.prop;
      const n = omega / (2 * Math.PI);
      if (n < 0.05) return { T: 0, Q: 0, J: 0, eta: 0 };
      const J = Math.max(0, vAxial) / (n * p.D);
      const jt = J / p.Jt;
      // beyond zero-thrust J the blades are at negative AoA: a windmilling brake, but a gentle one
      const Ct = jt <= 1 ? p.Ct0 * (1 - jt * jt * jt) : Math.max(p.CtMin, -p.Ct0 * 0.35 * (jt - 1));
      const Cp = Math.max(p.CpMin, p.Cp0 * (1 - (J / p.Jp) * (J / p.Jp)));
      const D4 = p.D * p.D * p.D * p.D;
      const T = Ct * rho * n * n * D4;
      const P = Cp * rho * n * n * n * D4 * p.D;
      const Q = P / omega;
      return { T, Q, J, eta: Cp > 1e-4 ? (J * Ct) / Cp : 0, P };
    }

    /** Steady-state RPM for a throttle setting at a given airspeed (used by the trim solver). */
    equilibriumOmega(thr, vAxial, rho, sigma) {
      let lo = 20, hi = 420;
      for (let i = 0; i < 50; i++) {
        const mid = 0.5 * (lo + hi);
        const e = this.engineTorque(thr, mid, sigma);
        const pr = this.propeller(vAxial, mid, rho);
        if (e.ind - e.fric - pr.Q > 0) lo = mid;
        else hi = mid;
      }
      return 0.5 * (lo + hi);
    }

    // ------------------------------------------------------------------ the force model
    /**
     * Compute every force and moment for state s and controls ctl.
     * Returns a detail object (forces in world & body frames plus every intermediate the UI wants to show).
     */
    computeForces(s, ctl, opts = {}) {
      const d = this.d, g = d.geom, a = d.aero, pr = d.prop, cc = d.controls;
      const R = quat.toMatrix(s.q);
      const hAGL = -s.pos[2];
      const altMSL = this.wx.fieldElev + hAGL;
      const atm = this.wx.at(altMSL);
      const rho = atm.rho;
      const wind = opts.noWind ? [0, 0, 0] : this.wx.windAt(Math.max(0.5, hAGL));
      const vAirW = [s.vel[0] - wind[0], s.vel[1] - wind[1], s.vel[2] - wind[2]];
      const vb = mulMTV(R, vAirW);
      const V = Math.hypot(vb[0], vb[1], vb[2]);
      const Vs = Math.max(V, 1e-3);
      const alpha = Math.atan2(vb[2], vb[0]);
      const beta = Math.asin(clamp(vb[1] / Vs, -1, 1));
      const qbar = 0.5 * rho * V * V;
      const p = s.w[0] - (opts.noWind ? 0 : this.wx.turbP), q = s.w[1], r = s.w[2];
      const Vn = Math.max(V, 6);
      const ph = (p * g.b) / (2 * Vn), qh = (q * g.c) / (2 * Vn), rh = (r * g.b) / (2 * Vn);
      const adh = (s.alphaDot * g.c) / (2 * Vn);

      // ---- control deflections
      const trimRad = ctl.trim >= 0 ? ctl.trim * cc.trimPull : -ctl.trim * cc.trimPush;
      const el = clamp(ctl.elevator, -1, 1);
      const stab = el >= 0 ? trimRad + el * (cc.stabMaxPull - trimRad) : trimRad + -el * (cc.stabMaxPush - trimRad);
      const ail = clamp(ctl.aileron, -1, 1) * cc.aileronMax;
      const rud = clamp(ctl.rudder, -1, 1) * cc.rudderMax;

      // ---- ground effect (Wieselberger): phi = induced-drag factor, 1 in free air
      const hWing = hAGL - R[8] * g.wingZ;
      const hb = Math.max(hWing, 0.05) / g.b;
      const phiGE = hb < 0.75 ? clamp(1 - (1 - 1.32 * hb) / (1.05 + 7.4 * hb), 0, 1) : 1;
      const ge = 1 - phiGE;

      // ---- propeller & engine
      const omegaP = s.omegaP;
      const prop = this.propeller(vb[0], omegaP, rho);
      const T = prop.T;
      const eng = this.engineTorque(ctl.throttle, omegaP, atm.sigma);
      const qTail = qbar + (pr.slipstreamTail * Math.max(T, 0)) / this.diskArea;

      // ---- lift
      const fl = flapIncrements(a.flaps, s.flapDeg);
      const cl0 = a.CL0 + fl.dCL;
      const cla = a.CLa * (1 + 0.08 * ge);
      const clmax = a.CLmax + fl.dCLmax;
      const aStall = stallAlpha(cl0, cla, clmax);
      const stall = smoothstep(aStall - 0.01, aStall + 0.07, Math.abs(alpha)) * (alpha > 0 ? 1 : 0.7);
      const clStatic = clCurve(alpha, cl0, cla, clmax, a.CLminNeg);
      const CL = clStatic + a.CLq * qh + a.CLadot * adh * (1 - stall) + a.CLde * stab;

      // ---- drag
      const sep = smoothstep(aStall - 0.03, aStall + 0.25, Math.abs(alpha));
      const sa = Math.sin(alpha), sb = Math.sin(beta);
      const clInd = clamp(clStatic, -1.4, clmax);
      const CD = a.CD0 + fl.dCD + this.kInduced * phiGE * clInd * clInd + sep * 1.1 * sa * sa + a.CDbeta * sb * sb + 0.012 * Math.abs(ail / cc.aileronMax) * (V > 1 ? 1 : 0);

      // ---- side force (rudder part uses tail dynamic pressure)
      const CY = a.CYb * sb + a.CYp * ph + a.CYr * rh;

      // ---- moments (coefficients)
      const buf = stall > 0.05 && !opts.noWind ? stall : 0;
      const nz = buf ? (this.rand() - 0.5) * 2 : 0;
      const nz2 = buf ? (this.rand() - 0.5) * 2 : 0;
      const Clp = a.Clp * (1 - 2.3 * stall);
      const Clb = a.Clb * (1 + 3 * stall);
      const Clr = a.Clr * (1 + 2 * stall);
      const Cl = Clb * sb + Clp * ph + Clr * rh + a.Clda * ail + buf * 0.012 * nz;
      const Cm = a.Cm0 + a.Cma * Math.sin(alpha) + a.Cmq * qh + a.Cmadot * adh * (1 - stall) + fl.dCm + a.CmStall * stall
        + clStatic * this.xcgFrac - 0.045 * ge + buf * 0.01 * nz2;
      const Cn = a.Cnb * sb + a.Cnp * ph + a.Cnr * rh + a.Cnda * ail;

      // ---- aerodynamic forces in body axes
      const qS = qbar * g.S;
      let Fb = [0, 0, 0];
      let liftDir = [0, 0, -1], dragDir = [-1, 0, 0];
      if (V > 0.3) {
        const vh = [vb[0] / Vs, vb[1] / Vs, vb[2] / Vs];
        // lift is perpendicular to the relative wind, in the plane of symmetry
        const ld = [vh[2], 0, -vh[0]];
        const ll = Math.hypot(ld[0], ld[2]) || 1;
        liftDir = [ld[0] / ll, 0, ld[2] / ll];
        dragDir = [-vh[0], -vh[1], -vh[2]];
      }
      const Lmag = qS * CL;
      const Dmag = qS * CD;
      const Ymag = qS * CY + qTail * g.S * a.CYdr * rud;
      Fb = [
        liftDir[0] * Lmag + dragDir[0] * Dmag,
        dragDir[1] * Dmag + Ymag,
        liftDir[2] * Lmag + dragDir[2] * Dmag,
      ];
      // thrust along the crankshaft
      Fb[0] += T;

      // ---- moments in body axes (N m)
      const alphaC = clamp(alpha, -0.35, 0.35);
      const leftYaw = T > 0 ? -T * (pr.spiral + pr.pFactor * alphaC) : 0;
      const Mb = [
        qS * g.b * Cl + qTail * g.S * g.b * a.Cldr * rud - prop.Q + pr.rollRig * qbar,
        qS * g.c * Cm + qTail * g.S * g.c * a.Cmde * stab + pr.thrustZ * T,
        qS * g.b * Cn + qTail * g.S * g.b * a.Cndr * rud + leftYaw + pr.finOffset * qbar,
      ];

      // ---- landing gear & ground contact
      const Fg = [0, 0, 0];
      const gearOut = [];
      let anyContact = false, mainsContact = false, noseContact = false;
      let hardHit = null;
      if (hAGL < 4) {
        const tire = d.tire;
        const fwdW = [R[0], R[3], 0];
        for (const gr of d.gear) {
          const rb = gr.pos;
          const rw = mulMV(R, rb);
          const pz = s.pos[2] + rw[2];
          const pen = pz; // ground plane is z = 0
          const info = { id: gr.id, comp: 0, N: 0 };
          if (pen > 0) {
            const wxr = v3.cross(s.w, rb);
            const vp = v3.add(s.vel, mulMV(R, wxr));
            let N = gr.k * pen + gr.c * vp[2];
            if (N < 0) N = 0;
            // wheel rolling direction (nose wheel steers with the rudder pedals)
            let dirW = fwdW;
            if (gr.steer) {
              const st = clamp(ctl.rudder, -1, 1) * d.controls.noseSteerMax;
              dirW = mulMV(R, [Math.cos(st), Math.sin(st), 0]);
              dirW[2] = 0;
            }
            const dl = Math.hypot(dirW[0], dirW[1]) || 1;
            const fx = dirW[0] / dl, fy = dirW[1] / dl;
            const vLong = vp[0] * fx + vp[1] * fy;
            const vLat = -vp[0] * fy + vp[1] * fx;
            let brake = 0;
            if (gr.brake) brake = ctl.parkingBrake ? 1 : gr.id === 'left' ? ctl.brakeL : ctl.brakeR;
            const muL = tire.muRoll + brake * tire.muBrake;
            const FL = -muL * N * Math.tanh(vLong / 0.1);
            const FLat = -tire.muLat * N * Math.tanh(vLat / 0.12);
            const f = [fx * FL - fy * FLat, fy * FL + fx * FLat, -N];
            Fg[0] += f[0];
            Fg[1] += f[1];
            Fg[2] += f[2];
            const fbody = mulMTV(R, f);
            const mg = v3.cross(rb, fbody);
            Mb[0] += mg[0];
            Mb[1] += mg[1];
            Mb[2] += mg[2];
            info.comp = pen;
            info.N = N;
            anyContact = true;
            if (gr.id === 'nose') noseContact = true;
            else mainsContact = true;
            if (pen > gr.maxComp) hardHit = hardHit || `${gr.id} gear collapsed`;
          }
          gearOut.push(info);
        }
        for (const hp of d.hardpoints) {
          const rw = mulMV(R, hp.pos);
          if (s.pos[2] + rw[2] > 0.02) hardHit = hardHit || `${hp.id} struck the ground`;
        }
      }

      // ---- total force (world) and specific force (what the pilot's inner ear and the ball feel)
      const FbW = mulMV(R, Fb);
      const F = [FbW[0] + Fg[0], FbW[1] + Fg[1], FbW[2] + Fg[2] + this.mass * U.G];
      const FgB = mulMTV(R, Fg);
      const spec = [(Fb[0] + FgB[0]) / this.mass, (Fb[1] + FgB[1]) / this.mass, (Fb[2] + FgB[2]) / this.mass];

      return {
        R, atm, wind, vb, V, alpha, beta, qbar, qTail, CL, CD, CY, Cl, Cm, Cn, clStatic,
        stall, aStall, stallWarn: alpha > aStall - a.stallWarnMargin && V > 8,
        lift: Lmag, drag: Dmag, side: Ymag, thrust: T, prop, eng,
        liftDirB: liftDir, dragDirB: dragDir,
        Fb, F, Mb, Fg, spec, phiGE, gear: gearOut,
        onGround: anyContact, mainsOnGround: mainsContact, noseOnGround: noseContact, hardHit,
        stab, ail, rud, trimRad,
      };
    }

    // ------------------------------------------------------------------ integration
    step(dt, ctl) {
      if (this.crashed) return;
      this.ctl = ctl;
      let n = Math.max(1, Math.round(dt / SUBSTEP));
      n = Math.min(n, 40);
      const h = dt / n;
      for (let i = 0; i < n && !this.crashed; i++) this.substep(h, ctl);
      this.postStep(dt, ctl);
    }

    substep(h, ctl) {
      const s = this.s;
      // flaps travel toward the selected position
      s.flapDeg = M.approach(s.flapDeg, ctl.flaps, this.d.controls.flapRate * h);
      const wasMains = this.mainsOnGround, wasNose = this.noseOnGround;
      const vzBefore = s.vel[2];
      const f = this.computeForces(s, ctl);
      this.out = f;

      // touchdown / liftoff bookkeeping
      if (f.onGround && !wasMains && !wasNose && this.lastAirborne > 0.4) {
        const gsLat = this.lateralDrift(f);
        this.touchdown = {
          time: this.time,
          vsFpm: vzBefore / U.FPM,
          firstGear: f.mainsOnGround ? 'mains' : 'nose',
          n: s.pos[0],
          e: s.pos[1],
          pitchDeg: quat.toEuler(s.q).pitch * U.RAD,
          ias: this.iasFrom(f),
          driftKt: gsLat / U.KT,
          crabDeg: this.crabAngle(),
          bankDeg: quat.toEuler(s.q).roll * U.RAD,
        };
        this.events.push({ type: 'touchdown', data: this.touchdown });
        if (this.touchdown.vsFpm > 950) this.crash(`Landed at ${Math.round(this.touchdown.vsFpm)} fpm — the gear could not absorb it`);
      }
      this.onGround = f.onGround;
      this.mainsOnGround = f.mainsOnGround;
      this.noseOnGround = f.noseOnGround;
      if (f.onGround) {
        if (this.lastAirborne > 0.4) this.events.push({ type: 'contact' });
        this.lastAirborne = 0;
      } else {
        if (this.lastAirborne === 0) this.events.push({ type: 'liftoff', data: { n: s.pos[0], e: s.pos[1], ias: this.iasFrom(f), time: this.time } });
        this.lastAirborne += h;
      }
      if (f.hardHit) {
        this.crash(f.hardHit);
        return;
      }

      // ---- translation (semi-implicit Euler)
      const im = 1 / this.mass;
      s.vel[0] += f.F[0] * im * h;
      s.vel[1] += f.F[1] * im * h;
      s.vel[2] += f.F[2] * im * h;
      s.pos[0] += s.vel[0] * h;
      s.pos[1] += s.vel[1] * h;
      s.pos[2] += s.vel[2] * h;

      // ---- rotation: I dw/dt = M - w x (I w + H_prop)
      const I = this.I;
      const w = s.w;
      const Hp = this.d.engine.inertia * s.omegaP;
      const Iw = [I[0] * w[0] + Hp, I[1] * w[1], I[2] * w[2]];
      const gyro = v3.cross(w, Iw);
      w[0] += ((f.Mb[0] - gyro[0]) / I[0]) * h;
      w[1] += ((f.Mb[1] - gyro[1]) / I[1]) * h;
      w[2] += ((f.Mb[2] - gyro[2]) / I[2]) * h;
      const dq = quat.mul(s.q, [0, w[0], w[1], w[2]]);
      s.q = quat.normalize([s.q[0] + 0.5 * dq[0] * h, s.q[1] + 0.5 * dq[1] * h, s.q[2] + 0.5 * dq[2] * h, s.q[3] + 0.5 * dq[3] * h]);

      // ---- engine / propeller rotor
      const Qnet = f.eng.ind - f.eng.fric - f.prop.Q;
      s.omegaP = Math.max(0, s.omegaP + (Qnet / this.d.engine.inertia) * h);

      // ---- angle-of-attack rate (for downwash lag terms)
      const ad = (f.alpha - s.alpha) / h;
      s.alphaDot = M.lowpass(s.alphaDot, Math.abs(ad) < 20 ? ad : 0, h, 0.05);
      s.alpha = f.alpha;

      // ---- fuel burn
      const hpInd = (f.eng.ind * s.omegaP) / U.HP;
      this.fuelFlowGph = (Math.max(0, hpInd) * this.d.engine.bsfc) / U.GAL;
      this.fuelGal = Math.max(0, this.fuelGal - (this.fuelFlowGph / 3600) * h);

      this.time += h;
      this.propAngle = (this.propAngle + s.omegaP * h) % (Math.PI * 2);
    }

    postStep(dt, ctl) {
      const f = this.out;
      if (!f) return;
      this.updateMass();
      // instrument dynamics
      const vs = -this.s.vel[2] / U.FPM;
      this.vsiInd = M.lowpass(this.vsiInd, vs, dt, 1.6);
      const ballTarget = Math.atan2(-f.spec[1], Math.max(0.5, -f.spec[2]));
      this.ballInd = M.lowpass(this.ballInd, ballTarget, dt, 0.18);
      const g = -f.spec[2] / U.G;
      this.gLoad = g;
      if (!this.onGround) {
        this.maxG = Math.max(this.maxG, g);
        this.minG = Math.min(this.minG, g);
      }
      // warnings
      const ias = this.iasFrom(f);
      const w = this.warnings;
      w.stall = f.stallWarn && !this.onGround;
      w.overspeed = ias > this.d.v.ne;
      w.flapSpeed = this.s.flapDeg > 1 && ias > this.d.v.fe + 2;
      w.overG = g > this.d.limits.gPos || g < this.d.limits.gNeg;
      w.rpm = (this.s.omegaP * 60) / (2 * Math.PI) > this.d.engine.redlineRPM + 40;
      if (w.stall && !this.stallWasOn) this.events.push({ type: 'stallwarn' });
      this.stallWasOn = w.stall;
      if (g > 5.7 || g < -3.0) this.crash(`Structural failure at ${g.toFixed(1)} G (limit ${this.d.limits.gPos} G)`);
      if (ias > 200) this.crash('Airframe flutter and break-up above 200 KIAS (Vne is 160)');
      void ctl;
    }

    crash(reason) {
      if (this.crashed) return;
      this.crashed = reason;
      this.events.push({ type: 'crash', reason });
    }

    iasFrom(f) {
      // pitot tube senses the dynamic pressure along its axis; ASI is calibrated to sea-level density
      const vx = Math.max(0, f.vb[0]);
      const qp = 0.5 * f.atm.rho * vx * vx;
      return Math.sqrt((2 * qp) / FS.ISA.RHO0) / U.KT;
    }

    lateralDrift(f) {
      const R = f.R;
      const fx = R[0], fy = R[3];
      const l = Math.hypot(fx, fy) || 1;
      return (-this.s.vel[0] * fy + this.s.vel[1] * fx) / l;
    }

    crabAngle() {
      const s = this.s;
      const gs = Math.hypot(s.vel[0], s.vel[1]);
      if (gs < 3) return 0;
      const track = Math.atan2(s.vel[1], s.vel[0]);
      const hdg = quat.toEuler(s.q).yaw;
      return M.wrapPi(hdg - track) * U.RAD;
    }

    // ------------------------------------------------------------------ trim solver
    /**
     * Find alpha, stabilator trim and throttle (or flight-path angle if throttle is given) for steady,
     * wings-level, unaccelerated flight. Newton iteration with a numerical Jacobian.
     */
    solveTrim({ altMSL, ias, gamma = 0, flaps = 0, throttle }) {
      const atm = this.wx.at(altMSL);
      const tas = ias * U.KT * Math.sqrt(FS.ISA.RHO0 / atm.rho);
      const solveGamma = throttle !== undefined;
      const hAGL = Math.max(altMSL - this.wx.fieldElev, 300);
      const W = this.mass * U.G;
      const qS = 0.5 * atm.rho * tas * tas * this.d.geom.S;
      const cl0 = this.d.aero.CL0 + flapIncrements(this.d.aero.flaps, flaps).dCL;
      let x = [(W / qS - cl0) / this.d.aero.CLa, 0, solveGamma ? 0 : 0.5];
      const ctl = neutralControls();
      ctl.flaps = flaps;
      const evalR = (xx) => {
        const a = xx[0];
        const trim = clamp(xx[1], -1.5, 1.5);
        const thr = solveGamma ? throttle : clamp(xx[2], 0, 1);
        const gam = solveGamma ? xx[2] : gamma;
        ctl.trim = trim;
        ctl.throttle = thr;
        const omega = this.equilibriumOmega(thr, tas * Math.cos(a), atm.rho, atm.sigma);
        const st = {
          pos: [0, 0, -hAGL],
          vel: [tas * Math.cos(gam), 0, -tas * Math.sin(gam)],
          q: quat.fromEuler(0, a + gam, 0),
          w: [0, 0, 0],
          omegaP: omega,
          flapDeg: flaps,
          alpha: a,
          alphaDot: 0,
        };
        const f = this.computeForces(st, ctl, { noWind: true });
        // residuals: accelerations along and perpendicular to the path, pitch acceleration
        const ax = (f.F[0] * Math.cos(gam) - f.F[2] * Math.sin(gam)) / W;
        const az = (f.F[0] * Math.sin(gam) + f.F[2] * Math.cos(gam)) / W;
        const my = f.Mb[1] / (qS * this.d.geom.c);
        return { r: [ax, az, my], omega, f, thr, gam, trim };
      };
      let res = evalR(x);
      for (let it = 0; it < 60; it++) {
        const r0 = res.r;
        if (Math.abs(r0[0]) + Math.abs(r0[1]) + Math.abs(r0[2]) < 1e-7) break;
        const J = [];
        for (let j = 0; j < 3; j++) {
          const h = 1e-5;
          const xp = x.slice();
          xp[j] += h;
          const rp = evalR(xp).r;
          J.push([(rp[0] - r0[0]) / h, (rp[1] - r0[1]) / h, (rp[2] - r0[2]) / h]);
        }
        // J is stored column-wise: J[j][i] = d r_i / d x_j
        const A = [
          [J[0][0], J[1][0], J[2][0]],
          [J[0][1], J[1][1], J[2][1]],
          [J[0][2], J[1][2], J[2][2]],
        ];
        const dx = solve3(A, r0.map((v) => -v));
        if (!dx) break;
        let lam = 1;
        for (let k = 0; k < 8; k++) {
          const xn = [x[0] + lam * dx[0], x[1] + lam * dx[1], x[2] + lam * dx[2]];
          if (!solveGamma) xn[2] = clamp(xn[2], 0, 1);
          const rn = evalR(xn);
          const n0 = Math.abs(r0[0]) + Math.abs(r0[1]) + Math.abs(r0[2]);
          const n1 = Math.abs(rn.r[0]) + Math.abs(rn.r[1]) + Math.abs(rn.r[2]);
          if (n1 < n0 || k === 7) {
            x = xn;
            res = rn;
            break;
          }
          lam *= 0.5;
        }
      }
      return {
        alpha: x[0],
        trim: clamp(res.trim, -1, 1),
        throttle: res.thr,
        gamma: res.gam,
        omegaP: res.omega,
        rpm: (res.omega * 60) / (2 * Math.PI),
        tas,
        residual: res.r,
        CL: res.f.CL,
        CD: res.f.CD,
        thrust: res.f.thrust,
        drag: res.f.drag,
        lift: res.f.lift,
        eta: res.f.prop.eta,
      };
    }

    // ------------------------------------------------------------------ what the instruments & UI see
    telemetry() {
      const s = this.s;
      const f = this.out || this.computeForces(s, this.ctl);
      const e = quat.toEuler(s.q);
      const hAGL = -s.pos[2];
      const altMSL = this.wx.fieldElev + hAGL;
      const ias = this.iasFrom(f);
      const gs = Math.hypot(s.vel[0], s.vel[1]);
      const track = M.wrap360(Math.atan2(s.vel[1], s.vel[0]) * U.RAD);
      const p = s.w[0], q = s.w[1], r = s.w[2];
      const cph = Math.cos(e.roll), sph = Math.sin(e.roll), cth = Math.max(0.05, Math.cos(e.pitch));
      const yawRate = ((q * sph + r * cph) / cth) * U.RAD;
      const rpm = (s.omegaP * 60) / (2 * Math.PI);
      const W = this.mass * U.G;
      // flight-path angle relative to the air mass
      const vAir = [s.vel[0] - f.wind[0], s.vel[1] - f.wind[1], s.vel[2] - f.wind[2]];
      const vAirLen = Math.hypot(vAir[0], vAir[1], vAir[2]) || 1;
      const gammaAir = Math.asin(clamp(-vAir[2] / vAirLen, -1, 1)) * U.RAD;
      const R = f.R;
      const mainsZ = s.pos[2] + R[6] * -0.42 + R[8] * 1.0; // z of main-gear contact point
      return {
        time: this.time,
        ias,
        tas: f.V / U.KT,
        gs: gs / U.KT,
        track,
        altMSL: altMSL / U.FT,
        altInd: this.wx.indicatedAltitude(f.atm.P, this.kollsman) / U.FT,
        agl: Math.max(0, -mainsZ) / U.FT,
        vs: -s.vel[2] / U.FPM,
        vsi: this.vsiInd,
        pitch: e.pitch * U.RAD,
        bank: e.roll * U.RAD,
        hdg: M.wrap360(e.yaw * U.RAD),
        p: p * U.RAD,
        q: q * U.RAD,
        r: r * U.RAD,
        turnRate: yawRate,
        alpha: f.alpha * U.RAD,
        beta: f.beta * U.RAD,
        alphaStall: f.aStall * U.RAD,
        aoaFrac: clamp((f.alpha - (f.aStall - 0.30)) / 0.30, 0, 1.2), // lift-reserve indicator
        gammaAir,
        ball: this.ballInd * U.RAD,
        g: this.gLoad === undefined ? 1 : this.gLoad,
        maxG: this.maxG,
        minG: this.minG,
        rpm,
        throttle: this.ctl.throttle,
        trim: this.ctl.trim,
        elevator: this.ctl.elevator,
        aileron: this.ctl.aileron,
        rudder: this.ctl.rudder,
        flaps: s.flapDeg,
        flapsSel: this.ctl.flaps,
        brakes: Math.max(this.ctl.brakeL, this.ctl.brakeR),
        parkingBrake: this.ctl.parkingBrake,
        onGround: this.onGround,
        mainsOnGround: this.mainsOnGround,
        noseOnGround: this.noseOnGround,
        stallWarn: !!this.warnings.stall,
        stalled: f.alpha > f.aStall && !this.onGround,
        stall: f.stall,
        warnings: this.warnings,
        n: s.pos[0],
        e: s.pos[1],
        // the four forces (lbf) and friends
        lift: f.lift / U.LBF,
        drag: f.drag / U.LBF,
        thrust: f.thrust / U.LBF,
        weight: W / U.LBF,
        side: f.side / U.LBF,
        CL: f.CL,
        CD: f.CD,
        qbarPsf: f.qbar / 47.880259,
        rhoSlug: f.atm.rho / 515.379,
        ld: f.drag > 1 ? f.lift / f.drag : 0,
        excessPowerFpm: f.V > 5 ? (((f.thrust - f.drag) * f.V) / W) / U.FPM : 0,
        propEta: f.prop.eta,
        fuelGal: this.fuelGal,
        fuelFlow: this.fuelFlowGph || 0,
        hp: (Math.max(0, f.eng.ind - f.eng.fric) * s.omegaP) / U.HP,
        map: (f.eng.map || 0) * f.atm.P / U.INHG,
        oat: f.atm.oatC,
        densityAltFt: f.atm.densityAlt / U.FT,
        pressureAltFt: f.atm.pressureAlt / U.FT,
        windN: f.wind[0],
        windE: f.wind[1],
        phiGE: f.phiGE,
        weightLb: this.wb.weightLb,
        cgIn: this.cgIn,
        staticMargin: this.staticMargin,
        engineFailed: this.engineFailed,
        crashed: this.crashed,
        stab: f.stab,
        ail: f.ail,
        rud: f.rud,
      };
    }
  }

  /** Solve 3x3 linear system A x = b (Gaussian elimination with partial pivoting). */
  function solve3(A, b) {
    const m = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
      if (Math.abs(m[piv][c]) < 1e-12) return null;
      [m[c], m[piv]] = [m[piv], m[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const k = m[r][c] / m[c][c];
        for (let k2 = c; k2 < 4; k2++) m[r][k2] -= k * m[c][k2];
      }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  }

  FS.Aircraft = Aircraft;
  FS.neutralControls = neutralControls;
  FS.clCurve = clCurve;
  FS.SUBSTEP = SUBSTEP;
})();
