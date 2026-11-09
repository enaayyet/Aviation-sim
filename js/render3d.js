/*
 * render3d.js — a small perspective renderer on a 2D canvas.
 *
 * Views:
 *   cockpit — the pilot's eye, with the cowling, wings and glareshield as attitude references
 *   chase   — behind the airplane, showing control-surface movement and live force vectors
 *   tower   — from the airport, great for watching your own landings
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { U, v3, quat, M } = FS;
  const { mulMV, mulMM, transpose, clamp } = M;

  const HAZE = [178, 194, 206];
  const SKY_TOP = [74, 122, 186];
  const SKY_HOR = [178, 200, 222];
  const SUN = v3.norm([-0.35, 0.45, 0.82]); // direction the sunlight travels (down & toward SE)
  const NEAR = 0.12;

  const rgb = (c, a) => (a === undefined ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`);
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

  // rotation matrices (row-major) about body axes
  const rotZ = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
  const rotY = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
  const rotX = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];

  // ------------------------------------------------------------------ aircraft geometry (body axes, metres)
  const DIH = Math.tan(7 * U.DEG);
  const wingZ = (y) => 0.45 - (Math.abs(y) - 0.55) * DIH;
  const RINGS = [
    // x, half-width, top z, bottom z
    [2.48, 0.06, 0.06, 0.18],
    [2.25, 0.42, -0.2, 0.5],
    [1.0, 0.55, -0.32, 0.56],
    [0.55, 0.58, -0.95, 0.6],
    [-1.4, 0.58, -0.95, 0.6],
    [-2.2, 0.45, -0.75, 0.46],
    [-5.6, 0.1, -0.34, -0.06],
  ];
  const COL = {
    body: [238, 238, 234],
    belly: [205, 205, 200],
    stripe: [168, 36, 40],
    glass: [70, 96, 122],
    wingTop: [232, 232, 228],
    wingBot: [196, 196, 192],
    dark: [40, 40, 44],
    tire: [30, 30, 30],
    cowl: [226, 226, 220],
    antiglare: [36, 40, 48],
    glare: [26, 26, 30],
  };

  function buildAircraft(ac) {
    const f = [];
    const add = (pts, color, opts = {}) => f.push({ pts, color, cockpit: !!opts.cockpit, alpha: opts.alpha, chaseOnly: !!opts.chaseOnly });
    // fuselage
    for (let i = 0; i < RINGS.length - 1; i++) {
      const a = RINGS[i], b = RINGS[i + 1];
      const TLa = [a[0], -a[1], a[2]], TRa = [a[0], a[1], a[2]], BRa = [a[0], a[1], a[3]], BLa = [a[0], -a[1], a[3]];
      const TLb = [b[0], -b[1], b[2]], TRb = [b[0], b[1], b[2]], BRb = [b[0], b[1], b[3]], BLb = [b[0], -b[1], b[3]];
      const isCowl = i <= 1;
      const isWindshield = i === 2;
      const isCabin = i === 3;
      add([TLa, TRa, TRb, TLb], isWindshield ? COL.glass : isCowl ? COL.antiglare : COL.body, { cockpit: isCowl });
      add([TRa, BRa, BRb, TRb], isCabin ? COL.glass : i === 1 ? COL.stripe : COL.body, { cockpit: i === 0 });
      add([TLa, BLa, BLb, TLb], isCabin ? COL.glass : i === 1 ? COL.stripe : COL.body, { cockpit: i === 0 });
      add([BLa, BRa, BRb, BLb], COL.belly);
    }
    const tail = RINGS[RINGS.length - 1];
    add([[tail[0], -tail[1], tail[2]], [tail[0], tail[1], tail[2]], [tail[0], tail[1], tail[3]], [tail[0], -tail[1], tail[3]]], COL.body);

    // wings
    const LE = 0.4, HINGE = -0.85, TE = -1.2, CH = HINGE - TE;
    const flap = ac.s.flapDeg * U.DEG;
    const out = ac.out || {};
    const ail = out.ail || 0;
    for (const s of [-1, 1]) {
      const y0 = 0.55 * s, yF = 2.9 * s, yA = 5.0 * s, yT = 5.33 * s;
      add([[LE, y0, wingZ(y0)], [LE, yT, wingZ(yT)], [HINGE, yT, wingZ(yT)], [HINGE, y0, wingZ(y0)]], COL.wingTop, { cockpit: true });
      // flap: rotates trailing-edge-down about the hinge
      const fx = HINGE - CH * Math.cos(flap), fz = CH * Math.sin(flap);
      add([[HINGE, y0, wingZ(y0)], [HINGE, yF, wingZ(yF)], [fx, yF, wingZ(yF) + fz], [fx, y0, wingZ(y0) + fz]], COL.wingTop, { cockpit: true });
      // aileron: right aileron goes up for a right roll
      const ad = -s * ail; // trailing-edge-down angle
      const ax = HINGE - CH * Math.cos(ad), az = CH * Math.sin(ad);
      add([[HINGE, yF, wingZ(yF)], [HINGE, yA, wingZ(yA)], [ax, yA, wingZ(yA) + az], [ax, yF, wingZ(yF) + az]], COL.wingTop, { cockpit: true });
      add([[HINGE, yA, wingZ(yA)], [HINGE, yT, wingZ(yT)], [TE, yT, wingZ(yT)], [TE, yA, wingZ(yA)]], COL.stripe, { cockpit: true });
      // wheel pants & struts
      const gy = 1.52 * s;
      add([[0.0, gy, 0.62], [-0.85, gy, 0.62], [-0.85, gy, 0.98], [0.0, gy, 0.98]], COL.body, { chaseOnly: true });
      add([[-0.42, gy * 0.97, 0.47], [-0.38, gy * 0.97, 0.47], [-0.38, gy, 0.66], [-0.42, gy, 0.66]], COL.dark, { chaseOnly: true });
    }
    // nose gear
    add([[1.75, 0, 0.66], [1.45, 0, 0.66], [1.45, 0, 1.0], [1.75, 0, 1.0]], COL.tire, { chaseOnly: true });
    add([[1.62, 0, 0.45], [1.58, 0, 0.45], [1.58, 0, 0.7], [1.62, 0, 0.7]], COL.dark, { chaseOnly: true });

    // all-moving stabilator, pivoting about x = -5.0
    const stab = out.stab || 0;
    const sa = -stab; // pulling = trailing edge up = leading edge down
    const piv = [-5.0, 0, -0.22];
    const rs = (x, y, z) => {
      const dx = x - piv[0], dz = z - piv[2];
      return [piv[0] + dx * Math.cos(sa) + dz * Math.sin(sa), y, piv[2] - dx * Math.sin(sa) + dz * Math.cos(sa)];
    };
    add([rs(-4.62, -1.95, -0.22), rs(-4.62, 1.95, -0.22), rs(-5.4, 1.95, -0.22), rs(-5.4, -1.95, -0.22)], COL.wingTop);
    add([rs(-5.25, -1.95, -0.22), rs(-5.25, -1.3, -0.22), rs(-5.4, -1.3, -0.22), rs(-5.4, -1.95, -0.22)], COL.stripe);

    // fin & rudder
    add([[-4.55, 0, -0.32], [-5.25, 0, -1.55], [-5.5, 0, -1.55], [-5.5, 0, -0.3]], COL.body);
    const rud = out.rud || 0;
    const rb = -rud;
    const hx = -5.5;
    const rr = (x, z) => [hx + (x - hx) * Math.cos(rb), (x - hx) * Math.sin(rb), z];
    add([rr(-5.5, -0.3), rr(-5.5, -1.55), rr(-5.82, -1.5), rr(-5.86, -0.3)], COL.stripe);

    // cockpit-only parts: glareshield, A-pillars, panel coaming
    add([[0.78, -0.75, -0.4], [0.78, 0.75, -0.4], [0.62, 0.75, -0.2], [0.62, -0.75, -0.2]], COL.glare, { cockpit: true, cockpitOnly: true });
    f[f.length - 1].cockpitOnly = true;
    for (const s of [-1, 1]) {
      add([[1.05, 0.79 * s, -0.36], [1.04, 0.755 * s, -0.36], [0.5, 0.6 * s, -0.98], [0.51, 0.635 * s, -0.98]], [48, 50, 56], { cockpit: true });
      f[f.length - 1].cockpitOnly = true;
    }
    add([[0.52, -0.6, -0.97], [0.52, 0.6, -0.97], [-0.4, 0.6, -0.99], [-0.4, -0.6, -0.99]], [60, 60, 64], { cockpit: true });
    f[f.length - 1].cockpitOnly = true;
    return f;
  }

  class Renderer {
    constructor(canvas, world) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = world;
      this.cam = [0, 0, -2];
      this.Mwc = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      this.f = 500;
      this.look = { yaw: 0, pitch: 0 };
      this.chase = { offset: null };
      this.rand = M.rng(42);
      this.shake = [0, 0];
      this.resize();
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const r = this.cv.getBoundingClientRect();
      this.W = Math.max(50, Math.round(r.width * dpr));
      this.H = Math.max(50, Math.round(r.height * dpr));
      this.cv.width = this.W;
      this.cv.height = this.H;
      this.dpr = dpr;
    }

    // ---------------------------------------------------------------- camera
    setupCamera(ac, view, dt) {
      const s = ac.s;
      const R = quat.toMatrix(s.q);
      this.R = R;
      const tele = view.tele;
      const W = this.W;
      let C2W; // camera axes (columns) in world
      if (view.mode === 'cockpit') {
        this.look.yaw = M.lowpass(this.look.yaw, view.lookYaw * U.DEG, dt, 0.12);
        this.look.pitch = M.lowpass(this.look.pitch, view.lookPitch * U.DEG, dt, 0.12);
        // buffet and runway rumble
        const buffet = tele.stall > 0.05 && !tele.onGround ? tele.stall : 0;
        const rumble = tele.onGround ? Math.min(1, tele.gs / 40) : 0;
        const amp = buffet * 0.6 * U.DEG + rumble * 0.12 * U.DEG + (ac.wx.cfg.turbulence > 0 ? 0 : 0);
        this.shake[0] = M.lowpass(this.shake[0], (this.rand() - 0.5) * 2 * amp, dt, 0.03);
        this.shake[1] = M.lowpass(this.shake[1], (this.rand() - 0.5) * 2 * amp, dt, 0.03);
        const Rl = mulMM(rotZ(this.look.yaw), rotY(this.look.pitch - 4 * U.DEG + this.shake[0]));
        C2W = mulMM(R, mulMM(Rl, rotX(this.shake[1])));
        const eye = mulMV(R, ac.d.eye);
        this.cam = [s.pos[0] + eye[0], s.pos[1] + eye[1], s.pos[2] + eye[2]];
        this.hfov = view.fov || 74;
      } else {
        let camPos;
        if (view.mode === 'tower') {
          camPos = [520, 150, -14];
          const dist = v3.len(v3.sub(s.pos, camPos));
          this.hfov = clamp(2 * Math.atan(26 / dist) * U.RAD, 4, 70);
        } else {
          // chase: orbit behind, smoothed in heading
          const yaw = quat.toEuler(s.q).yaw + view.orbitYaw * U.DEG;
          const pit = view.orbitPitch * U.DEG;
          const d = view.orbitDist;
          const want = [-Math.cos(yaw) * Math.cos(pit) * d, -Math.sin(yaw) * Math.cos(pit) * d, -Math.sin(pit) * d];
          if (!this.chase.offset || view.snap) this.chase.offset = want;
          const k = 1 - Math.exp(-dt * 3);
          this.chase.offset = this.chase.offset.map((v, i) => v + (want[i] - v) * k);
          camPos = v3.add(s.pos, this.chase.offset);
          if (camPos[2] > -1.2) camPos[2] = -1.2;
          this.hfov = 62;
        }
        const fwd = v3.norm(v3.sub(s.pos, camPos));
        let right = v3.cross([0, 0, 1], fwd);
        if (v3.len(right) < 1e-3) right = [0, 1, 0];
        right = v3.norm(right);
        const down = v3.cross(fwd, right);
        C2W = [fwd[0], right[0], down[0], fwd[1], right[1], down[1], fwd[2], right[2], down[2]];
        this.cam = camPos;
      }
      this.Mwc = transpose(C2W);
      this.f = W / 2 / Math.tan((this.hfov * U.DEG) / 2);
      this.cx = W / 2;
      this.cy = this.H / 2;
      this.tanH = Math.tan((this.hfov * U.DEG) / 2) * 1.1;
      this.tanV = (this.tanH * this.H) / W;
    }

    toCam(p) {
      const m = this.Mwc, c = this.cam;
      const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
      return [m[0] * dx + m[1] * dy + m[2] * dz, m[3] * dx + m[4] * dy + m[5] * dz, m[6] * dx + m[7] * dy + m[8] * dz];
    }

    proj(c) {
      return [this.cx + (this.f * c[1]) / c[0], this.cy + (this.f * c[2]) / c[0]];
    }

    /** Clip a camera-space polygon to the near plane and project it. */
    clipProject(cpts) {
      const out = [];
      const n = cpts.length;
      for (let i = 0; i < n; i++) {
        const a = cpts[i], b = cpts[(i + 1) % n];
        const ain = a[0] >= NEAR, bin = b[0] >= NEAR;
        if (ain) out.push(this.proj(a));
        if (ain !== bin) {
          const t = (NEAR - a[0]) / (b[0] - a[0]);
          out.push(this.proj([NEAR, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]));
        }
      }
      return out.length >= 3 ? out : null;
    }

    fillPoly(pts, style) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = style;
      ctx.fill();
    }

    fog(c, dist) {
      const k = 1 - Math.exp(-dist / this.visibility);
      return mix(c, HAZE, clamp(k, 0, 0.92));
    }

    // ---------------------------------------------------------------- main entry
    render(ac, view, dt) {
      const ctx = this.ctx;
      this.visibility = view.visibility || 14000;
      this.setupCamera(ac, view, dt);
      ctx.save();
      this.drawSkyGround();
      this.drawHills();
      this.drawFlat();
      const camH = -this.cam[2];
      if (view.mode !== 'cockpit' && -ac.s.pos[2] < 400) this.drawShadow(ac);
      this.drawObjects(ac, view);
      if (view.mode !== 'cockpit' && view.showForces) this.drawForceVectors(ac, view.tele);
      if (view.mode === 'cockpit' && view.showAids && Math.abs(this.look.yaw) < 0.2) this.drawHudAids(ac, view.tele);
      ctx.restore();
      void camH;
    }

    drawSkyGround() {
      const ctx = this.ctx, W = this.W, H = this.H, f = this.f, cx = this.cx, cy = this.cy;
      const m = this.Mwc;
      const D = [m[2], m[5], m[8]]; // world-down expressed in camera axes
      const g = (x, y) => D[0] * f + D[1] * (x - cx) + D[2] * (y - cy);
      const rect = [[0, 0], [W, 0], [W, H], [0, H]];
      const clip = (sign) => {
        const out = [];
        for (let i = 0; i < 4; i++) {
          const a = rect[i], b = rect[(i + 1) % 4];
          const ga = sign * g(a[0], a[1]), gb = sign * g(b[0], b[1]);
          if (ga >= 0) out.push(a);
          if (ga >= 0 !== gb >= 0) {
            const t = ga / (ga - gb);
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
          }
        }
        return out;
      };
      const nl = Math.hypot(D[1], D[2]);
      let hx = cx, hy = cy, nx = 0, ny = 1;
      if (nl > 1e-4) {
        nx = D[1] / nl;
        ny = D[2] / nl;
        const t = (-D[0] * f) / nl;
        hx = cx + nx * t;
        hy = cy + ny * t;
      }
      const span = f * 1.2;
      const sky = clip(-1);
      if (sky.length >= 3) {
        const gr = ctx.createLinearGradient(hx, hy, hx - nx * span, hy - ny * span);
        gr.addColorStop(0, rgb(SKY_HOR));
        gr.addColorStop(0.25, rgb(mix(SKY_HOR, SKY_TOP, 0.55)));
        gr.addColorStop(1, rgb(SKY_TOP));
        this.fillPoly(sky, gr);
      }
      const ground = clip(1);
      if (ground.length >= 3) {
        const gr = ctx.createLinearGradient(hx, hy, hx + nx * f * 0.25, hy + ny * f * 0.25);
        gr.addColorStop(0, rgb(mix(FS.World.COLORS.grass, HAZE, 0.8)));
        gr.addColorStop(1, rgb(mix(FS.World.COLORS.grass, HAZE, 0.35)));
        this.fillPoly(ground, gr);
      }
      this.horizon = { hx, hy, nx, ny };
    }

    drawHills() {
      // the hills ride along with the camera horizontally, so they always sit on the far horizon
      const ctx = this.ctx;
      let last = null;
      for (const h of this.world.hills) {
        const c = h.pts.map((p) => this.toCam([p[0] + this.cam[0], p[1] + this.cam[1], p[2]]));
        if (c.every((q) => q[0] < NEAR)) continue;
        const pp = this.clipProject(c);
        if (!pp) continue;
        const col = h.color === last ? ctx.fillStyle : rgb(mix(h.color, HAZE, 0.5));
        last = h.color;
        ctx.beginPath();
        ctx.moveTo(pp[0][0], pp[0][1]);
        for (let i = 1; i < pp.length; i++) ctx.lineTo(pp[i][0], pp[i][1]);
        ctx.closePath();
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = col; // hide hairline seams between segments
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    drawFlat() {
      const cam = this.cam;
      const hAbove = Math.max(2, -cam[2]);
      const maxD = Math.min(26000, 5000 + hAbove * 18);
      for (const p of this.world.flat) {
        const dn = p.cn - cam[0], de = p.ce - cam[1];
        const dist = Math.hypot(dn, de);
        if (dist - p.r > maxD) continue;
        const cc = this.toCam([p.cn, p.ce, 0]);
        if (cc[0] < -p.r) continue;
        if (cc[0] > 0 && Math.abs(cc[1]) > cc[0] * this.tanH + p.r * 1.5) continue;
        if (cc[0] > 0 && Math.abs(cc[2]) > cc[0] * this.tanV + p.r * 1.5) continue;
        const cpts = p.pts.map((q) => this.toCam(q));
        const pp = this.clipProject(cpts);
        if (!pp) continue;
        const d3 = Math.hypot(dist, hAbove);
        this.fillPoly(pp, rgb(this.fog(p.color, Math.max(0, d3 - p.r * 0.5))));
      }
    }

    drawShadow(ac) {
      const ctx = this.ctx;
      const R = this.R;
      const s = ac.s;
      const faces = buildAircraft(ac);
      ctx.beginPath();
      let any = false;
      for (const fc of faces) {
        if (fc.cockpitOnly) continue;
        const cpts = fc.pts.map((p) => {
          const w = mulMV(R, p);
          const P = [s.pos[0] + w[0], s.pos[1] + w[1], s.pos[2] + w[2]];
          const t = -P[2] / SUN[2];
          return this.toCam([P[0] + SUN[0] * t, P[1] + SUN[1] * t, 0]);
        });
        const pp = this.clipProject(cpts);
        if (!pp) continue;
        any = true;
        ctx.moveTo(pp[0][0], pp[0][1]);
        for (let i = 1; i < pp.length; i++) ctx.lineTo(pp[i][0], pp[i][1]);
        ctx.closePath();
      }
      if (any) {
        const h = -s.pos[2];
        ctx.fillStyle = `rgba(0,0,0,${clamp(0.32 - h / 1400, 0.05, 0.32)})`;
        ctx.fill('nonzero');
      }
    }

    // ---------------------------------------------------------------- 3D objects
    drawObjects(ac, view) {
      const items = [];
      const cam = this.cam;
      const wx = ac.wx;
      for (const o of this.world.objects) {
        const dn = o.p[0] - cam[0], de = o.p[1] - cam[1];
        const d = Math.hypot(dn, de, o.p[2] - cam[2]);
        const lim = o.type === 'light' ? 3500 : o.type === 'tree' ? 7000 : 16000;
        if (d > lim) continue;
        const c = this.toCam(o.p);
        if (c[0] < -40) continue;
        items.push({ o, d, depth: c[0] });
      }
      // aircraft faces
      const R = this.R;
      const s = ac.s;
      const faces = buildAircraft(ac);
      const acItems = [];
      const cockpit = view.mode === 'cockpit';
      for (const fc of faces) {
        if (cockpit && !fc.cockpit) continue;
        if (!cockpit && fc.cockpitOnly) continue;
        if (cockpit && fc.chaseOnly) continue;
        const wpts = fc.pts.map((p) => {
          const w = mulMV(R, p);
          return [s.pos[0] + w[0], s.pos[1] + w[1], s.pos[2] + w[2]];
        });
        const cpts = wpts.map((p) => this.toCam(p));
        let depth = 0;
        for (const c of cpts) depth += c[0];
        depth /= cpts.length;
        const n = v3.cross(v3.sub(wpts[1], wpts[0]), v3.sub(wpts[2], wpts[0]));
        const nl = v3.len(n) || 1;
        const lit = Math.abs(v3.dot(n, SUN)) / nl;
        acItems.push({ ac: true, cpts, depth, color: shade(fc.color, 0.62 + 0.42 * lit), alpha: fc.alpha });
      }
      acItems.sort((a, b) => b.depth - a.depth);
      const acDepth = this.toCam(s.pos)[0];
      items.sort((a, b) => b.depth - a.depth);
      let acDrawn = false;
      for (const it of items) {
        if (!acDrawn && it.depth < acDepth) {
          this.drawAircraftFaces(acItems, ac, cockpit);
          acDrawn = true;
        }
        this.drawObject(it.o, it.d, wx);
      }
      if (!acDrawn) this.drawAircraftFaces(acItems, ac, cockpit);
    }

    drawAircraftFaces(list, ac, cockpit) {
      for (const it of list) {
        const pp = this.clipProject(it.cpts);
        if (pp) this.fillPoly(pp, rgb(it.color, it.alpha));
      }
      this.drawProp(ac, cockpit);
    }

    drawProp(ac, cockpit) {
      const R = this.R, s = ac.s;
      const rpm = (s.omegaP * 60) / (2 * Math.PI);
      const hub = [2.5, 0, 0.12];
      const toC = (p) => {
        const w = mulMV(R, p);
        return this.toCam([s.pos[0] + w[0], s.pos[1] + w[1], s.pos[2] + w[2]]);
      };
      // disc
      if (rpm > 400 && !cockpit) {
        const pts = [];
        for (let k = 0; k < 20; k++) {
          const a = (k / 20) * Math.PI * 2;
          pts.push(toC([hub[0], Math.cos(a) * 0.94, hub[2] + Math.sin(a) * 0.94]));
        }
        const pp = this.clipProject(pts);
        if (pp) this.fillPoly(pp, cockpit ? 'rgba(30,30,30,0.07)' : 'rgba(30,30,30,0.16)');
      }
      // blades (visible when slow)
      const alpha = rpm < 250 ? 0.95 : cockpit ? 0 : rpm < 900 ? 0.4 : 0.12;
      if (alpha <= 0) return;
      const a = ac.propAngle;
      for (const sgn of [1, -1]) {
        const dy = Math.cos(a) * sgn, dz = Math.sin(a) * sgn;
        const py = -dz * 0.06, pz = dy * 0.06;
        const pts = [
          [hub[0], dy * 0.12 + py, hub[2] + dz * 0.12 + pz],
          [hub[0], dy * 0.94 + py * 0.6, hub[2] + dz * 0.94 + pz * 0.6],
          [hub[0], dy * 0.94 - py * 0.6, hub[2] + dz * 0.94 - pz * 0.6],
          [hub[0], dy * 0.12 - py, hub[2] + dz * 0.12 - pz],
        ].map(toC);
        const pp = this.clipProject(pts);
        if (pp) this.fillPoly(pp, `rgba(25,25,28,${alpha})`);
      }
    }

    drawObject(o, d, wx) {
      const ctx = this.ctx;
      switch (o.type) {
        case 'tree': {
          const base = this.toCam(o.p);
          const top = this.toCam([o.p[0], o.p[1], -o.h * 0.62]);
          if (base[0] < NEAR || top[0] < NEAR) return;
          const b = this.proj(base), t = this.proj(top);
          const r = (this.f * o.r) / top[0];
          if (r < 0.4) return;
          ctx.strokeStyle = rgb(this.fog(FS.World.COLORS.trunk, d));
          ctx.lineWidth = Math.max(1, (this.f * 0.5) / base[0]);
          ctx.beginPath();
          ctx.moveTo(b[0], b[1]);
          ctx.lineTo(t[0], t[1]);
          ctx.stroke();
          ctx.fillStyle = rgb(this.fog(shade(FS.World.COLORS.tree, o.shade), d));
          ctx.beginPath();
          ctx.ellipse(t[0], t[1], r, r * 1.15, 0, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'box':
          this.drawBox(o, d);
          break;
        case 'tower': {
          const base = this.toCam(o.p);
          const top = this.toCam([o.p[0], o.p[1], -o.h]);
          if (base[0] < NEAR || top[0] < NEAR) return;
          const b = this.proj(base), t = this.proj(top);
          const w = Math.max(1, (this.f * o.r) / base[0]);
          ctx.fillStyle = rgb(this.fog(o.color, d));
          ctx.beginPath();
          ctx.moveTo(b[0] - w, b[1]);
          ctx.lineTo(t[0] - w, t[1]);
          ctx.lineTo(t[0] + w, t[1]);
          ctx.lineTo(b[0] + w, b[1]);
          ctx.fill();
          ctx.beginPath();
          ctx.ellipse(t[0], t[1], w * (o.label === 'water tower' ? 2.2 : 1), w * (o.label === 'water tower' ? 1.6 : 0.8), 0, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'windsock':
          this.drawWindsock(o, d, wx);
          break;
        case 'papi': {
          const c = this.toCam([o.p[0], o.p[1], -0.6]);
          if (c[0] < NEAR) return;
          const p = this.proj(c);
          const col = this.world.papiLight(o.idx, this.cam);
          const r = Math.max(2.2 * this.dpr, (this.f * 0.5) / c[0]);
          ctx.fillStyle = col === 'W' ? '#fffdf0' : '#ff2a1a';
          ctx.shadowColor = ctx.fillStyle;
          ctx.shadowBlur = 6;
          ctx.beginPath();
          ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          break;
        }
        case 'light': {
          const c = this.toCam(o.p);
          if (c[0] < NEAR) return;
          const p = this.proj(c);
          const r = Math.max(0.9 * this.dpr, (this.f * 0.18) / c[0]);
          ctx.fillStyle = rgb(o.color, clamp(1.4 - d / 3000, 0.2, 1));
          ctx.fillRect(p[0] - r, p[1] - r, r * 2, r * 2);
          break;
        }
      }
    }

    drawBox(o, d) {
      const [n, e] = o.p;
      const hl = o.l / 2, hw = o.w / 2, h = o.h;
      const P = [
        [n - hl, e - hw, 0], [n + hl, e - hw, 0], [n + hl, e + hw, 0], [n - hl, e + hw, 0],
        [n - hl, e - hw, -h], [n + hl, e - hw, -h], [n + hl, e + hw, -h], [n - hl, e + hw, -h],
      ];
      const faces = [
        { i: [0, 1, 5, 4], n: [0, -1, 0] },
        { i: [1, 2, 6, 5], n: [1, 0, 0] },
        { i: [2, 3, 7, 6], n: [0, 1, 0] },
        { i: [3, 0, 4, 7], n: [-1, 0, 0] },
        { i: [4, 5, 6, 7], n: [0, 0, -1], roof: true },
      ];
      const C = P.map((p) => this.toCam(p));
      for (const fc of faces) {
        const p0 = P[fc.i[0]];
        const toCamV = [p0[0] - this.cam[0], p0[1] - this.cam[1], p0[2] - this.cam[2]];
        if (v3.dot(fc.n, toCamV) >= 0) continue; // back face
        const pp = this.clipProject(fc.i.map((k) => C[k]));
        if (!pp) continue;
        const lit = Math.max(0, -v3.dot(fc.n, SUN));
        const base = fc.roof ? o.roof : o.color;
        this.fillPoly(pp, rgb(this.fog(shade(base, 0.6 + 0.45 * lit), d)));
      }
    }

    drawWindsock(o, d, wx) {
      const ctx = this.ctx;
      const [n, e] = o.p;
      const H = 6.5;
      const base = this.toCam([n, e, 0]);
      const top = this.toCam([n, e, -H]);
      if (base[0] < NEAR || top[0] < NEAR) return;
      const b = this.proj(base), t = this.proj(top);
      ctx.strokeStyle = rgb(this.fog([90, 90, 90], d));
      ctx.lineWidth = Math.max(1, (this.f * 0.12) / base[0]);
      ctx.beginPath();
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(t[0], t[1]);
      ctx.stroke();
      // the sock streams downwind and droops in light wind (fully straight at 15 kt)
      const w = wx.windAt(H);
      const spd = Math.hypot(w[0], w[1]) / U.KT;
      const droop = (1 - clamp(spd / 15, 0, 1)) * 75 * U.DEG;
      const dirN = spd > 0.3 ? w[0] / Math.hypot(w[0], w[1]) : 0.0001;
      const dirE = spd > 0.3 ? w[1] / Math.hypot(w[0], w[1]) : 0;
      const L = 3.2;
      let prev = [n, e, -H];
      for (let k = 0; k < 5; k++) {
        const t2 = (k + 1) / 5;
        const ang = droop * t2;
        const p = [n + dirN * L * t2 * Math.cos(ang), e + dirE * L * t2 * Math.cos(ang), -H + L * t2 * Math.sin(ang)];
        const c0 = this.toCam(prev), c1 = this.toCam(p);
        if (c0[0] > NEAR && c1[0] > NEAR) {
          const a = this.proj(c0), b2 = this.proj(c1);
          ctx.strokeStyle = rgb(this.fog(k % 2 ? [245, 245, 240] : [255, 110, 20], d));
          ctx.lineWidth = Math.max(1.2, (this.f * (0.45 - 0.05 * k)) / c0[0]);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b2[0], b2[1]);
          ctx.stroke();
        }
        prev = p;
      }
    }

    // ---------------------------------------------------------------- teaching overlays
    arrow3d(from, dirW, len, color, label, width = 3, labelAtStart = false) {
      const ctx = this.ctx;
      const to = [from[0] + dirW[0] * len, from[1] + dirW[1] * len, from[2] + dirW[2] * len];
      const a = this.toCam(from), b = this.toCam(to);
      if (a[0] < NEAR || b[0] < NEAR) return;
      const pa = this.proj(a), pb = this.proj(b);
      const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
      const l = Math.hypot(dx, dy);
      if (l < 2) return;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width * this.dpr;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
      ctx.stroke();
      const ux = dx / l, uy = dy / l;
      const hs = Math.min(14 * this.dpr, l * 0.4);
      ctx.beginPath();
      ctx.moveTo(pb[0] + ux * 2, pb[1] + uy * 2);
      ctx.lineTo(pb[0] - ux * hs - uy * hs * 0.5, pb[1] - uy * hs + ux * hs * 0.5);
      ctx.lineTo(pb[0] - ux * hs + uy * hs * 0.5, pb[1] - uy * hs - ux * hs * 0.5);
      ctx.closePath();
      ctx.fill();
      if (label) {
        ctx.font = `600 ${12 * this.dpr}px system-ui, sans-serif`;
        ctx.lineWidth = 3 * this.dpr;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        const lx = labelAtStart ? pa[0] - ux * 10 - 40 * this.dpr : pb[0] + ux * 10 + 4;
        const ly = labelAtStart ? pa[1] - uy * 10 - 6 : pb[1] + uy * 10 + 4;
        ctx.strokeText(label, lx, ly);
        ctx.fillText(label, lx, ly);
      }
    }

    drawForceVectors(ac, t) {
      const f = ac.out;
      if (!f) return;
      const R = this.R;
      const cg = ac.s.pos;
      const W = ac.mass * U.G;
      const scale = 6; // metres of arrow for one airplane-weight
      const td = 5; // thrust & drag are ~1/10 of weight: magnify so they're visible
      const lift = mulMV(R, f.liftDirB);
      const drag = mulMV(R, f.dragDirB);
      const thr = mulMV(R, [1, 0, 0]);
      const lb = (n) => `${Math.round(n / U.LBF).toLocaleString()} lb`;
      this.arrow3d(cg, [0, 0, 1], scale, '#ff5a4e', `Weight ${lb(W)}`);
      if (f.lift > 1) this.arrow3d(cg, lift, (scale * f.lift) / W, '#4fa3ff', `Lift ${lb(f.lift)}`);
      if (f.thrust > 1) this.arrow3d(cg, thr, (scale * td * f.thrust) / W, '#3ee08f', `Thrust ${lb(f.thrust)} (×${td})`);
      if (f.drag > 1) this.arrow3d(cg, drag, (scale * td * f.drag) / W, '#ffb03b', `Drag ${lb(f.drag)} (×${td})`);
      // relative wind
      if (f.V > 3) {
        const rw = mulMV(R, [-f.vb[0] / f.V, -f.vb[1] / f.V, -f.vb[2] / f.V]);
        const start = [cg[0] - rw[0] * 9, cg[1] - rw[1] * 9, cg[2] - rw[2] * 9];
        this.arrow3d(start, rw, 4, 'rgba(255,255,255,0.75)', 'relative wind', 1.5, true);
      }
      void t;
    }

    drawHudAids(ac, t) {
      const ctx = this.ctx;
      const s = ac.s;
      const R = this.R;
      const dpr = this.dpr;
      // boresight: where the nose points
      const nose = mulMV(R, [1000, 0, 0]);
      const cn = this.toCam([this.cam[0] + nose[0], this.cam[1] + nose[1], this.cam[2] + nose[2]]);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = 'rgba(255,230,90,0.9)';
      if (cn[0] > NEAR) {
        const p = this.proj(cn);
        ctx.beginPath();
        ctx.moveTo(p[0] - 26 * dpr, p[1]);
        ctx.lineTo(p[0] - 12 * dpr, p[1]);
        ctx.lineTo(p[0] - 6 * dpr, p[1] + 7 * dpr);
        ctx.lineTo(p[0], p[1]);
        ctx.lineTo(p[0] + 6 * dpr, p[1] + 7 * dpr);
        ctx.lineTo(p[0] + 12 * dpr, p[1]);
        ctx.lineTo(p[0] + 26 * dpr, p[1]);
        ctx.stroke();
      }
      // flight path vector: where the airplane is actually going
      const v = s.vel;
      const vl = v3.len(v);
      if (vl > 8) {
        const k = 1000 / vl;
        const cp = this.toCam([this.cam[0] + v[0] * k, this.cam[1] + v[1] * k, this.cam[2] + v[2] * k]);
        if (cp[0] > NEAR) {
          const p = this.proj(cp);
          ctx.strokeStyle = 'rgba(90,255,140,0.95)';
          ctx.beginPath();
          ctx.arc(p[0], p[1], 7 * dpr, 0, Math.PI * 2);
          ctx.moveTo(p[0] - 7 * dpr, p[1]);
          ctx.lineTo(p[0] - 18 * dpr, p[1]);
          ctx.moveTo(p[0] + 7 * dpr, p[1]);
          ctx.lineTo(p[0] + 18 * dpr, p[1]);
          ctx.moveTo(p[0], p[1] - 7 * dpr);
          ctx.lineTo(p[0], p[1] - 14 * dpr);
          ctx.stroke();
        }
      }
      void t;
    }
  }

  FS.Renderer = Renderer;
  FS.buildAircraft = buildAircraft;
})();
