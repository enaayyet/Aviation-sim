/*
 * math.js — small vector / quaternion toolkit and unit constants.
 *
 * Frames used throughout the simulator (standard aerospace convention):
 *   World  (NED): x = North, y = East, z = Down. Origin = runway 36 threshold, z = 0 is field elevation.
 *   Body        : x = out the nose, y = out the right wing, z = out the belly.
 *   Positive rotations: roll right-wing-down, pitch nose-up, yaw nose-right.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});

  const DEG = Math.PI / 180;
  const U = {
    DEG,
    RAD: 180 / Math.PI,
    KT: 0.514444, // m/s per knot
    FT: 0.3048, // m per foot
    NM: 1852, // m per nautical mile
    FPM: 0.3048 / 60, // m/s per ft/min
    LB: 0.45359237, // kg per pound (mass)
    LBF: 4.4482216, // N per pound-force
    HP: 745.7, // W per horsepower
    INHG: 3386.389, // Pa per inch of mercury
    G: 9.80665, // m/s^2
    GAL: 6.0, // lb per US gallon of avgas
  };

  // ---------- scalar helpers ----------
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const wrap360 = (d) => ((d % 360) + 360) % 360;
  const wrap180 = (d) => {
    d = wrap360(d);
    return d > 180 ? d - 360 : d;
  };
  const wrapPi = (a) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };
  /** Move `cur` toward `target` by at most `maxStep`. */
  const approach = (cur, target, maxStep) => {
    if (cur < target) return Math.min(cur + maxStep, target);
    return Math.max(cur - maxStep, target);
  };
  /** First-order low-pass filter step (time constant tau seconds). */
  const lowpass = (cur, target, dt, tau) => (tau <= 0 ? target : cur + (target - cur) * (1 - Math.exp(-dt / tau)));

  // ---------- 3-vectors as plain arrays ----------
  const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => {
      const l = Math.hypot(a[0], a[1], a[2]) || 1;
      return [a[0] / l, a[1] / l, a[2] / l];
    },
    addScaled: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
  };

  // ---------- quaternions [w, x, y, z]; rotate body -> world ----------
  const quat = {
    identity: () => [1, 0, 0, 0],
    /** Euler ZYX (yaw psi, pitch theta, roll phi), radians. */
    fromEuler(roll, pitch, yaw) {
      const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
      const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
      const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
      return [
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
      ];
    },
    toEuler(q) {
      const [w, x, y, z] = q;
      const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
      const pitch = Math.asin(clamp(2 * (w * y - z * x), -1, 1));
      const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
      return { roll, pitch, yaw };
    },
    mul(a, b) {
      return [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
      ];
    },
    normalize(q) {
      const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
    },
    /** Row-major 3x3 rotation matrix, body -> world. */
    toMatrix(q) {
      const [w, x, y, z] = q;
      return [
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
      ];
    },
  };

  /** Multiply row-major 3x3 matrix by vector. */
  const mulMV = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
  /** Multiply transpose of row-major 3x3 by vector (world -> body when m is body->world). */
  const mulMTV = (m, v) => [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
  /** 3x3 product a*b (row-major). */
  const mulMM = (a, b) => {
    const r = new Array(9);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r;
  };
  const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

  /** Deterministic PRNG (mulberry32) so scenery and turbulence are repeatable. */
  function rng(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    next.gauss = () => {
      if (spare !== null) {
        const s = spare;
        spare = null;
        return s;
      }
      let u = 0, v = 0;
      while (u === 0) u = next();
      v = next();
      const mag = Math.sqrt(-2 * Math.log(u));
      spare = mag * Math.sin(2 * Math.PI * v);
      return mag * Math.cos(2 * Math.PI * v);
    };
    next.range = (lo, hi) => lo + (hi - lo) * next();
    return next;
  }

  FS.U = U;
  FS.v3 = v3;
  FS.quat = quat;
  FS.M = { clamp, lerp, smoothstep, wrap360, wrap180, wrapPi, approach, lowpass, mulMV, mulMTV, mulMM, transpose, rng };
})();
