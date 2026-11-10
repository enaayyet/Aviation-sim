/*
 * world.js — the scenery: one airport (runway 18/36), farmland, roads, a lake, a town and a few
 * landmarks used by the ground-reference lessons. Everything lives on a flat plane at field elevation.
 *
 * Flat polygons are drawn in layer order (fields -> grass -> roads -> runway -> paint), 3D objects
 * (trees, hangars, windsock, PAPI) are depth-sorted every frame.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { M } = FS;

  const C = {
    grass: [92, 128, 72],
    airportGrass: [104, 140, 78],
    fields: [
      [118, 142, 74],
      [146, 150, 88],
      [96, 124, 64],
      [168, 158, 106],
      [120, 104, 78],
      [132, 150, 84],
      [104, 132, 70],
    ],
    water: [64, 104, 140],
    road: [96, 96, 98],
    asphalt: [84, 86, 90],
    taxi: [98, 100, 104],
    paint: [214, 214, 206],
    yellow: [214, 180, 60],
    town: [128, 124, 116],
    tree: [52, 84, 46],
    trunk: [80, 64, 48],
  };

  // 7-segment glyphs for runway numbers: segments a b c d e f g
  const SEGS = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };

  class World {
    constructor(seed = 7) {
      this.rand = M.rng(seed);
      this.flat = [];
      this.objects = [];
      const L = 1067; // 3500 ft
      const W = 23; // 75 ft
      this.runway = {
        name: '18/36',
        hdg: 0,
        length: L,
        width: W,
        aimN: 305, // 1000-ft aiming point markers (approach to 36)
        lengthFt: 3500,
        widthFt: 75,
        papiN: 305,
        papiE: -26,
        tpa: 1000, // traffic pattern altitude AGL (ft)
      };
      this.landmarks = {
        silo: { n: -2600, e: 2600, name: 'Red barn & silo' },
        lake: { n: 2600, e: 3600, name: 'Lake' },
        town: { n: -4200, e: -3400, name: 'Town' },
        tower: { n: 520, e: 170, name: 'Hangars' },
      };
      this.build();
    }

    addFlat(pts, color, layer) {
      let cn = 0, ce = 0;
      for (const p of pts) {
        cn += p[0];
        ce += p[1];
      }
      cn /= pts.length;
      ce /= pts.length;
      let r = 0;
      for (const p of pts) r = Math.max(r, Math.hypot(p[0] - cn, p[1] - ce));
      this.flat.push({ pts: pts.map((p) => [p[0], p[1], 0]), color, layer, cn, ce, r });
    }

    rect(n0, n1, e0, e1, color, layer) {
      this.addFlat([[n0, e0], [n1, e0], [n1, e1], [n0, e1]], color, layer);
    }

    build() {
      const r = this.rand;
      const rw = this.runway;
      const S = 1609; // a "section" (1 statute mile) — farmland in the US Midwest is laid out on this grid
      const N = 9;
      // ---- farmland: each section split into fields of different crops
      for (let i = -N; i < N; i++) {
        for (let j = -N; j < N; j++) {
          const n0 = i * S, e0 = j * S;
          const split = r();
          if (split < 0.4) {
            const k = r.range(0.3, 0.7);
            this.rect(n0, n0 + S * k, e0, e0 + S, C.fields[(r() * C.fields.length) | 0], 0);
            this.rect(n0 + S * k, n0 + S, e0, e0 + S, C.fields[(r() * C.fields.length) | 0], 0);
          } else if (split < 0.8) {
            const k = r.range(0.3, 0.7);
            this.rect(n0, n0 + S, e0, e0 + S * k, C.fields[(r() * C.fields.length) | 0], 0);
            this.rect(n0, n0 + S, e0 + S * k, e0 + S, C.fields[(r() * C.fields.length) | 0], 0);
          } else {
            for (let a = 0; a < 2; a++)
              for (let b = 0; b < 2; b++)
                this.rect(n0 + (a * S) / 2, n0 + ((a + 1) * S) / 2, e0 + (b * S) / 2, e0 + ((b + 1) * S) / 2, C.fields[(r() * C.fields.length) | 0], 0);
          }
        }
      }
      // ---- section-line roads
      const ext = N * S;
      for (let i = -N; i <= N; i++) {
        if (i === 0) continue; // keep the airport clear
        this.rect(i * S - 4, i * S + 4, -ext, ext, C.road, 2);
        this.rect(-ext, ext, i * S - 4, i * S + 4, C.road, 2);
      }
      // a highway running diagonally SW-NE through the town, passing 800 m east of the airport
      this.addFlat([[-ext, -ext + 793], [ext, ext + 793], [ext, ext + 807], [-ext, -ext + 807]], C.road, 2);

      // ---- lake (irregular)
      {
        const { n, e } = this.landmarks.lake;
        const pts = [];
        for (let k = 0; k < 18; k++) {
          const a = (k / 18) * Math.PI * 2;
          const rr = 700 + 260 * Math.sin(a * 3 + 1) + r.range(-80, 80);
          pts.push([n + Math.cos(a) * rr * 1.2, e + Math.sin(a) * rr]);
        }
        this.addFlat(pts, C.water, 1);
      }
      // ---- town: grey blocks with buildings
      {
        const { n, e } = this.landmarks.town;
        this.rect(n - 700, n + 700, e - 700, e + 700, C.town, 1);
        for (let a = -3; a <= 3; a++) {
          this.rect(n + a * 200 - 5, n + a * 200 + 5, e - 700, e + 700, C.road, 2);
          this.rect(n - 700, n + 700, e + a * 200 - 5, e + a * 200 + 5, C.road, 2);
        }
        for (let k = 0; k < 70; k++) {
          const bn = n + r.range(-650, 650), be = e + r.range(-650, 650);
          const h = r() < 0.12 ? r.range(20, 40) : r.range(6, 12);
          this.objects.push({ type: 'box', p: [bn, be, 0], l: r.range(14, 30), w: r.range(14, 30), h, color: [150 + r.range(-25, 25), 140 + r.range(-25, 25), 130 + r.range(-20, 20)], roof: [110, 90, 80] });
        }
        this.objects.push({ type: 'tower', p: [n + 300, e - 100, 0], h: 38, r: 6, color: [200, 205, 210], label: 'water tower' });
      }
      // ---- farm landmark used for turns around a point
      {
        const { n, e } = this.landmarks.silo;
        this.rect(n - 60, n + 60, e - 60, e + 60, [120, 110, 80], 1);
        this.objects.push({ type: 'box', p: [n, e - 25, 0], l: 30, w: 16, h: 9, color: [160, 40, 34], roof: [90, 90, 90] });
        this.objects.push({ type: 'tower', p: [n + 8, e + 15, 0], h: 22, r: 4, color: [200, 200, 196], label: 'silo' });
        this.objects.push({ type: 'tower', p: [n - 12, e + 18, 0], h: 16, r: 3, color: [180, 180, 176] });
      }

      // ---- airport
      const L = rw.length, Wd = rw.width, hw = Wd / 2;
      this.rect(-400, L + 400, -260, 300, C.airportGrass, 3);
      this.rect(-60, L + 60, -hw - 1, hw + 1, C.asphalt, 4); // includes small overruns
      // taxiway + apron
      this.rect(0, L, 70, 81, C.taxi, 4);
      for (const tn of [0, L / 2 - 6, L - 12]) this.rect(tn, tn + 12, hw, 75, C.taxi, 4);
      this.rect(420, 640, 81, 190, C.taxi, 4);
      // taxiway centerline (yellow)
      this.rect(0, L, 75.2, 75.8, C.yellow, 5);
      // edge lines
      this.rect(0, L, -hw + 0.3, -hw + 1.2, C.paint, 5);
      this.rect(0, L, hw - 1.2, hw - 0.3, C.paint, 5);
      // threshold bars at both ends
      const bars = 4;
      for (let k = 0; k < bars; k++) {
        const off = 2.4 + k * 2.3;
        for (const s of [-1, 1]) {
          const e0 = s * off;
          this.rect(6, 51, Math.min(e0, e0 + s * 1.7), Math.max(e0, e0 + s * 1.7), C.paint, 5);
          this.rect(L - 51, L - 6, Math.min(e0, e0 + s * 1.7), Math.max(e0, e0 + s * 1.7), C.paint, 5);
        }
      }
      // runway numbers
      this.digits('36', 60, 0, 1);
      this.digits('18', L - 60, 0, -1);
      // centerline
      for (let n = 96; n < L - 96 - 30; n += 60) this.rect(n, n + 36, -0.45, 0.45, C.paint, 5);
      // aiming point markers
      for (const s of [-1, 1]) {
        this.rect(rw.aimN, rw.aimN + 45, s > 0 ? 4.5 : -9, s > 0 ? 9 : -4.5, C.paint, 5);
        this.rect(L - rw.aimN - 45, L - rw.aimN, s > 0 ? 4.5 : -9, s > 0 ? 9 : -4.5, C.paint, 5);
      }
      // hangars
      for (let k = 0; k < 4; k++) {
        this.objects.push({ type: 'box', p: [450 + k * 46, 215, 0], l: 36, w: 30, h: 8, color: [176, 180, 184], roof: [120, 124, 130] });
      }
      this.objects.push({ type: 'box', p: [600, 120, 0], l: 10, w: 8, h: 4, color: [220, 216, 200], roof: [160, 60, 50] }); // FBO
      // windsock and PAPI
      this.objects.push({ type: 'windsock', p: [190, -48, 0] });
      for (let k = 0; k < 4; k++) this.objects.push({ type: 'papi', p: [rw.papiN, rw.papiE - k * 9, 0], idx: k });
      // runway edge & threshold lights
      for (let n = 0; n <= L + 0.1; n += 61) {
        this.objects.push({ type: 'light', p: [n, -hw - 1.5, -0.4], color: [255, 250, 220] });
        this.objects.push({ type: 'light', p: [n, hw + 1.5, -0.4], color: [255, 250, 220] });
      }
      for (let e = -hw; e <= hw + 0.1; e += 3.8) {
        this.objects.push({ type: 'light', p: [-1.5, e, -0.3], color: [90, 255, 120] });
        this.objects.push({ type: 'light', p: [L + 1.5, e, -0.3], color: [255, 80, 70] });
      }

      // ---- trees: shelter belts along roads & scattered woods
      for (let k = 0; k < 420; k++) {
        let n, e;
        if (k < 260) {
          // along section lines
          const line = ((r() * 10) | 0) - 5;
          const along = r.range(-6000, 6000);
          if (r() < 0.5) {
            n = line * S + r.range(12, 30) * (r() < 0.5 ? -1 : 1);
            e = along;
          } else {
            e = line * S + r.range(12, 30) * (r() < 0.5 ? -1 : 1);
            n = along;
          }
        } else {
          // woods clusters
          const cl = [[-1500, -2200], [3000, -1800], [-2600, 1300], [1800, 2200], [4600, 800], [-800, 4200]][k % 6];
          n = cl[0] + r.gauss() * 220;
          e = cl[1] + r.gauss() * 220;
        }
        if (n > -500 && n < L + 500 && e > -300 && e < 320) continue; // keep the airport clear
        this.objects.push({ type: 'tree', p: [n, e, 0], h: r.range(8, 16), r: r.range(3, 6), shade: r.range(0.85, 1.15) });
      }

      // ---- distant hills for heading reference: two layers of continuous ridgelines
      this.hills = [];
      const layers = [
        { R: 32000, n: 90, base: [120, 136, 150], amp: 1150, rough: 0.55 },
        { R: 24000, n: 90, base: [112, 132, 124], amp: 520, rough: 0.7 },
      ];
      for (const Ly of layers) {
        // smooth random profile (sum of a few sine harmonics + jitter)
        const ph = [r() * 6.28, r() * 6.28, r() * 6.28, r() * 6.28];
        const height = (a) => {
          const big = 0.5 + 0.5 * Math.sin(a * 2 + ph[0]); // ridges in two quadrants
          const v = 0.55 * Math.sin(a * 5 + ph[1]) + 0.3 * Math.sin(a * 11 + ph[2]) + 0.15 * Math.sin(a * 23 + ph[3]);
          return Math.max(60, Ly.amp * (0.25 + 0.75 * big) * (0.6 + Ly.rough * 0.5 * v));
        };
        for (let k = 0; k < Ly.n; k++) {
          const a0 = (k / Ly.n) * Math.PI * 2;
          const a1 = ((k + 1) / Ly.n) * Math.PI * 2;
          this.hills.push({
            pts: [
              [Math.cos(a0) * Ly.R, Math.sin(a0) * Ly.R, 0],
              [Math.cos(a0) * Ly.R, Math.sin(a0) * Ly.R, -height(a0)],
              [Math.cos(a1) * Ly.R, Math.sin(a1) * Ly.R, -height(a1)],
              [Math.cos(a1) * Ly.R, Math.sin(a1) * Ly.R, 0],
            ],
            color: Ly.base,
          });
        }
      }

      this.flat.sort((a, b) => a.layer - b.layer);
    }

    /** Paint runway numbers with 7-segment glyphs. dir = +1 reads approaching northbound, -1 southbound. */
    digits(str, n0, e0, dir) {
      const H = 18, Wd = 6.5, t = 1.4, gap = 3;
      const total = str.length * Wd + (str.length - 1) * gap;
      for (let i = 0; i < str.length; i++) {
        const segs = SEGS[str[i]];
        const u0 = -total / 2 + i * (Wd + gap);
        const seg = {
          a: [u0, u0 + Wd, H - t, H],
          d: [u0, u0 + Wd, 0, t],
          g: [u0, u0 + Wd, H / 2 - t / 2, H / 2 + t / 2],
          b: [u0 + Wd - t, u0 + Wd, H / 2, H],
          c: [u0 + Wd - t, u0 + Wd, 0, H / 2],
          f: [u0, u0 + t, H / 2, H],
          e: [u0, u0 + t, 0, H / 2],
        };
        for (const s of segs) {
          const [ua, ub, va, vb] = seg[s];
          const pts = [[va, ua], [vb, ua], [vb, ub], [va, ub]].map(([v, u]) => [n0 + dir * v, e0 + dir * u]);
          this.addFlat(pts, C.paint, 6);
        }
      }
    }

    /** PAPI: returns 'W' or 'R' for light idx (0 = nearest the runway) seen from an eye position. */
    papiLight(idx, eye) {
      const rw = this.runway;
      const dn = rw.papiN - eye[0];
      const de = rw.papiE - eye[1];
      const dist = Math.hypot(dn, de);
      const ang = (Math.atan2(-eye[2], dist) * 180) / Math.PI;
      const thresholds = [3.5, 3.17, 2.83, 2.5];
      return ang > thresholds[idx] ? 'W' : 'R';
    }
  }

  World.COLORS = C;
  FS.World = World;
})();
