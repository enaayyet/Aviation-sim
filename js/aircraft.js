/*
 * aircraft.js — data describing a PA-28-161 Warrior II-class trainer.
 *
 * Numbers come from published POH figures where they exist (weights, arms, V-speeds, engine)
 * and from typical light-aircraft stability derivatives (Roskam / Cessna 172 data scaled to
 * PA-28 geometry) for the aerodynamic model. The values were then tuned so the simulated airplane
 * reproduces POH performance (see tests/performance.test.js).
 *
 * This is a training model, not a certified flight model: use the real POH for real flying.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { U } = FS;

  FS.PA28 = {
    name: 'PA-28-161 Warrior II',
    short: 'PA-28',

    geom: {
      S: 15.79, // wing area m^2 (170 ft^2)
      b: 10.67, // span m (35 ft)
      c: 1.6, // mean aerodynamic chord m (63 in)
      macIn: 63, // MAC in inches (for CG % MAC)
      wingZ: 0.45, // wing quarter-chord below CG (m) — used for ground-effect height
      propD: 1.88, // propeller diameter m (74 in)
    },

    // ----- weight & balance (inches aft of datum, pounds) -----
    wb: {
      emptyLb: 1520,
      emptyArm: 86.2,
      maxGrossLb: 2440,
      fuelArm: 95.0,
      fuelUsableGal: 48,
      stations: [
        { id: 'front', label: 'Pilot + front passenger', arm: 80.5, max: 400 },
        { id: 'rear', label: 'Rear passengers', arm: 118.1, max: 400 },
        { id: 'baggage', label: 'Baggage', arm: 142.8, max: 200 },
      ],
      // CG envelope (normal category): [weight, fwd limit, aft limit]
      envelope: [
        [1200, 83.0, 93.0],
        [1950, 83.0, 93.0],
        [2440, 87.0, 93.0],
      ],
      refCgIn: 88.0, // CG at which aero moments are referenced
      neutralPointIn: 96.5, // stick-fixed neutral point (static margin -> 0 here)
    },

    // ----- inertia at max gross (kg m^2), body axes -----
    inertia: { Ixx: 1285, Iyy: 1825, Izz: 2667, Ixz: 0 },

    // ----- aerodynamics (per radian unless noted) -----
    aero: {
      CL0: 0.3,
      CLa: 4.8,
      CLmax: 1.6, // clean
      CLminNeg: -0.95,
      CLq: 3.9,
      CLadot: 1.7,
      CLde: -0.25, // lift change per rad of stabilator "pull" (tail download)
      CD0: 0.034,
      e: 0.74, // Oswald efficiency
      CDbeta: 0.55,
      CYb: -0.31,
      CYdr: -0.187,
      CYp: -0.037,
      CYr: 0.21,
      Clb: -0.092,
      Clp: -0.47,
      Clr: 0.075,
      Clda: 0.19,
      Cldr: 0.0147,
      Cm0: 0.02,
      Cma: -0.62, // at reference CG (88 in)
      Cmq: -12.4,
      Cmadot: -5.2,
      Cmde: 1.4, // per rad of stabilator "pull" (all-moving tail: ~24 ft² on a long arm)
      CmStall: -0.09, // nose-down break at the stall
      Cnb: 0.072,
      Cnp: -0.03,
      Cnr: -0.115,
      Cnda: -0.024, // adverse yaw
      Cndr: 0.0657,
      // flap table: deflection deg -> increments
      flaps: [
        { deg: 0, dCL: 0.0, dCLmax: 0.0, dCD: 0.0, dCm: 0.0 },
        { deg: 10, dCL: 0.16, dCLmax: 0.2, dCD: 0.009, dCm: -0.012 },
        { deg: 25, dCL: 0.38, dCLmax: 0.43, dCD: 0.03, dCm: -0.025 },
        { deg: 40, dCL: 0.56, dCLmax: 0.62, dCD: 0.054, dCm: -0.035 },
      ],
      stallWarnMargin: 3.2 * U.DEG, // lift detector trips this far below stall AoA
    },

    // ----- control surface ranges (radians) -----
    controls: {
      stabMaxPull: 0.3, // full aft yoke
      stabMaxPush: -0.11, // full forward yoke
      trimPull: 0.15, // trim full nose-up
      trimPush: -0.1, // trim full nose-down
      aileronMax: 0.25,
      rudderMax: 0.27,
      noseSteerMax: 20 * U.DEG,
      flapRate: 20, // deg/s (manual Johnson-bar flaps move quickly)
    },

    // ----- engine: Lycoming O-320 160 hp, fixed-pitch prop -----
    engine: {
      ratedPowerW: 160 * U.HP,
      ratedRPM: 2700,
      redlineRPM: 2700,
      frictionQ0: 10, // N m
      frictionQ1: 0.12, // N m per rad/s
      idleMap: 0.3, // manifold-pressure fraction at closed throttle
      mapZeroTorque: 0.19, // MAP fraction where indicated torque reaches zero
      inertia: 2.6, // engine + propeller kg m^2
      bsfc: 0.43, // lb/hp/hr
    },
    prop: {
      D: 1.88,
      Ct0: 0.091,
      Jt: 0.95, // advance ratio of zero thrust: Ct = Ct0 (1 - (J/Jt)^3)
      Cp0: 0.0635,
      Jp: 1.4, // Cp = Cp0 (1 - (J/Jp)^2)
      CtMin: -0.06,
      CpMin: -0.09,
      thrustZ: 0.12, // thrust line below CG (m): adding power pitches the nose up
      // left-turning tendencies (N m of yaw per N of thrust): slipstream spiral + P-factor
      spiral: 0.22,
      pFactor: 1.5,
      finOffset: 0.155, // offset fin/thrust line cancels the left yaw at cruise: N m per Pa of dynamic pressure
      rollRig: 0.1775, // aileron rigging cancels engine-torque roll at cruise: N m per Pa
      slipstreamTail: 0.35, // fraction of propwash dynamic pressure the tail feels
    },

    // ----- landing gear: contact points in body axes (m, relative to CG) -----
    gear: [
      { id: 'nose', pos: [1.6, 0, 1.0], k: 42000, c: 3200, steer: true, brake: false, maxComp: 0.26 },
      { id: 'left', pos: [-0.42, -1.52, 1.0], k: 62000, c: 4800, steer: false, brake: true, maxComp: 0.26 },
      { id: 'right', pos: [-0.42, 1.52, 1.0], k: 62000, c: 4800, steer: false, brake: true, maxComp: 0.26 },
    ],
    tire: { muRoll: 0.022, muBrake: 0.62, muLat: 0.85 },

    // Points that must never touch the ground (a touch = crash / strike)
    hardpoints: [
      { id: 'left wingtip', pos: [-0.35, -5.33, -0.05] },
      { id: 'right wingtip', pos: [-0.35, 5.33, -0.05] },
      { id: 'tail', pos: [-5.3, 0, -0.15] },
      { id: 'propeller', pos: [2.35, 0, 0.8] },
      { id: 'nose', pos: [2.2, 0, 0.45] },
      { id: 'belly', pos: [0.0, 0, 0.5] },
    ],

    // pilot eye point (left seat)
    eye: [0.3, -0.3, -0.58],

    // ----- POH speeds (KIAS) -----
    v: {
      so: 44, // stall, landing config
      s1: 50, // stall, clean
      r: 55, // rotation
      x: 63, // best angle of climb
      y: 79, // best rate of climb
      glide: 73, // best glide
      app: 66, // normal approach, full flaps
      a: 111, // maneuvering speed at gross
      fe: 103, // max flaps extended
      no: 126, // max structural cruising
      ne: 160, // never exceed
    },
    limits: { gPos: 3.8, gNeg: -1.52, maxCrosswindKt: 17 },
  };
})();
