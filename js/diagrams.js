/*
 * diagrams.js — the live "Four Forces" diagram and the moving map.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { U, M } = FS;
  const { clamp, mulMV } = M;

  const COLORS = { lift: '#4fa3ff', weight: '#ff5a4e', thrust: '#3ee08f', drag: '#ffb03b', wind: 'rgba(255,255,255,0.7)', net: '#d18cff' };

  function arrow(ctx, x0, y0, dx, dy, color, width, label, dash) {
    const l = Math.hypot(dx, dy);
    if (l < 1.5) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + dx, y0 + dy);
    ctx.stroke();
    ctx.setLineDash([]);
    const ux = dx / l, uy = dy / l;
    const hs = Math.min(10, l * 0.45);
    ctx.beginPath();
    ctx.moveTo(x0 + dx + ux * 2, y0 + dy + uy * 2);
    ctx.lineTo(x0 + dx - ux * hs - uy * hs * 0.5, y0 + dy - uy * hs + ux * hs * 0.5);
    ctx.lineTo(x0 + dx - ux * hs + uy * hs * 0.5, y0 + dy - uy * hs - ux * hs * 0.5);
    ctx.closePath();
    ctx.fill();
    if (label) {
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = ux > 0.3 ? 'left' : ux < -0.3 ? 'right' : 'center';
      ctx.textBaseline = uy > 0.3 ? 'top' : uy < -0.3 ? 'bottom' : 'middle';
      ctx.fillText(label, x0 + dx + ux * 6, y0 + dy + uy * 6);
    }
    ctx.restore();
  }

  // side silhouette of a low-wing trainer (x forward, y down), metres
  const SIDE = [[2.5, 0.1], [2.2, -0.25], [1.0, -0.35], [0.55, -0.95], [-1.4, -0.95], [-2.2, -0.75], [-5.0, -0.4], [-5.25, -1.55], [-5.55, -1.55], [-5.65, -0.06], [-2.2, 0.46], [1.0, 0.56], [2.2, 0.5]];
  const FRONT_WING = (b) => {
    const t = Math.tan(7 * U.DEG);
    return [[-5.33, 0.45 - 4.78 * t], [-0.55, 0.45], [0.55, 0.45], [5.33, 0.45 - 4.78 * t]];
  };

  class ForcesDiagram {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.resize();
    }
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = this.cv.getBoundingClientRect();
      this.dpr = dpr;
      this.cv.width = Math.max(10, Math.round(r.width * dpr));
      this.cv.height = Math.max(10, Math.round(r.height * dpr));
      this.W = r.width;
      this.H = r.height;
    }

    draw(ac) {
      const ctx = this.ctx;
      const f = ac.out;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);
      if (!f) return;
      const W = this.W, H = this.H;
      const split = W > 420 ? 'h' : 'v';
      if (split === 'h') {
        this.side(ctx, ac, f, 0, 0, W * 0.58, H);
        this.front(ctx, ac, f, W * 0.58, 0, W * 0.42, H);
      } else {
        this.side(ctx, ac, f, 0, 0, W, H * 0.58);
        this.front(ctx, ac, f, 0, H * 0.58, W, H * 0.42);
      }
    }

    /** Side view: the vertical plane containing the flight path. */
    side(ctx, ac, f, x, y, w, h) {
      const R = f.R;
      const Wt = ac.mass * U.G;
      // horizontal direction of travel through the air
      const vAir = [ac.s.vel[0] - f.wind[0], ac.s.vel[1] - f.wind[1], ac.s.vel[2] - f.wind[2]];
      let hx = vAir[0], hy = vAir[1];
      let hl = Math.hypot(hx, hy);
      if (hl < 1) {
        hx = R[0];
        hy = R[3];
        hl = Math.hypot(hx, hy) || 1;
      }
      hx /= hl;
      hy /= hl;
      // project a world vector into (forward, up) of this plane
      const P = (v) => [v[0] * hx + v[1] * hy, -v[2]];
      const cx = x + w * 0.5, cy = y + h * 0.52;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(x, y, w, h);
      // horizon
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x + 6, cy);
      ctx.lineTo(x + w - 6, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('SIDE VIEW', x + 6, y + 13);
      // airplane silhouette at pitch
      const sc = Math.min(w / 13, h / 9);
      const nose = P(mulMV(R, [1, 0, 0]));
      const down = P(mulMV(R, [0, 0, 1]));
      ctx.fillStyle = 'rgba(220,226,235,0.85)';
      ctx.beginPath();
      SIDE.forEach(([bx, bz], i) => {
        const px = cx + (nose[0] * bx + down[0] * bz) * sc;
        const py = cy - (nose[1] * bx + down[1] * bz) * sc;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
      // wing chord line
      ctx.strokeStyle = 'rgba(80,90,110,0.9)';
      ctx.lineWidth = 3;
      const wl = [[0.4, 0.45], [-1.2, 0.45]].map(([bx, bz]) => [cx + (nose[0] * bx + down[0] * bz) * sc, cy - (nose[1] * bx + down[1] * bz) * sc]);
      ctx.beginPath();
      ctx.moveTo(wl[0][0], wl[0][1]);
      ctx.lineTo(wl[1][0], wl[1][1]);
      ctx.stroke();

      const L = Math.min(h * 0.38, w * 0.3); // length of one "weight"
      const td = 5;
      // relative wind (comes FROM ahead, along the air path)
      if (f.V > 3) {
        const vw = P(vAir);
        const vl = Math.hypot(vw[0], vw[1]) || 1;
        const ux = vw[0] / vl, uy = vw[1] / vl;
        arrow(ctx, cx + ux * L * 1.25, cy - uy * L * 1.25, -ux * L * 0.55, uy * L * 0.55, COLORS.wind, 1.5, 'relative wind', [5, 4]);
        // AoA arc between chord (nose) and relative wind
        const a1 = Math.atan2(-nose[1], nose[0]);
        const a2 = Math.atan2(-uy, ux);
        ctx.strokeStyle = 'rgba(255,230,90,0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const r0 = sc * 3.2;
        ctx.arc(cx, cy, r0, Math.min(a1, a2), Math.max(a1, a2));
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,230,90,0.95)';
        ctx.font = '700 12px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`α ${(f.alpha * U.RAD).toFixed(1)}°`, cx + r0 + 4, cy - r0 * 0.15 - 2);
      }
      const lw = P(mulMV(R, f.liftDirB));
      const dw = P(mulMV(R, f.dragDirB));
      const tw = P(mulMV(R, [1, 0, 0]));
      const lb = (n) => `${Math.round(n / U.LBF).toLocaleString()}`;
      arrow(ctx, cx, cy, 0, L, COLORS.weight, 3, `W ${lb(Wt)}`);
      arrow(ctx, cx, cy, lw[0] * (L * f.lift) / Wt, -lw[1] * (L * f.lift) / Wt, COLORS.lift, 3, `L ${lb(f.lift)}`);
      if (f.thrust > 0) arrow(ctx, cx, cy, tw[0] * (L * td * f.thrust) / Wt, -tw[1] * (L * td * f.thrust) / Wt, COLORS.thrust, 3, `T ${lb(f.thrust)}`);
      arrow(ctx, cx, cy, dw[0] * (L * td * f.drag) / Wt, -dw[1] * (L * td * f.drag) / Wt, COLORS.drag, 3, `D ${lb(f.drag)}`);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('T & D drawn ×5 · lbf', x + w - 6, y + h - 6);
      ctx.restore();
    }

    /** Rear view: shows the lift vector tilting in a bank. */
    front(ctx, ac, f, x, y, w, h) {
      const R = f.R;
      const Wt = ac.mass * U.G;
      const yawAng = Math.atan2(R[3], R[0]);
      const fx = Math.cos(yawAng), fy = Math.sin(yawAng);
      // plane perpendicular to heading: right = (-fy, fx, 0), up = (0,0,-1)
      const P = (v) => [-v[0] * fy + v[1] * fx, -v[2]];
      const cx = x + w * 0.5, cy = y + h * 0.5;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('FROM BEHIND', x + 6, y + 13);
      const sc = Math.min(w / 13, h / 7);
      const right = P(mulMV(R, [0, 1, 0]));
      const down = P(mulMV(R, [0, 0, 1]));
      const toS = (by, bz) => [cx + (right[0] * by + down[0] * bz) * sc, cy - (right[1] * by + down[1] * bz) * sc];
      ctx.strokeStyle = 'rgba(220,226,235,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      FRONT_WING().forEach(([by, bz], i) => {
        const p = toS(by, bz);
        if (i === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      });
      ctx.stroke();
      ctx.fillStyle = 'rgba(220,226,235,0.9)';
      ctx.beginPath();
      const c0 = toS(0, -0.2);
      ctx.arc(c0[0], c0[1], sc * 0.6, 0, Math.PI * 2);
      ctx.fill();
      const fin = [toS(0, -0.6), toS(0, -1.6)];
      ctx.beginPath();
      ctx.moveTo(fin[0][0], fin[0][1]);
      ctx.lineTo(fin[1][0], fin[1][1]);
      ctx.stroke();

      const L = Math.min(h * 0.34, w * 0.3);
      const lw = P(mulMV(R, f.liftDirB));
      const lx = (lw[0] * L * f.lift) / Wt, ly = (lw[1] * L * f.lift) / Wt;
      arrow(ctx, cx, cy, 0, L, COLORS.weight, 2.5, 'W');
      arrow(ctx, cx, cy, lx, -ly, COLORS.lift, 3, 'L');
      // components of lift
      if (Math.abs(lx) > 3) {
        arrow(ctx, cx, cy, 0, -ly, 'rgba(79,163,255,0.6)', 1.5, 'vertical', [3, 3]);
        arrow(ctx, cx, cy - ly, lx, 0, 'rgba(79,163,255,0.6)', 1.5, 'turning', [3, 3]);
      }
      const g = ac.gLoad || 1;
      ctx.fillStyle = '#fff';
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${g.toFixed(2)} G`, x + w - 6, y + 14);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      const bank = Math.atan2(R[7], R[8]) * U.RAD;
      ctx.fillText(`bank ${Math.abs(bank).toFixed(0)}°`, x + w - 6, y + 28);
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ moving map
  class MovingMap {
    constructor(canvas, world) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = world;
      this.range = 2500; // metres from centre to edge
      this.trail = [];
      this.trailT = 0;
      this.options = {};
      canvas.addEventListener('click', () => {
        const ranges = [1200, 2500, 5000, 10000];
        this.range = ranges[(ranges.indexOf(this.range) + 1) % ranges.length];
      });
      this.resize();
    }
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = this.cv.getBoundingClientRect();
      this.dpr = dpr;
      this.cv.width = Math.max(10, Math.round(r.width * dpr));
      this.cv.height = Math.max(10, Math.round(r.height * dpr));
      this.W = r.width;
      this.H = r.height;
    }
    clearTrail() {
      this.trail = [];
    }

    draw(ac, t, dt, wx) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const W = this.W, H = this.H;
      this.trailT += dt;
      if (this.trailT > 0.5) {
        this.trailT = 0;
        this.trail.push([t.n, t.e]);
        if (this.trail.length > 1200) this.trail.shift();
      }
      const k = Math.min(W, H) / 2 / this.range;
      const cn = t.n, ce = t.e;
      const X = (e) => W / 2 + (e - ce) * k;
      const Y = (n) => H / 2 - (n - cn) * k;
      ctx.fillStyle = '#1f2a22';
      ctx.fillRect(0, 0, W, H);
      // section grid
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      const S = 1609;
      for (let i = Math.floor((ce - this.range * 2) / S); i <= Math.ceil((ce + this.range * 2) / S); i++) {
        ctx.beginPath();
        ctx.moveTo(X(i * S), 0);
        ctx.lineTo(X(i * S), H);
        ctx.stroke();
      }
      for (let i = Math.floor((cn - this.range * 2) / S); i <= Math.ceil((cn + this.range * 2) / S); i++) {
        ctx.beginPath();
        ctx.moveTo(0, Y(i * S));
        ctx.lineTo(W, Y(i * S));
        ctx.stroke();
      }
      // landmarks
      const lm = this.world.landmarks;
      ctx.fillStyle = 'rgba(70,120,170,0.7)';
      ctx.beginPath();
      ctx.ellipse(X(lm.lake.e), Y(lm.lake.n), 750 * k, 900 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(150,150,150,0.35)';
      ctx.fillRect(X(lm.town.e - 700), Y(lm.town.n + 700), 1400 * k, 1400 * k);
      ctx.fillStyle = '#e05040';
      ctx.beginPath();
      ctx.arc(X(lm.silo.e), Y(lm.silo.n), 3, 0, Math.PI * 2);
      ctx.fill();
      // runway
      const rw = this.world.runway;
      ctx.fillStyle = '#d8d8d8';
      ctx.fillRect(X(-rw.width / 2), Y(rw.length), Math.max(2, rw.width * k), rw.length * k);
      ctx.fillStyle = '#ffd36b';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('36', X(0), Y(0) + 11);
      ctx.fillText('18', X(0), Y(rw.length) - 4);
      // pattern
      const o = this.options;
      if (o.pattern) {
        ctx.strokeStyle = 'rgba(255,211,107,0.45)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        const dw = -1350;
        ctx.moveTo(X(0), Y(-1100));
        ctx.lineTo(X(0), Y(rw.length + 600));
        ctx.lineTo(X(dw + 300), Y(rw.length + 600));
        ctx.lineTo(X(dw), Y(rw.length + 300));
        ctx.lineTo(X(dw), Y(-800));
        ctx.lineTo(X(dw + 300), Y(-1100));
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (o.circle) {
        ctx.strokeStyle = 'rgba(255,211,107,0.5)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(X(o.circle.e), Y(o.circle.n), o.circle.r * k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // trail
      ctx.strokeStyle = 'rgba(120,220,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      this.trail.forEach(([n, e], i) => (i ? ctx.lineTo(X(e), Y(n)) : ctx.moveTo(X(e), Y(n))));
      ctx.lineTo(X(t.e), Y(t.n));
      ctx.stroke();
      // airplane
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate(t.hdg * U.DEG);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(2, -2);
      ctx.lineTo(9, 1);
      ctx.lineTo(2, 2);
      ctx.lineTo(1.5, 6);
      ctx.lineTo(4, 8);
      ctx.lineTo(-4, 8);
      ctx.lineTo(-1.5, 6);
      ctx.lineTo(-2, 2);
      ctx.lineTo(-9, 1);
      ctx.lineTo(-2, -2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // ground track line (where you're actually going)
      if (t.gs > 5) {
        ctx.strokeStyle = 'rgba(90,255,140,0.8)';
        ctx.beginPath();
        ctx.moveTo(W / 2, H / 2);
        ctx.lineTo(W / 2 + Math.sin(t.track * U.DEG) * 40, H / 2 - Math.cos(t.track * U.DEG) * 40);
        ctx.stroke();
      }
      // wind arrow
      const c = wx.cfg;
      if (c.windKt >= 1) {
        ctx.save();
        ctx.translate(W - 26, 26);
        ctx.rotate(c.windDir * U.DEG + Math.PI);
        ctx.strokeStyle = '#9fd3ff';
        ctx.fillStyle = '#9fd3ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, 12);
        ctx.lineTo(0, -10);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -14);
        ctx.lineTo(-5, -6);
        ctx.lineTo(5, -6);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#9fd3ff';
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${String(Math.round(c.windDir)).padStart(3, '0')}/${Math.round(c.windKt)}`, W - 26, 52);
      }
      // north + scale
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('N ↑', 6, 14);
      ctx.fillText(`${(this.range / U.NM).toFixed(1)} nm  · click to zoom`, 6, H - 6);
    }
  }

  FS.ForcesDiagram = ForcesDiagram;
  FS.MovingMap = MovingMap;
})();
