/*
 * instruments.js — the panel.
 *
 * The classic "six-pack":           plus engine & teaching instruments:
 *   Airspeed | Attitude | Altimeter    Tachometer, AoA (lift reserve), G-meter,
 *   Turn coord | Heading | Vert speed  throttle / flaps / trim / fuel, annunciators
 *
 * Each instrument is driven by what that instrument physically senses (pitot pressure, static pressure,
 * gyros, a ball in a fluid-filled tube) — so they lag, mislead and agree exactly as the real ones do.
 * Orange "grease-pencil" marks show the current lesson's targets.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { M } = FS;
  const { clamp } = M;
  const D2R = Math.PI / 180;

  const FACE = '#141519';
  const BEZEL = '#2b2d33';
  const WHITE = '#eceae4';
  const TARGET = '#ff9a2e';

  function textC(ctx, s, x, y, size, color = WHITE, weight = '600') {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }
  function bezel(ctx, r) {
    ctx.fillStyle = BEZEL;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = FACE;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.92, 0, Math.PI * 2);
    ctx.fill();
  }
  /** angle in degrees clockwise from 12 o'clock -> canvas radians */
  const ang = (deg) => (deg - 90) * D2R;
  function tick(ctx, deg, r0, r1, w, color = WHITE) {
    const a = ang(deg);
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.stroke();
  }
  function arc(ctx, d0, d1, rad, w, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(0, 0, rad, ang(d0), ang(d1));
    ctx.stroke();
  }
  function needle(ctx, deg, len, w, color = WHITE, tail = 0.18) {
    ctx.save();
    ctx.rotate(ang(deg) + Math.PI / 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-w, len * tail);
    ctx.lineTo(-w * 0.6, -len * 0.85);
    ctx.lineTo(0, -len);
    ctx.lineTo(w * 0.6, -len * 0.85);
    ctx.lineTo(w, len * tail);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  function hub(ctx, r) {
    ctx.fillStyle = '#555';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }
  function targetMark(ctx, deg, r) {
    const a = ang(deg);
    ctx.save();
    ctx.translate(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillStyle = TARGET;
    ctx.beginPath();
    ctx.moveTo(0, r * 0.1);
    ctx.lineTo(-r * 0.07, -r * 0.02);
    ctx.lineTo(r * 0.07, -r * 0.02);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------------------------ gauges
  const asiAngle = (v) => (v <= 40 ? (Math.max(0, v) / 40) * 30 : 30 + ((Math.min(v, 205) - 40) / 160) * 300);
  const Gauges = {
    asi: {
      label: 'Airspeed',
      face(ctx, r, ac) {
        bezel(ctx, r);
        const v = ac.d.v;
        arc(ctx, asiAngle(v.so), asiAngle(v.fe), r * 0.7, r * 0.06, '#f4f4f4');
        arc(ctx, asiAngle(v.s1), asiAngle(v.no), r * 0.78, r * 0.06, '#21b14b');
        arc(ctx, asiAngle(v.no), asiAngle(v.ne), r * 0.78, r * 0.06, '#e6c229');
        tick(ctx, asiAngle(v.ne), r * 0.68, r * 0.88, r * 0.035, '#e03a2e');
        for (let s = 40; s <= 200; s += 5) tick(ctx, asiAngle(s), r * (s % 10 === 0 ? 0.74 : 0.8), r * 0.88, s % 10 === 0 ? 2 : 1);
        for (let s = 40; s <= 180; s += 20) {
          const a = ang(asiAngle(s));
          textC(ctx, String(s), Math.cos(a) * r * 0.56, Math.sin(a) * r * 0.56, r * 0.15);
        }
        textC(ctx, 'AIRSPEED', 0, -r * 0.24, r * 0.09, '#aaa');
        textC(ctx, 'KNOTS', 0, r * 0.26, r * 0.09, '#aaa');
      },
      dyn(ctx, r, t, tg) {
        if (tg && tg.ias != null) targetMark(ctx, asiAngle(tg.ias), r);
        textC(ctx, `${Math.round(t.tas)} TAS`, 0, r * 0.42, r * 0.1, '#8fc4ff', '500');
        needle(ctx, asiAngle(t.ias), r * 0.84, r * 0.045);
        hub(ctx, r);
      },
    },

    ai: {
      label: 'Attitude',
      face(ctx, r) {
        bezel(ctx, r);
      },
      dyn(ctx, r, t, tg) {
        const R = r * 0.86;
        const ppd = (R * 0.9) / 25; // pixels per degree of pitch
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.clip();
        ctx.rotate(-t.bank * D2R);
        const py = clamp(t.pitch, -40, 40) * ppd;
        ctx.fillStyle = '#3d86d4';
        ctx.fillRect(-R * 2, -R * 3 + py, R * 4, R * 3);
        ctx.fillStyle = '#8a5a2e';
        ctx.fillRect(-R * 2, py, R * 4, R * 3);
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-R * 2, py);
        ctx.lineTo(R * 2, py);
        ctx.stroke();
        ctx.lineWidth = 1.2;
        for (let p = -30; p <= 30; p += 5) {
          if (p === 0) continue;
          const y = py - p * ppd;
          const w = p % 10 === 0 ? R * 0.3 : R * 0.14;
          ctx.beginPath();
          ctx.moveTo(-w, y);
          ctx.lineTo(w, y);
          ctx.stroke();
          if (p % 10 === 0) {
            textC(ctx, String(Math.abs(p)), -w - R * 0.1, y, R * 0.1);
            textC(ctx, String(Math.abs(p)), w + R * 0.1, y, R * 0.1);
          }
        }
        // bank pointer on the rotating card (the "sky pointer")
        ctx.fillStyle = WHITE;
        ctx.beginPath();
        ctx.moveTo(0, -R * 0.8);
        ctx.lineTo(-R * 0.06, -R * 0.68);
        ctx.lineTo(R * 0.06, -R * 0.68);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        // fixed bank scale on the case
        for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
          const big = b % 30 === 0;
          tick(ctx, b, R * 0.84, R * (big ? 1.0 : 0.94), big ? 2.5 : 1.5, b === 0 ? TARGET : WHITE);
        }
        if (tg && tg.bank != null) {
          targetMark(ctx, tg.bank, r);
          targetMark(ctx, -tg.bank, r);
        }
        // miniature airplane
        ctx.strokeStyle = '#ffcf33';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(-R * 0.55, 0);
        ctx.lineTo(-R * 0.18, 0);
        ctx.lineTo(-R * 0.09, R * 0.09);
        ctx.lineTo(0, 0);
        ctx.lineTo(R * 0.09, R * 0.09);
        ctx.lineTo(R * 0.18, 0);
        ctx.lineTo(R * 0.55, 0);
        ctx.stroke();
        ctx.fillStyle = '#ffcf33';
        ctx.beginPath();
        ctx.arc(0, 0, 3, 0, Math.PI * 2);
        ctx.fill();
      },
    },

    alt: {
      label: 'Altimeter',
      face(ctx, r) {
        bezel(ctx, r);
        for (let i = 0; i < 50; i++) tick(ctx, i * 7.2, r * (i % 5 === 0 ? 0.72 : 0.8), r * 0.88, i % 5 === 0 ? 2.2 : 1);
        for (let i = 0; i < 10; i++) {
          const a = ang(i * 36);
          textC(ctx, String(i), Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6, r * 0.17);
        }
        textC(ctx, 'ALT', 0, -r * 0.3, r * 0.09, '#aaa');
        textC(ctx, '100 FEET', 0, r * 0.38, r * 0.075, '#aaa');
      },
      dyn(ctx, r, t, tg, panel) {
        // Kollsman window
        ctx.fillStyle = '#000';
        ctx.fillRect(r * 0.22, -r * 0.09, r * 0.44, r * 0.18);
        textC(ctx, panel.kollsman.toFixed(2), r * 0.44, 0, r * 0.12, WHITE, '500');
        const a = t.altInd;
        if (tg && tg.alt != null) targetMark(ctx, ((((tg.alt % 1000) + 1000) % 1000) / 1000) * 360, r);
        // 10,000 ft pointer, 1,000 ft (short), 100 ft (long)
        ctx.save();
        ctx.rotate(ang((a / 100000) * 360) + Math.PI / 2);
        ctx.fillStyle = WHITE;
        ctx.fillRect(-1, -r * 0.86, 2, r * 0.8);
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.92);
        ctx.lineTo(-r * 0.05, -r * 0.82);
        ctx.lineTo(r * 0.05, -r * 0.82);
        ctx.fill();
        ctx.restore();
        needle(ctx, (a / 10000) * 360, r * 0.5, r * 0.07);
        needle(ctx, (a / 1000) * 360, r * 0.84, r * 0.04);
        hub(ctx, r);
      },
    },

    tc: {
      label: 'Turn coordinator',
      face(ctx, r) {
        bezel(ctx, r);
        for (const s of [-1, 1]) {
          tick(ctx, 90 * s - 0 * s, r * 0.72, r * 0.86, 3);
          tick(ctx, 90 * s + 20 * s, r * 0.72, r * 0.86, 3);
        }
        textC(ctx, 'L', -r * 0.66, r * 0.42, r * 0.13);
        textC(ctx, 'R', r * 0.66, r * 0.42, r * 0.13);
        textC(ctx, 'TURN COORDINATOR', 0, -r * 0.55, r * 0.07, '#aaa');
        textC(ctx, '2 MIN', 0, r * 0.72, r * 0.08, '#aaa');
        // ball tube
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 1;
        ctx.fillStyle = '#2a2a2a';
        ctx.beginPath();
        ctx.ellipse(0, r * 0.45, r * 0.5, r * 0.11, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#999';
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * r * 0.1, r * 0.35);
          ctx.lineTo(s * r * 0.1, r * 0.55);
          ctx.stroke();
        }
      },
      dyn(ctx, r, t) {
        // gyro is canted 30 deg, so it senses roll rate as well as yaw rate
        const sig = t.turnRate + 0.25 * t.p;
        const a = clamp(sig / 3, -2.2, 2.2) * 20;
        ctx.save();
        ctx.rotate(a * D2R);
        ctx.strokeStyle = WHITE;
        ctx.fillStyle = WHITE;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-r * 0.72, 0);
        ctx.lineTo(r * 0.72, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(-2, -r * 0.24, 4, r * 0.16);
        ctx.fillRect(-r * 0.15, -r * 0.25, r * 0.3, 3);
        ctx.restore();
        const bx = clamp(t.ball / 14, -1, 1) * r * 0.39;
        ctx.fillStyle = '#111';
        ctx.strokeStyle = '#eee';
        ctx.beginPath();
        ctx.arc(bx, r * 0.45 + Math.abs(bx) * 0.12, r * 0.095, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.stroke();
      },
    },

    hi: {
      label: 'Heading',
      face(ctx, r) {
        bezel(ctx, r);
      },
      dyn(ctx, r, t, tg, panel) {
        ctx.save();
        ctx.rotate(-t.hdg * D2R);
        for (let d = 0; d < 360; d += 5) tick(ctx, d, r * (d % 10 === 0 ? 0.72 : 0.78), r * 0.86, d % 10 === 0 ? 2 : 1);
        const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
        for (let d = 0; d < 360; d += 30) {
          const a = ang(d);
          ctx.save();
          ctx.translate(Math.cos(a) * r * 0.58, Math.sin(a) * r * 0.58);
          ctx.rotate(d * D2R);
          textC(ctx, labels[d] || String(d / 10), 0, 0, r * (labels[d] ? 0.17 : 0.13), labels[d] ? '#ffd27a' : WHITE);
          ctx.restore();
        }
        // heading bug
        const bug = tg && tg.hdg != null ? tg.hdg : panel.hdgBug;
        const ba = ang(bug);
        ctx.fillStyle = TARGET;
        ctx.save();
        ctx.translate(Math.cos(ba) * r * 0.86, Math.sin(ba) * r * 0.86);
        ctx.rotate(bug * D2R);
        ctx.fillRect(-r * 0.08, -r * 0.02, r * 0.16, r * 0.07);
        ctx.restore();
        ctx.restore();
        // lubber line & airplane
        ctx.fillStyle = TARGET;
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.74);
        ctx.lineTo(-r * 0.05, -r * 0.88);
        ctx.lineTo(r * 0.05, -r * 0.88);
        ctx.fill();
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.35);
        ctx.lineTo(0, r * 0.3);
        ctx.moveTo(-r * 0.28, -r * 0.05);
        ctx.lineTo(r * 0.28, -r * 0.05);
        ctx.moveTo(-r * 0.12, r * 0.25);
        ctx.lineTo(r * 0.12, r * 0.25);
        ctx.stroke();
        textC(ctx, String(Math.round(t.hdg) % 360).padStart(3, '0') + '°', 0, r * 0.47, r * 0.11, '#ffd27a', '500');
      },
    },

    vsi: {
      label: 'Vertical speed',
      face(ctx, r) {
        bezel(ctx, r);
        const va = (v) => 270 + (v / 2000) * 170;
        for (let v = -2000; v <= 2000; v += 100) tick(ctx, va(v), r * (v % 500 === 0 ? 0.7 : 0.78), r * 0.86, v % 500 === 0 ? 2 : 1);
        for (const v of [-2000, -1500, -1000, -500, 0, 500, 1000, 1500, 2000]) {
          const a = ang(va(v));
          textC(ctx, String(Math.abs(v / 100)), Math.cos(a) * r * 0.56, Math.sin(a) * r * 0.56, r * 0.14);
        }
        textC(ctx, 'UP', -r * 0.2, -r * 0.3, r * 0.09, '#aaa');
        textC(ctx, 'DOWN', -r * 0.2, r * 0.3, r * 0.09, '#aaa');
        textC(ctx, 'FPM ×100', r * 0.22, 0, r * 0.08, '#aaa');
      },
      dyn(ctx, r, t, tg) {
        const va = (v) => 270 + (clamp(v, -2100, 2100) / 2000) * 170;
        if (tg && tg.vs != null) targetMark(ctx, va(tg.vs), r);
        needle(ctx, va(t.vsi), r * 0.84, r * 0.045);
        hub(ctx, r);
      },
    },

    tach: {
      label: 'Tachometer',
      face(ctx, r, ac) {
        bezel(ctx, r);
        const ta = (v) => -135 + (v / 3500) * 270;
        arc(ctx, ta(500), ta(ac.d.engine.redlineRPM), r * 0.78, r * 0.06, '#21b14b');
        tick(ctx, ta(ac.d.engine.redlineRPM), r * 0.68, r * 0.88, r * 0.035, '#e03a2e');
        for (let v = 0; v <= 3500; v += 100) tick(ctx, ta(v), r * (v % 500 === 0 ? 0.72 : 0.8), r * 0.88, v % 500 === 0 ? 2 : 1);
        for (let v = 0; v <= 35; v += 5) {
          const a = ang(ta(v * 100));
          textC(ctx, String(v), Math.cos(a) * r * 0.56, Math.sin(a) * r * 0.56, r * 0.14);
        }
        textC(ctx, 'RPM', 0, -r * 0.28, r * 0.09, '#aaa');
        textC(ctx, '×100', 0, r * 0.28, r * 0.08, '#aaa');
      },
      dyn(ctx, r, t, tg) {
        const ta = (v) => -135 + (clamp(v, 0, 3600) / 3500) * 270;
        if (tg && tg.rpm != null) targetMark(ctx, ta(tg.rpm), r);
        textC(ctx, String(Math.round(t.rpm / 10) * 10), 0, r * 0.5, r * 0.12, '#8fc4ff', '500');
        needle(ctx, ta(t.rpm), r * 0.84, r * 0.045);
        hub(ctx, r);
      },
    },

    aoa: {
      label: 'Angle of attack',
      face(ctx, r) {
        bezel(ctx, r);
        const aa = (f) => -120 + f * 240;
        arc(ctx, aa(0), aa(0.6), r * 0.76, r * 0.12, '#21b14b');
        arc(ctx, aa(0.6), aa(0.85), r * 0.76, r * 0.12, '#e6c229');
        arc(ctx, aa(0.85), aa(1.0), r * 0.76, r * 0.12, '#e03a2e');
        textC(ctx, 'AoA', 0, -r * 0.3, r * 0.12, '#aaa');
        textC(ctx, 'lift reserve', 0, r * 0.62, r * 0.075, '#aaa');
      },
      dyn(ctx, r, t) {
        const aa = (f) => -120 + clamp(f, 0, 1.05) * 240;
        textC(ctx, `${t.alpha.toFixed(1)}°`, 0, r * 0.28, r * 0.15, t.aoaFrac > 0.85 ? '#ff6b5b' : WHITE, '600');
        textC(ctx, `stall ${t.alphaStall.toFixed(0)}°`, 0, r * 0.46, r * 0.08, '#aaa', '500');
        needle(ctx, aa(t.aoaFrac), r * 0.84, r * 0.045);
        hub(ctx, r);
      },
    },

    gmeter: {
      label: 'G-meter',
      face(ctx, r, ac) {
        bezel(ctx, r);
        const ga = (g) => -150 + ((g + 2) / 7) * 300;
        arc(ctx, ga(-1.52), ga(ac.d.limits.gPos), r * 0.78, r * 0.05, '#21b14b');
        tick(ctx, ga(ac.d.limits.gPos), r * 0.68, r * 0.88, 3, '#e03a2e');
        tick(ctx, ga(-1.52), r * 0.68, r * 0.88, 3, '#e03a2e');
        for (let g = -2; g <= 5; g++) {
          tick(ctx, ga(g), r * 0.72, r * 0.88, 2);
          const a = ang(ga(g));
          textC(ctx, String(g), Math.cos(a) * r * 0.56, Math.sin(a) * r * 0.56, r * 0.14);
        }
        textC(ctx, 'G', 0, -r * 0.3, r * 0.13, '#aaa');
      },
      dyn(ctx, r, t) {
        const ga = (g) => -150 + ((clamp(g, -2.2, 5.2) + 2) / 7) * 300;
        needle(ctx, ga(t.maxG), r * 0.7, r * 0.025, '#e6c229', 0);
        needle(ctx, ga(t.minG), r * 0.7, r * 0.025, '#e6c229', 0);
        textC(ctx, t.g.toFixed(2), 0, r * 0.4, r * 0.13, WHITE, '500');
        needle(ctx, ga(t.g), r * 0.84, r * 0.045);
        hub(ctx, r);
      },
    },
  };

  class Panel {
    constructor(canvas, ac) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.ac = ac;
      this.kollsman = 29.92;
      this.hdgBug = 0;
      this.cache = {};
      this.order = [['asi', 'ai', 'alt', 'tach', 'aoa'], ['tc', 'hi', 'vsi', 'gmeter', null]];
      this.resize();
      canvas.addEventListener(
        'wheel',
        (e) => {
          const g = this.hit(e);
          if (!g) return;
          e.preventDefault();
          const step = e.deltaY > 0 ? -1 : 1;
          if (g === 'alt') this.setKollsman(this.kollsman + step * 0.01);
          if (g === 'hi') this.hdgBug = M.wrap360(this.hdgBug + step * (e.shiftKey ? 10 : 1));
        },
        { passive: false }
      );
      canvas.addEventListener('click', (e) => {
        const g = this.hit(e);
        if (g === 'hi' && this.lastTele) this.hdgBug = Math.round(this.lastTele.hdg);
        if (g === 'alt' && this.onSetAltimeter) this.onSetAltimeter();
      });
    }

    setKollsman(v) {
      this.kollsman = clamp(Math.round(v * 100) / 100, 28.0, 31.0);
      this.ac.kollsman = this.kollsman;
    }

    hit(e) {
      const rect = this.cv.getBoundingClientRect();
      const x = (e.clientX - rect.left) * this.dpr, y = (e.clientY - rect.top) * this.dpr;
      for (const k in this.pos) {
        const p = this.pos[k];
        if (Math.hypot(x - p.x, y - p.y) < this.r) return k;
      }
      return null;
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = this.cv.getBoundingClientRect();
      this.W = Math.max(50, Math.round(r.width * dpr));
      this.H = Math.max(50, Math.round(r.height * dpr));
      this.cv.width = this.W;
      this.cv.height = this.H;
      this.dpr = dpr;
      const cols = 5;
      // on narrow screens the side cluster is dropped (throttle/flaps/trim are shown over the 3D view)
      const sideW = this.W / dpr < 640 ? 0 : Math.min(this.W * 0.24, 270 * dpr);
      const gr = Math.min((this.H - 8 * dpr) / 4.25, (this.W - sideW) / (cols * 2.18));
      this.r = gr;
      const used = cols * gr * 2.18;
      const x0 = Math.max(gr * 1.1, (this.W - sideW - used) / 2 + gr * 1.09);
      this.pos = {};
      this.order.forEach((row, ri) =>
        row.forEach((k, ci) => {
          if (!k) return;
          this.pos[k] = { x: x0 + ci * gr * 2.18, y: this.H / 2 + (ri === 0 ? -1 : 1) * gr * 1.06 };
        })
      );
      this.side = sideW ? { x: x0 + cols * gr * 2.18 - gr * 0.5, y: 6 * dpr, w: this.W - (x0 + cols * gr * 2.18 - gr * 0.5) - 8 * dpr, h: this.H - 12 * dpr } : { x: 0, y: 0, w: 0, h: 0 };
      this.cache = {};
    }

    face(k) {
      if (this.cache[k]) return this.cache[k];
      const r = this.r;
      const c = document.createElement('canvas');
      c.width = c.height = Math.ceil(r * 2 + 4);
      const x = c.getContext('2d');
      x.translate(c.width / 2, c.height / 2);
      Gauges[k].face(x, r, this.ac);
      this.cache[k] = c;
      return c;
    }

    draw(t, targets) {
      const ctx = this.ctx;
      this.lastTele = t;
      ctx.fillStyle = '#1d1f24';
      ctx.fillRect(0, 0, this.W, this.H);
      for (const k in this.pos) {
        const p = this.pos[k];
        const fc = this.face(k);
        ctx.drawImage(fc, p.x - fc.width / 2, p.y - fc.height / 2);
        ctx.save();
        ctx.translate(p.x, p.y);
        Gauges[k].dyn(ctx, this.r, t, targets, this);
        ctx.restore();
      }
      this.drawSide(t);
    }

    drawSide(t) {
      const ctx = this.ctx;
      const s = this.side;
      if (s.w < 60) return;
      const dpr = this.dpr;
      const fs = Math.max(9 * dpr, Math.min(12.5 * dpr, s.w / 20));
      const textL = (str, x, y, size, color = WHITE, weight = '600') => {
        ctx.fillStyle = color;
        ctx.font = `${weight} ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(str, x, y);
      };
      const annH = fs * 2.9;
      const cw = s.w * 0.2;
      const top = s.y + fs * 2.1;
      const hgt = Math.max(30, s.h - annH - fs * 4.4);
      // vertical lever-style indicators: throttle, flaps, trim
      const lever = (i, label, frac, ticks, knob, valueText) => {
        const x0 = s.x + cw * i;
        const tx = x0 + 8 * dpr;
        textL(label, x0 + 2 * dpr, s.y + fs * 0.8, fs * 0.85, '#aaa', '700');
        ctx.fillStyle = '#0d0e11';
        ctx.fillRect(tx - 3 * dpr, top, 6 * dpr, hgt);
        for (const tk of ticks) {
          const y = top + tk.f * hgt;
          ctx.fillStyle = tk.color || '#777';
          ctx.fillRect(tx - 6 * dpr, y - 0.5 * dpr, 12 * dpr, 1.2 * dpr);
          if (tk.label) textL(tk.label, tx + 9 * dpr, y, fs * 0.72, tk.color || '#9a9a9a', '600');
        }
        const y = top + clamp(frac, 0, 1) * hgt;
        ctx.fillStyle = knob;
        ctx.fillRect(tx - 8 * dpr, y - 4 * dpr, 16 * dpr, 8 * dpr);
        textL(valueText, x0 + 2 * dpr, top + hgt + fs * 1.0, fs * 0.9, WHITE, '600');
      };
      lever(0, 'THR', 1 - t.throttle, [{ f: 0, label: 'FULL' }, { f: 1, label: 'IDLE' }], '#e8e8e8', `${Math.round(t.throttle * 100)}%`);
      lever(1, 'FLAPS', t.flaps / 40, [0, 10, 25, 40].map((d) => ({ f: d / 40, label: String(d) })), '#cfd6dd', `${Math.round(t.flaps)}°`);
      lever(2, 'TRIM', (1 - t.trim) / 2, [{ f: 0, label: 'UP' }, { f: 0.5, label: 'T/O', color: '#4cc' }, { f: 1, label: 'DN' }], '#ffcf33', t.trim >= 0 ? `+${t.trim.toFixed(2)}` : t.trim.toFixed(2));
      // engine & environment readouts
      const ix = s.x + cw * 3.05;
      const rows = [
        ['FUEL', `${t.fuelGal.toFixed(1)} gal`],
        ['FLOW', `${t.fuelFlow.toFixed(1)} gph`],
        ['POWER', `${Math.round(t.hp)} hp`],
        ['MAP', `${t.map.toFixed(1)} inHg`],
        ['OAT', `${Math.round(t.oat)} °C`],
        ['TAS', `${Math.round(t.tas)} kt`],
      ];
      const rh = Math.min(fs * 2.2, (hgt + fs * 2) / rows.length);
      rows.forEach(([k, v], i) => {
        textL(k, ix, s.y + fs * 0.8 + i * rh, fs * 0.75, '#999', '700');
        textL(v, ix, s.y + fs * 0.8 + i * rh + fs * 0.95, fs * 0.95, WHITE, '600');
      });
      // annunciators
      const ann = [
        ['STALL', t.stallWarn, '#e03a2e'],
        ['BRAKE', t.parkingBrake || t.brakes > 0.05, '#e6a229'],
        ['ENGINE', t.engineFailed || t.rpm < 400, '#e03a2e'],
        ['FLAP SPD', t.warnings.flapSpeed, '#e6a229'],
        ['VNE', t.warnings.overspeed, '#e03a2e'],
        ['OVER-G', t.warnings.overG, '#e03a2e'],
      ];
      const ay = s.y + s.h - annH;
      const aw = s.w / 3;
      ann.forEach(([label, on, col], i) => {
        const x = s.x + aw * (i % 3) + 2 * dpr;
        const y = ay + Math.floor(i / 3) * fs * 1.45;
        ctx.fillStyle = on ? col : '#2a2b30';
        ctx.fillRect(x, y, aw - 4 * dpr, fs * 1.25);
        textC(ctx, label, x + (aw - 4 * dpr) / 2, y + fs * 0.65, fs * 0.72, on ? '#fff' : '#666', '700');
      });
    }
  }

  FS.Panel = Panel;
  FS.Gauges = Gauges;
})();
