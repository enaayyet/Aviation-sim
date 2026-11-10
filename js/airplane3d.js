/*
 * airplane3d.js — a procedurally built PA-28 Warrior for the WebGL renderer.
 *
 * Everything is authored in the flight model's BODY axes (x forward, y right, z down, origin at the CG,
 * metres) so the model lines up exactly with the physics: the wheels touch where the struts are, the eye
 * sits where the pilot sits, the control surfaces move by the angles the aerodynamics uses.
 * The helper `B()` converts body axes to the model's local three.js axes (X right, Y up, Z aft).
 *
 * Parts that move: ailerons, flaps, stabilator, rudder, propeller, the three wheels (spin, strut
 * compression, nose-wheel steering) and the lights (beacon, strobes).
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const THREE = globalThis.THREE;
  if (!THREE) return;
  const { U, M } = FS;
  const { clamp, lerp } = M;

  const B = (x, y, z) => new THREE.Vector3(y, -z, -x);
  const smooth = (t) => {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  };

  // ------------------------------------------------------------------ geometry toolkit
  /** Build an indexed grid surface from rows of Vector3 (rows[i][j]). uv optional: uvs[i][j] = [u, v]. */
  function gridGeom(rows, { closeU = false, uvs = null, color = null } = {}) {
    const nr = rows.length, nc = rows[0].length;
    const pos = new Float32Array(nr * nc * 3);
    const uv = uvs ? new Float32Array(nr * nc * 2) : null;
    for (let i = 0; i < nr; i++)
      for (let j = 0; j < nc; j++) {
        const p = rows[i][j], k = i * nc + j;
        pos[k * 3] = p.x;
        pos[k * 3 + 1] = p.y;
        pos[k * 3 + 2] = p.z;
        if (uv) {
          uv[k * 2] = uvs[i][j][0];
          uv[k * 2 + 1] = uvs[i][j][1];
        }
      }
    const idx = [];
    const cols = closeU ? nc : nc - 1;
    for (let i = 0; i < nr - 1; i++)
      for (let j = 0; j < cols; j++) {
        const a = i * nc + j, b = i * nc + ((j + 1) % nc), c = (i + 1) * nc + j, d = (i + 1) * nc + ((j + 1) % nc);
        idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    if (color) paint(g, color);
    return g;
  }

  /** Solid vertex colour (hex or THREE.Color). */
  function paint(g, color) {
    const c = color.isColor ? color : new THREE.Color(color);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  }

  /** Colour vertices with a function of position: fn(Vector3) -> hex. */
  function paintBy(g, fn) {
    const p = g.attributes.position;
    const arr = new Float32Array(p.count * 3);
    const v = new THREE.Vector3(), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      c.set(fn(v));
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  }

  /** Flip winding if the surface faces inward (relative to its own centroid). */
  function orientOutward(g, sign = 1) {
    const p = g.attributes.position, idx = g.index.array;
    const cen = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) cen.add(v.fromBufferAttribute(p, i));
    cen.multiplyScalar(1 / p.count);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
    let s = 0;
    for (let i = 0; i < idx.length; i += 3) {
      a.fromBufferAttribute(p, idx[i]);
      b.fromBufferAttribute(p, idx[i + 1]);
      c.fromBufferAttribute(p, idx[i + 2]);
      n.subVectors(b, a).cross(m.subVectors(c, a));
      m.addVectors(a, b).add(c).multiplyScalar(1 / 3).sub(cen);
      s += n.dot(m);
    }
    if (s * sign < 0) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    return g;
  }

  /** Make faces look toward a direction (for open patches such as windows). */
  function orientToward(g, dirFn) {
    const p = g.attributes.position, idx = g.index.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
    let s = 0;
    for (let i = 0; i < idx.length; i += 3) {
      a.fromBufferAttribute(p, idx[i]);
      b.fromBufferAttribute(p, idx[i + 1]);
      c.fromBufferAttribute(p, idx[i + 2]);
      n.subVectors(b, a).cross(m.subVectors(c, a));
      m.addVectors(a, b).add(c).multiplyScalar(1 / 3);
      s += n.dot(dirFn(m));
    }
    if (s < 0) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    return g;
  }

  /** Smooth normals welded by position (so UV seams and merged parts don't leave creases). */
  function smoothNormals(g, creaseDeg = 180) {
    g.computeVertexNormals();
    if (creaseDeg >= 180) {
      const p = g.attributes.position, nrm = g.attributes.normal;
      const map = new Map();
      const key = (i) => `${Math.round(p.getX(i) * 2000)},${Math.round(p.getY(i) * 2000)},${Math.round(p.getZ(i) * 2000)}`;
      for (let i = 0; i < p.count; i++) {
        const k = key(i);
        let e = map.get(k);
        if (!e) map.set(k, (e = [0, 0, 0]));
        e[0] += nrm.getX(i);
        e[1] += nrm.getY(i);
        e[2] += nrm.getZ(i);
      }
      for (let i = 0; i < p.count; i++) {
        const e = map.get(key(i));
        const l = Math.hypot(e[0], e[1], e[2]) || 1;
        nrm.setXYZ(i, e[0] / l, e[1] / l, e[2] / l);
      }
    }
    return g;
  }

  /** Merge geometries (position, normal, color, optional uv). All are converted to non-indexed. */
  function merge(list, withUV = false) {
    let n = 0;
    const parts = list.map((g) => {
      if (!g.attributes.normal) g.computeVertexNormals();
      const ni = g.index ? g.toNonIndexed() : g;
      n += ni.attributes.position.count;
      return ni;
    });
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const uv = withUV ? new Float32Array(n * 2) : null;
    let o = 0;
    for (const g of parts) {
      const c = g.attributes.position.count;
      pos.set(g.attributes.position.array, o * 3);
      nrm.set(g.attributes.normal.array, o * 3);
      if (g.attributes.color) col.set(g.attributes.color.array, o * 3);
      else col.fill(1, o * 3, (o + c) * 3);
      if (uv && g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      o += c;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return out;
  }

  /** Three primitive -> coloured, positioned geometry. */
  function prim(geom, color, matrix) {
    if (matrix) geom.applyMatrix4(matrix);
    geom.computeVertexNormals();
    return paint(geom, color);
  }
  const TRS = (pos, rot, scl) => new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(rot || new THREE.Euler()), scl || new THREE.Vector3(1, 1, 1));

  /** A tube between two points (for struts, pitot, antennas). */
  function tube(a, b, r, color, seg = 10) {
    const d = new THREE.Vector3().subVectors(b, a);
    const g = new THREE.CylinderGeometry(r, r, d.length(), seg, 1);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
    return paint(g, color);
  }

  // ------------------------------------------------------------------ fuselage loft
  // x, half-width, top z, bottom z, superellipse exponent, tumblehome (top-width ratio)
  const STATIONS = [
    [2.3, 0.3, -0.06, 0.4, 2.2, 1.0],
    [2.22, 0.42, -0.17, 0.48, 2.6, 1.0],
    [1.95, 0.5, -0.26, 0.53, 2.8, 0.96],
    [1.5, 0.545, -0.32, 0.56, 3.0, 0.94],
    [1.25, 0.565, -0.36, 0.57, 3.2, 0.92],
    [0.72, 0.585, -0.93, 0.575, 3.2, 0.74],
    [-0.2, 0.59, -0.985, 0.575, 3.2, 0.72],
    [-1.35, 0.565, -0.955, 0.565, 3.2, 0.72],
    [-2.15, 0.47, -0.74, 0.5, 3.0, 0.8],
    [-3.3, 0.32, -0.54, 0.26, 2.6, 0.9],
    [-4.6, 0.17, -0.41, 0.02, 2.3, 1.0],
    [-5.62, 0.045, -0.33, -0.12, 2.0, 1.0],
  ];
  const X_NOSE = 2.3, X_TAIL = -5.62, Z_TOP = -1.02, Z_BOT = 0.62;

  /** Section parameters at station x (piecewise-smooth interpolation). */
  function section(x) {
    const S = STATIONS;
    if (x >= S[0][0]) return S[0];
    if (x <= S[S.length - 1][0]) return S[S.length - 1];
    let i = 0;
    while (S[i + 1][0] > x) i++;
    const a = S[i], b = S[i + 1];
    let t = (a[0] - x) / (a[0] - b[0]);
    // the windshield is a straight slope; everything else eases between stations
    if (!(i === 4)) t = t * t * (3 - 2 * t) * 0.6 + t * 0.4;
    return a.map((v, k) => v + (b[k] - v) * t);
  }
  /** Point on the fuselage skin: th = 0 right side, 90° top, 180° left, 270° bottom. Returns body [x,y,z]. */
  function skin(x, th, off = 0) {
    const [, w, zt, zb, n, tw] = section(x);
    const zc = (zt + zb) / 2, h = (zb - zt) / 2;
    const c = Math.cos(th), s = Math.sin(th);
    let yy = (w + off) * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const zz = (h + off) * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    if (zz > 0) yy *= lerp(1, tw, Math.pow(zz / (h + off), 1.6));
    return [x, yy, zc - zz];
  }
  /** Side skin at a given height: half-width y (>0) of the fuselage at body (x, z). */
  function sideY(x, z, off = 0) {
    const [, w, zt, zb, n, tw] = section(x);
    const zc = (zt + zb) / 2, h = (zb - zt) / 2;
    const r = clamp((zc - z) / h, -0.999, 0.999);
    let yy = (w + off) * Math.pow(1 - Math.pow(Math.abs(r), n), 1 / n);
    if (r > 0) yy *= lerp(1, tw, Math.pow(r, 1.6));
    return yy;
  }
  /** Top skin at a given lateral position: z of the roof at body (x, y). */
  function topZ(x, y, off = 0) {
    const [, w, zt, zb, n, tw] = section(x);
    const zc = (zt + zb) / 2, h = (zb - zt) / 2;
    // solve by bisection on th in (0, 90°]
    let lo = 0.02, hi = Math.PI / 2;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      const c = Math.cos(mid), s = Math.sin(mid);
      const zz = h * Math.pow(s, 2 / n);
      const yy = w * Math.pow(c, 2 / n) * lerp(1, tw, Math.pow(zz / h, 1.6));
      if (yy > Math.abs(y)) lo = mid;
      else hi = mid;
    }
    return zc - (h + off) * Math.pow(Math.sin(lo), 2 / n);
  }

  function fuselageTexture() {
    const W = 2048, H = 1024;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d');
    const half = H / 2;
    const px = (x) => ((x - X_TAIL) / (X_NOSE - X_TAIL)) * W;
    const pz = (z) => ((z - Z_TOP) / (Z_BOT - Z_TOP)) * half;
    for (const side of [0, 1]) {
      c.save();
      c.translate(0, side * half);
      c.beginPath();
      c.rect(0, 0, W, half);
      c.clip();
      // base white with a faint warm tint, grey belly
      c.fillStyle = '#f2f1ec';
      c.fillRect(0, 0, W, half);
      const g = c.createLinearGradient(0, pz(0.36), 0, pz(0.62));
      g.addColorStop(0, 'rgba(120,124,130,0)');
      g.addColorStop(1, 'rgba(120,124,130,0.9)');
      c.fillStyle = g;
      c.fillRect(0, pz(0.36), W, half);
      // sweeping stripes: a broad oxblood band with a navy pinstripe, rising toward the tail
      const band = (z0, th, color, rise) => {
        c.fillStyle = color;
        c.beginPath();
        c.moveTo(px(2.3), pz(z0 + 0.03));
        c.bezierCurveTo(px(0.8), pz(z0), px(-2.2), pz(z0 - 0.02), px(-5.62), pz(z0 - rise));
        c.lineTo(px(-5.62), pz(z0 - rise + th * 0.45));
        c.bezierCurveTo(px(-2.2), pz(z0 - 0.02 + th), px(0.8), pz(z0 + th), px(2.3), pz(z0 + 0.03 + th));
        c.closePath();
        c.fill();
      };
      band(0.06, 0.2, '#a8242c', 0.3);
      band(0.3, 0.035, '#1d2f55', 0.36);
      band(-0.005, 0.03, '#1d2f55', 0.3);
      // anti-glare panel on top of the cowl
      c.fillStyle = '#16181b';
      c.beginPath();
      c.moveTo(px(1.23), 0);
      c.lineTo(px(2.3), 0);
      c.lineTo(px(2.3), pz(-0.06) + 4);
      c.lineTo(px(2.2), pz(-0.15));
      c.lineTo(px(1.5), pz(-0.285));
      c.lineTo(px(1.23), pz(-0.325));
      c.closePath();
      c.fill();
      // panel lines: cowl split, door outline (right side only has the door on a PA-28), baggage door
      c.strokeStyle = 'rgba(40,44,52,0.55)';
      c.lineWidth = 1.6;
      c.beginPath();
      c.moveTo(px(1.25), pz(-0.36));
      c.lineTo(px(1.25), pz(0.56));
      c.moveTo(px(2.2), pz(0.16));
      c.lineTo(px(1.25), pz(0.16));
      c.stroke();
      if (side === 0) {
        c.strokeRect(px(-0.42), pz(-0.93), px(0.42) - px(-0.42), pz(0.34) - pz(-0.93));
      }
      c.strokeRect(px(-1.95), pz(-0.42), px(-1.5) - px(-1.95), pz(0.1) - pz(-0.42));
      // rivet lines on the tail cone
      c.strokeStyle = 'rgba(60,64,72,0.22)';
      c.lineWidth = 1;
      for (const x of [-2.2, -2.9, -3.6, -4.3, -5.0]) {
        c.beginPath();
        c.moveTo(px(x), 0);
        c.lineTo(px(x), half);
        c.stroke();
      }
      // registration
      c.fillStyle = '#1d2f55';
      c.font = `italic 800 ${Math.round(pz(0.0) - pz(-0.27))}px "Helvetica Neue", Arial, sans-serif`;
      c.textBaseline = 'middle';
      c.textAlign = 'center';
      const tx = px(-3.25), tz = pz(-0.22);
      c.save();
      c.translate(tx, tz);
      if (side === 1) c.scale(-1, 1);
      c.fillText('N161PW', 0, 0);
      c.restore();
      c.restore();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  function buildFuselage() {
    const NX = 96, NT = 22;
    const shells = [];
    for (const side of [0, 1]) {
      const rows = [], uvs = [];
      for (let i = 0; i <= NX; i++) {
        // denser stations around the nose and windshield
        const t = i / NX;
        const x = X_NOSE + (X_TAIL - X_NOSE) * (t * t * 0.35 + t * 0.65);
        const row = [], uvr = [];
        for (let j = 0; j <= NT; j++) {
          const th = (side === 0 ? -Math.PI / 2 : Math.PI / 2) + (j / NT) * Math.PI;
          const p = skin(x, th);
          row.push(B(p[0], p[1], p[2]));
          const u = (x - X_TAIL) / (X_NOSE - X_TAIL);
          const vz = clamp((p[2] - Z_TOP) / (Z_BOT - Z_TOP), 0, 1);
          uvr.push([u, side === 0 ? 1 - vz * 0.5 : 0.5 - vz * 0.5]);
        }
        rows.push(row);
        uvs.push(uvr);
      }
      shells.push(gridGeom(rows, { uvs }));
    }
    const g = merge(shells.map((s) => s.toNonIndexed()), true);
    // re-index-free smooth normals + outward orientation
    const gi = new THREE.BufferGeometry();
    gi.setAttribute('position', g.attributes.position);
    gi.setAttribute('uv', g.attributes.uv);
    gi.setIndex([...Array(g.attributes.position.count).keys()]);
    orientOutward(gi);
    smoothNormals(gi);
    return gi;
  }

  const PILLAR_TH = 38; // where the A-pillar sits around the section (degrees up from the side)
  /** Glass patches lying just outside the skin. */
  function buildGlass() {
    const parts = [];
    const OFF = 0.006;
    // windshield: two panes split by a centre post, wrapping round to the A-pillars
    for (const s of [-1, 1]) {
      const rows = [];
      for (let i = 0; i <= 10; i++) {
        const x = lerp(1.21, 0.76, i / 10);
        const row = [];
        for (let j = 0; j <= 10; j++) {
          const th = lerp(86, PILLAR_TH, j / 10) * U.DEG;
          const p = skin(x, s > 0 ? th : Math.PI - th, OFF);
          row.push(B(p[0], p[1], p[2]));
        }
        rows.push(row);
      }
      parts.push(orientToward(gridGeom(rows), () => new THREE.Vector3(0, 1, -0.5)));
      // side windows: front (door) window, rear window, small aft quarter window
      const wins = [
        [0.66, -0.36, -0.74, -0.42, 0.1],
        [-0.44, -1.2, -0.74, -0.42, 0.0],
        [-1.28, -1.86, -0.72, -0.46, -0.22],
      ];
      for (const [x0, x1, zTop, zBot, rake] of wins) {
        const r2 = [];
        for (let i = 0; i <= 8; i++) {
          const row = [];
          for (let j = 0; j <= 6; j++) {
            const z = lerp(zBot, zTop, j / 6);
            const f = j / 6;
            // raked front edge on the first window, raked rear edge on the last
            const xa = x0 + (rake > 0 ? -rake * f : 0);
            const xb = x1 + (rake < 0 ? -rake * f * 1.6 : 0);
            const x = lerp(xa, xb, i / 8);
            const zz = x < -1.3 ? lerp(z, lerp(zBot, zTop, 0.5), clamp((-1.3 - x) / 1.2, 0, 1) * 0.5) : z;
            row.push(B(x, s * sideY(x, zz, OFF), zz));
          }
          r2.push(row);
        }
        parts.push(orientToward(gridGeom(r2), () => new THREE.Vector3(s, 0.2, 0)));
      }
    }
    const g = merge(parts.map((p) => smoothNormals(p)));
    return g;
  }

  // ------------------------------------------------------------------ lifting surfaces
  /** NACA 4-digit half-loop: returns [xc, zUp] upper surface from xc = c0..c1 and the lower likewise. */
  function airfoil(xc, t, m = 0, p = 0.4) {
    const yt = 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
    const yc = m === 0 ? 0 : xc < p ? (m / (p * p)) * (2 * p * xc - xc * xc) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * xc - xc * xc);
    return [yc + yt, yc - yt];
  }
  /**
   * Loft a wing-like surface. st: array of stations {y, le, te, z, t, m, c0, c1} in body axes where
   * le/te are the x of the leading/trailing edge, z the chord-line height, t thickness ratio and
   * c0..c1 the chord fraction this piece covers (to cut out flaps and ailerons).
   * vertical=true lofts along body -z (fin/rudder) instead of along y.
   */
  function loftSurface(st, { NC = 12, vertical = false, capA = true, capB = true } = {}) {
    const rows = [];
    const ring = (s) => {
      const row = [];
      const c = s.le - s.te;
      const pt = (xc, zu) => {
        const x = s.le - xc * c;
        return vertical ? B(x, zu * c, s.y) : B(x, s.y, s.z - zu * c);
      };
      const c0 = s.c0 || 0, c1 = s.c1 === undefined ? 1 : s.c1;
      // upper surface c1 -> c0 (cosine spacing clustered at the leading edge), then lower c0 -> c1
      for (let i = 0; i <= NC; i++) {
        const f = i / NC;
        const xc = c0 === 0 ? c1 * (1 - Math.sin((f * Math.PI) / 2)) ** 1.0 + 0 : lerp(c1, c0, f);
        row.push(pt(xc, airfoil(clamp(xc, 0, 1), s.t, s.m || 0)[0]));
      }
      for (let i = c0 === 0 ? 1 : 0; i <= NC; i++) {
        const f = i / NC;
        const xc = c0 === 0 ? c1 * (1 - Math.cos((f * Math.PI) / 2)) : lerp(c0, c1, f);
        row.push(pt(xc, airfoil(clamp(xc, 0, 1), s.t, s.m || 0)[1]));
      }
      return row;
    };
    for (const s of st) rows.push(ring(s));
    const g = gridGeom(rows, { closeU: true });
    orientOutward(g);
    smoothNormals(g);
    const parts = [g];
    // flat end caps
    const cap = (row, flip) => {
      const cen = new THREE.Vector3();
      for (const p of row) cen.add(p);
      cen.multiplyScalar(1 / row.length);
      const pos = [];
      for (let i = 0; i < row.length; i++) {
        const a = row[i], b = row[(i + 1) % row.length];
        const tri = flip ? [cen, b, a] : [cen, a, b];
        for (const p of tri) pos.push(p.x, p.y, p.z);
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      cg.setIndex([...Array(pos.length / 3).keys()]);
      return cg;
    };
    if (capA || capB) {
      const all = new THREE.Vector3();
      for (const r of rows) for (const p of r) all.add(p);
      all.multiplyScalar(1 / (rows.length * rows[0].length));
      for (const [on, row] of [[capA, rows[0]], [capB, rows[rows.length - 1]]]) {
        if (!on) continue;
        let cg = cap(row, false);
        cg.computeVertexNormals();
        const cen = new THREE.Vector3();
        for (const p of row) cen.add(p);
        cen.multiplyScalar(1 / row.length).sub(all);
        const n = new THREE.Vector3().fromBufferAttribute(cg.attributes.normal, 0);
        if (n.dot(cen) < 0) cg = cap(row, true);
        cg.computeVertexNormals();
        parts.push(cg);
      }
    }
    return parts.length === 1 ? g : merge(parts);
  }

  // wing planform (body axes), as functions of |y|
  const DIH = Math.tan(7 * U.DEG);
  const Y_ROOT = 0.5, Y_TAPER = 2.25, Y_TIP = 5.33;
  const wingLE = (y) => {
    if (y < Y_TAPER) return 0.42 + 0.36 * smooth((1.05 - y) / 0.55);
    return lerp(0.42, 0.0, (y - Y_TAPER) / (Y_TIP - Y_TAPER));
  };
  const wingTE = (y) => (y < Y_TAPER ? -1.18 : lerp(-1.18, -1.09, (y - Y_TAPER) / (Y_TIP - Y_TAPER)));
  const wingZ = (y) => 0.45 - (y - 0.55) * DIH;
  const FLAP = { y0: 0.6, y1: 2.56, chord: 0.31 };
  const AIL = { y0: 2.6, y1: 4.9, chord: 0.26 };
  const hingeFrac = (y, chord) => 1 - chord / (wingLE(y) - wingTE(y));

  function wingStations(s, y0, y1, n, cut) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const y = lerp(y0, y1, i / n);
      const st = { y: s * y, le: wingLE(y), te: wingTE(y), z: wingZ(y), t: 0.15, m: 0.02 };
      if (cut) Object.assign(st, cut(y));
      out.push(st);
    }
    return out;
  }

  /** A hinged part: geometry is authored in model space, then re-expressed about a hinge axis. */
  function hinged(geom, a, b, material) {
    const grp = new THREE.Group();
    const axis = new THREE.Vector3().subVectors(b, a).normalize();
    grp.position.copy(a);
    grp.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), axis);
    grp.updateMatrix();
    geom.applyMatrix4(grp.matrix.clone().invert());
    const inner = new THREE.Group();
    const mesh = new THREE.Mesh(geom, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    inner.add(mesh);
    grp.add(inner);
    grp.userData.rot = inner; // rotate inner.rotation.x
    return grp;
  }

  // ------------------------------------------------------------------ the airplane
  const COL = {
    white: 0xf2f1ec,
    belly: 0xb9bbbd,
    red: 0xa8242c,
    navy: 0x1d2f55,
    dark: 0x24262a,
    tire: 0x17181a,
    metal: 0xa9adb3,
    glare: 0x121315,
    interior: 0x77736a,
  };

  function buildAirplane(d) {
    const root = new THREE.Group();
    root.name = 'PA-28';
    const paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.08, envMapIntensity: 0.9 });
    const fusMat = new THREE.MeshStandardMaterial({ map: fuselageTexture(), roughness: 0.32, metalness: 0.08, envMapIntensity: 0.9 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0c141c, roughness: 0.05, metalness: 0.85, envMapIntensity: 1.6, transparent: true, opacity: 0.9 });
    const matteMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
    const parts = { mats: { paintMat, fusMat, glassMat, matteMat } };

    const addMesh = (geom, mat, parent = root, shadow = true) => {
      const m = new THREE.Mesh(geom, mat);
      m.castShadow = shadow;
      m.receiveShadow = shadow;
      parent.add(m);
      return m;
    };

    // ---- fuselage, glass
    parts.fuselage = addMesh(buildFuselage(), fusMat);
    parts.glass = addMesh(buildGlass(), glassMat, root, false);
    {
      // matte anti-glare panel on top of the cowl (so the sun doesn't bounce into the pilot's eyes)
      const rows = [];
      for (let i = 0; i <= 12; i++) {
        const x = lerp(1.255, 2.2, i / 12);
        const row = [];
        const hw = lerp(0.4, 0.26, i / 12);
        for (let j = 0; j <= 10; j++) {
          const y = lerp(-hw, hw, j / 10);
          row.push(B(x, y, topZ(x, y, 0.004)));
        }
        rows.push(row);
      }
      const g = gridGeom(rows);
      orientToward(g, () => new THREE.Vector3(0, 1, 0));
      addMesh(paint(smoothNormals(g), 0x1a1b1d), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.15 }), root, false).receiveShadow = true;
    }

    // ---- fixed painted structure: wings, fin, fairings
    const fixed = [];
    const stripeTip = (v) => (Math.abs(v.x) > 5.02 ? COL.red : Math.abs(v.x) > 4.96 ? COL.navy : COL.white);
    for (const s of [-1, 1]) {
      // inboard stub (under the cabin) + main box with the flap and aileron bays cut out
      fixed.push(paintBy(loftSurface(wingStations(s, 0.3, FLAP.y0, 2), { capA: false }), stripeTip));
      fixed.push(paintBy(loftSurface(wingStations(s, FLAP.y0, FLAP.y1, 10, (y) => ({ c1: hingeFrac(y, FLAP.chord) }))), stripeTip));
      fixed.push(paintBy(loftSurface(wingStations(s, FLAP.y1, AIL.y0, 1)), stripeTip));
      fixed.push(paintBy(loftSurface(wingStations(s, AIL.y0, AIL.y1, 8, (y) => ({ c1: hingeFrac(y, AIL.chord) }))), stripeTip));
      // tip: full chord, rounded off
      const tip = [];
      for (let i = 0; i <= 8; i++) {
        const f = i / 8;
        const y = lerp(AIL.y1, Y_TIP, f);
        const k = Math.sqrt(Math.max(0.02, 1 - Math.pow(Math.max(0, (f - 0.45) / 0.55), 2)));
        const le = wingLE(y), te = wingTE(y), mid = (le + te) / 2, hc = ((le - te) / 2) * lerp(0.82, 1, k);
        tip.push({ y: s * y, le: mid + hc + (1 - k) * -0.1, te: mid - hc + (1 - k) * 0.02, z: wingZ(y) - (1 - k) * 0.04, t: 0.15 * k, m: 0.02 * k });
      }
      fixed.push(paintBy(loftSurface(tip, { capA: true, capB: true }), stripeTip));
      // main-gear leg fairing stub under the wing
      fixed.push(tube(B(-0.42, s * 1.52, wingZ(1.52) + 0.05), B(-0.42, s * 1.52, 0.6), 0.045, COL.white, 12));
      // pitot/static mast under the left wing
      if (s < 0) {
        fixed.push(tube(B(0.05, -2.9, wingZ(2.9) + 0.06), B(0.05, -2.9, wingZ(2.9) + 0.2), 0.012, COL.metal, 6));
        fixed.push(tube(B(0.22, -2.9, wingZ(2.9) + 0.2), B(-0.02, -2.9, wingZ(2.9) + 0.2), 0.012, COL.metal, 6));
      }
      // stall-warning vane on the left leading edge
      if (s < 0) fixed.push(prim(new THREE.BoxGeometry(0.03, 0.03, 0.02), COL.metal, TRS(B(wingLE(3.3) + 0.012, -3.3, wingZ(3.3) + 0.02))));
    }
    // fin (fixed part ahead of the rudder hinge) with a dorsal fillet
    const finLE = (z) => lerp(-4.42, -5.2, (z - -0.36) / (-1.62 - -0.36));
    const finTE = (z) => lerp(-5.62, -5.86, (z - -0.36) / (-1.62 - -0.36));
    const RUD_FRAC = 0.62;
    const finSt = [], rudSt = [];
    for (let i = 0; i <= 22; i++) {
      const z = lerp(-0.3, -1.62, i / 22);
      const round = i === 22 ? 0.75 : 1;
      finSt.push({ y: z, le: finLE(z) - (1 - round) * 0.1, te: finTE(z), t: 0.1 * round, c1: RUD_FRAC });
      rudSt.push({ y: z, le: finLE(z), te: finTE(z) + (1 - round) * 0.08, t: 0.1 * round, c0: RUD_FRAC, c1: 1 });
    }
    const finPaint = (v) => (v.y > 1.36 ? COL.red : v.y > 1.3 ? COL.navy : COL.white);
    fixed.push(paintBy(loftSurface(finSt, { vertical: true, capA: false }), finPaint));
    // dorsal fillet
    {
      const rows = [];
      for (let i = 0; i <= 6; i++) {
        const f = i / 6;
        const x = lerp(-3.2, -4.6, f);
        const top = lerp(section(x)[2] - 0.0, -0.62, f * f);
        const [, , zt] = section(x);
        rows.push([B(x, -0.035 * (0.4 + f), zt + 0.02), B(x, 0, top), B(x, 0.035 * (0.4 + f), zt + 0.02)]);
      }
      const g = gridGeom(rows);
      orientToward(g, (m) => new THREE.Vector3(Math.sign(m.x) || 1, 0.3, 0));
      g.computeVertexNormals();
      const m = new THREE.Mesh(paint(g, COL.white), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.08, side: THREE.DoubleSide }));
      m.castShadow = true;
      root.add(m);
    }
    // antennas & beacon base & tail tie-down
    fixed.push(tube(B(-0.9, 0, -0.97), B(-1.05, 0, -1.3), 0.012, COL.white, 6));
    fixed.push(tube(B(-2.4, 0, -0.66), B(-2.5, 0, -0.9), 0.01, COL.white, 6));
    fixed.push(tube(B(0.4, 0.2, 0.57), B(0.36, 0.2, 0.75), 0.012, COL.metal, 6));
    // step on the right side behind the wing
    fixed.push(tube(B(-1.45, 0.5, 0.5), B(-1.45, 0.68, 0.72), 0.014, COL.dark, 6));
    fixed.push(prim(new THREE.BoxGeometry(0.16, 0.02, 0.22), COL.dark, TRS(B(-1.45, 0.72, 0.73))));
    // cowl front: air inlets and landing light recess
    for (const s of [-1, 1]) {
      fixed.push(prim(new THREE.BoxGeometry(0.2, 0.11, 0.02), COL.dark, TRS(B(2.262, s * 0.2, 0.02), new THREE.Euler(-0.2, 0, 0))));
    }
    fixed.push(prim(new THREE.BoxGeometry(0.26, 0.09, 0.02), COL.dark, TRS(B(2.25, 0, 0.36), new THREE.Euler(0.22, 0, 0))));
    // exhaust stub
    fixed.push(tube(B(1.5, 0.16, 0.54), B(1.42, 0.16, 0.66), 0.028, COL.metal, 8));
    parts.fixed = addMesh(merge(fixed), paintMat);

    // ---- flaps and ailerons
    parts.flaps = [];
    parts.ailerons = [];
    for (const s of [-1, 1]) {
      const fg = paint(loftSurface(wingStations(s, FLAP.y0 + 0.01, FLAP.y1 - 0.01, 8, (y) => ({ c0: hingeFrac(y, FLAP.chord), c1: 1 }))), COL.white);
      const ag = paint(loftSurface(wingStations(s, AIL.y0 + 0.01, AIL.y1 - 0.01, 8, (y) => ({ c0: hingeFrac(y, AIL.chord), c1: 1 }))), COL.white);
      const hp = (y, chord) => B(wingTE(y) + chord, s * y, wingZ(y) - 0.012);
      // hinge axes always point toward +X (right), so a positive rotation is trailing edge DOWN on both wings
      const fA = s > 0 ? hp(FLAP.y0, FLAP.chord) : hp(FLAP.y1, FLAP.chord), fB = s > 0 ? hp(FLAP.y1, FLAP.chord) : hp(FLAP.y0, FLAP.chord);
      const aA = s > 0 ? hp(AIL.y0, AIL.chord) : hp(AIL.y1, AIL.chord), aB = s > 0 ? hp(AIL.y1, AIL.chord) : hp(AIL.y0, AIL.chord);
      const flap = hinged(fg, fA, fB, paintMat);
      const ail = hinged(ag, aA, aB, paintMat);
      root.add(flap, ail);
      parts.flaps.push(flap);
      parts.ailerons.push({ grp: ail, side: s });
    }

    // ---- stabilator (all-moving) with its anti-servo tab painted on
    {
      const PIV = [-5.0, -0.24];
      const st = [];
      for (let i = 0; i <= 12; i++) {
        const y = lerp(-1.98, 1.98, i / 12);
        const k = Math.abs(y) > 1.9 ? 0.6 : 1;
        st.push({ y, le: -4.62 - (1 - k) * 0.08, te: -5.4 + (1 - k) * 0.04, z: PIV[1], t: 0.11 * k });
      }
      const g = paintBy(loftSurface(st), (v) => (Math.abs(v.x) > 1.72 ? COL.red : Math.abs(v.x) > 1.66 ? COL.navy : v.z > 5.3 && Math.abs(v.x) < 1.5 ? 0xdedcd6 : COL.white));
      parts.stab = hinged(g, B(PIV[0], -1, PIV[1]), B(PIV[0], 1, PIV[1]), paintMat);
      root.add(parts.stab);
    }
    // ---- rudder
    {
      const g = paintBy(loftSurface(rudSt, { vertical: true }), finPaint);
      const hx = (z) => lerp(finLE(z), finTE(z), RUD_FRAC);
      parts.rudder = hinged(g, B(hx(-0.3), 0, -0.3), B(hx(-1.62), 0, -1.62), paintMat);
      root.add(parts.rudder);
    }

    // ---- landing gear: each leg is a group that slides up as the oleo compresses
    parts.gear = [];
    const wheelGeom = () => {
      const tire = new THREE.TorusGeometry(0.135, 0.055, 10, 22);
      tire.rotateY(Math.PI / 2);
      const hub = new THREE.CylinderGeometry(0.085, 0.085, 0.07, 14);
      hub.rotateZ(Math.PI / 2);
      const stripe = new THREE.BoxGeometry(0.075, 0.03, 0.1);
      stripe.translate(0, 0.06, 0);
      return merge([paint(tire, COL.tire), paint(hub, COL.metal), paint(stripe, COL.dark)]);
    };
    const pantGeom = (len) => {
      // a teardrop wheel fairing, open at the bottom so the tyre shows
      const rows = [];
      for (let i = 0; i <= 14; i++) {
        const f = i / 14;
        const x = lerp(len * 0.42, -len * 0.58, f);
        const r = Math.pow(Math.sin(Math.PI * Math.pow(f, 0.7)), 0.75);
        const row = [];
        for (let j = 0; j <= 12; j++) {
          const th = lerp(-0.15, Math.PI + 0.15, j / 12);
          row.push(new THREE.Vector3(Math.cos(th) * 0.105 * r, Math.sin(th) * 0.19 * r - 0.02, -x));
        }
        rows.push(row);
      }
      const g = gridGeom(rows);
      orientOutward(g);
      return paintBy(smoothNormals(g), (v) => (v.y < 0.02 ? COL.red : COL.white));
    };
    const pantMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.08, side: THREE.DoubleSide });
    for (const gr of d.gear) {
      const [gx, gy, gz] = gr.pos;
      const leg = new THREE.Group();
      leg.position.copy(B(gx, gy, 0));
      const R_W = 0.19;
      const axleY = -(gz - R_W); // local up coordinate of the axle
      const steer = new THREE.Group();
      steer.position.set(0, axleY, 0);
      const wheel = new THREE.Mesh(wheelGeom(), matteMat);
      wheel.castShadow = true;
      steer.add(wheel);
      const pant = new THREE.Mesh(pantGeom(gr.id === 'nose' ? 0.62 : 0.78), pantMat);
      pant.castShadow = true;
      steer.add(pant);
      leg.add(steer);
      // oleo strut: a chrome piston that the leg slides on
      const topY = gr.id === 'nose' ? -0.5 : -(wingZ(1.52) + 0.06);
      const piston = new THREE.Mesh(tube(new THREE.Vector3(0, axleY + 0.12, gr.id === 'nose' ? 0.02 : 0), new THREE.Vector3(0, topY, gr.id === 'nose' ? 0.1 : 0), 0.022, 0xd8dade, 10), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.9 }));
      piston.castShadow = true;
      leg.add(piston);
      if (gr.id === 'nose') {
        const fork = new THREE.Mesh(tube(new THREE.Vector3(0.08, axleY, 0), new THREE.Vector3(0.08, axleY + 0.16, 0.02), 0.016, COL.metal, 8), matteMat);
        steer.add(fork);
      }
      root.add(leg);
      parts.gear.push({ id: gr.id, leg, steer, wheel, spin: 0, omega: 0 });
    }

    // ---- propeller: two twisted blades + spinner, and a blur disc for high RPM
    {
      const hub = new THREE.Group();
      hub.position.copy(B(2.32, 0, 0.14));
      const blades = [];
      const R = d.geom.propD / 2;
      for (const k of [0, 1]) {
        const rows = [];
        for (let i = 0; i <= 12; i++) {
          const f = i / 12;
          const r = lerp(0.1, R, f);
          const chord = 0.15 * Math.pow(Math.sin(Math.PI * Math.pow(lerp(0.12, 0.985, f), 0.75)), 0.6) + 0.02;
          const twist = Math.atan2(0.42, f * 1.9 + 0.22); // blade angle washes out toward the tip
          const th = 0.016 * (1 - f * 0.7);
          const row = [];
          for (let j = 0; j < 8; j++) {
            const a = (j / 8) * Math.PI * 2;
            const cx = Math.cos(a) * chord * 0.5, cz = Math.sin(a) * th;
            // blade section in the (tangential, axial) plane, rotated by the local blade angle
            row.push(new THREE.Vector3(cx * Math.cos(twist) - cz * Math.sin(twist), r, cx * Math.sin(twist) + cz * Math.cos(twist)));
          }
          rows.push(row);
        }
        const g = gridGeom(rows, { closeU: true });
        orientOutward(g);
        smoothNormals(g);
        if (k) g.rotateZ(Math.PI);
        blades.push(paintBy(g, (v) => (Math.abs(v.y) > R - 0.07 ? 0xd9b23a : 0x1c1d20)));
      }
      const bladeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.4, transparent: true });
      const bladeMesh = new THREE.Mesh(merge(blades), bladeMat);
      bladeMesh.castShadow = true;
      hub.add(bladeMesh);
      // spinner
      const sp = [];
      for (let i = 0; i <= 10; i++) {
        const f = i / 10;
        const r = 0.155 * Math.sqrt(1 - f * f) + 0.004;
        const row = [];
        for (let j = 0; j < 16; j++) row.push(new THREE.Vector3(Math.cos((j / 16) * 6.2832) * r, Math.sin((j / 16) * 6.2832) * r, -f * 0.3 + 0.06));
        sp.push(row);
      }
      const sg = gridGeom(sp, { closeU: true });
      orientOutward(sg);
      const spinner = new THREE.Mesh(paint(smoothNormals(sg), COL.white), paintMat);
      spinner.castShadow = true;
      hub.add(spinner);
      // blur disc
      const cv = document.createElement('canvas');
      cv.width = cv.height = 256;
      const c = cv.getContext('2d');
      const grd = c.createRadialGradient(128, 128, 10, 128, 128, 128);
      grd.addColorStop(0, 'rgba(30,30,32,0)');
      grd.addColorStop(0.16, 'rgba(30,30,32,0.5)');
      grd.addColorStop(0.55, 'rgba(40,40,44,0.28)');
      grd.addColorStop(0.9, 'rgba(60,58,50,0.22)');
      grd.addColorStop(0.945, 'rgba(225,185,60,0.42)');
      grd.addColorStop(0.985, 'rgba(225,185,60,0.3)');
      grd.addColorStop(1, 'rgba(225,185,60,0)');
      c.fillStyle = grd;
      c.fillRect(0, 0, 256, 256);
      const discMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 40), discMat);
      disc.position.z = -0.02;
      const discGrp = new THREE.Group();
      discGrp.position.copy(hub.position);
      discGrp.add(disc);
      root.add(hub, discGrp);
      parts.prop = { hub, bladeMesh, bladeMat, discMat, angle: 0 };
    }

    // ---- lights
    {
      const glowTex = FS.G3.glowTexture();
      const mk = (pos, color, size) => {
        const m = new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
        const s = new THREE.Sprite(m);
        s.position.copy(pos);
        s.scale.setScalar(size);
        s.userData.size = size;
        root.add(s);
        return s;
      };
      const lens = [];
      const lensAt = (pos, color) => lens.push(prim(new THREE.SphereGeometry(0.035, 8, 6), color, TRS(pos)));
      const tipZ = wingZ(Y_TIP - 0.05);
      lensAt(B(-0.4, -Y_TIP + 0.03, tipZ), 0xc81e1e);
      lensAt(B(-0.4, Y_TIP - 0.03, tipZ), 0x1eb450);
      lensAt(B(-5.3, 0, -1.66), 0xc81e1e);
      root.add(new THREE.Mesh(merge(lens), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.2, emissive: 0x222222 })));
      parts.lights = {
        navL: mk(B(-0.4, -Y_TIP, tipZ), 0xff2a22, 0.5),
        navR: mk(B(-0.4, Y_TIP, tipZ), 0x26ff66, 0.5),
        tail: mk(B(-5.9, 0, -0.5), 0xffffff, 0.4),
        beacon: mk(B(-5.3, 0, -1.72), 0xff2a22, 1.6),
        strobeL: mk(B(-0.5, -Y_TIP, tipZ), 0xffffff, 3.2),
        strobeR: mk(B(-0.5, Y_TIP, tipZ), 0xffffff, 3.2),
        landing: mk(B(2.3, 0, 0.36), 0xfff4d8, 1.8),
      };
    }

    // ---- wool tufts on the wing: the classic flight-test trick for SEEING airflow.
    // Attached flow lays them flat and straight back; separated (stalled) flow makes them flail and reverse.
    {
      const tufts = [];
      for (const s of [-1, 1])
        for (let j = 0; j < 10; j++)
          for (const xc of [0.22, 0.45, 0.68]) {
            const y = lerp(0.95, 5.0, j / 9);
            const c = wingLE(y) - wingTE(y);
            tufts.push({ s, y, xc, at: B(wingLE(y) - xc * c, s * y, wingZ(y) - airfoil(xc, 0.15, 0.02)[0] * c - 0.012), ph: Math.random() * 6.28, sep: 0 });
          }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tufts.length * 12), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tufts.length * 12), 3).setUsage(THREE.DynamicDrawUsage));
      const idx = [];
      tufts.forEach((_, i) => idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false }));
      m.frustumCulled = false;
      m.visible = false;
      root.add(m);
      parts.tufts = { mesh: m, list: tufts };
    }

    // ---- cockpit interior (only shown from the pilot's seat)
    {
      const cockpit = new THREE.Group();
      const g = [];
      // glareshield: a curved, matte-black eyebrow over the instrument panel
      const rows = [];
      for (let i = 0; i <= 5; i++) {
        const f = i / 5;
        const x = lerp(1.17, 0.8, f);
        const row = [];
        for (let j = 0; j <= 14; j++) {
          const y = lerp(-0.53, 0.53, j / 14);
          const crown = 0.035 * (1 - Math.pow(y / 0.53, 2));
          row.push(B(x, y, lerp(-0.345, -0.36, f) - crown - f * f * 0.012));
        }
        rows.push(row);
      }
      const gs = gridGeom(rows);
      orientToward(gs, () => new THREE.Vector3(0, 1, 0));
      g.push(paint(smoothNormals(gs), COL.glare));
      // the lip of the glareshield and the top of the panel below it
      g.push(prim(new THREE.BoxGeometry(1.08, 0.03, 0.03), COL.glare, TRS(B(0.8, 0, -0.355))));
      g.push(prim(new THREE.BoxGeometry(1.1, 0.5, 0.02), 0x2b2c2f, TRS(B(0.86, 0, -0.1))));
      // windshield centre post and A-pillars follow the skin
      const post = (pts, r) => {
        for (let i = 0; i < pts.length - 1; i++) g.push(tube(pts[i], pts[i + 1], r, COL.interior, 6));
      };
      const cp = [];
      for (let i = 0; i <= 6; i++) {
        const x = lerp(1.22, 0.74, i / 6);
        cp.push(B(x, 0, topZ(x, 0, -0.015)));
      }
      post(cp, 0.011);
      for (const s of [-1, 1]) {
        // A-pillar runs up the edge of the windshield and carries on aft as the roof rail
        const ap = [];
        for (let i = 0; i <= 12; i++) {
          const x = lerp(1.22, -1.2, Math.pow(i / 12, 1.4));
          const th = (PILLAR_TH - 2) * U.DEG;
          const p = skin(x, s > 0 ? th : Math.PI - th, -0.012);
          ap.push(B(p[0], p[1], p[2]));
        }
        post(ap, 0.013);
        post([B(-0.4, s * sideY(-0.4, -0.74, -0.02), -0.74), B(-0.4, s * sideY(-0.4, -0.42, -0.02), -0.42)], 0.018);
      }
      // headliner
      const hl = [];
      for (let i = 0; i <= 4; i++) {
        const x = lerp(0.74, -1.3, i / 4);
        const row = [];
        for (let j = 0; j <= 8; j++) {
          const y = lerp(-0.42, 0.42, j / 8);
          row.push(B(x, y, topZ(x, y, -0.02)));
        }
        hl.push(row);
      }
      const hg = gridGeom(hl);
      orientToward(hg, () => new THREE.Vector3(0, -1, 0));
      g.push(paint(smoothNormals(hg), 0x8d8a82));
      // whiskey compass on the centre post
      g.push(prim(new THREE.BoxGeometry(0.055, 0.04, 0.04), 0x0d0d0e, TRS(B(1.0, 0, -0.56))));
      const mesh = new THREE.Mesh(merge(g), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0.25 }));
      cockpit.add(mesh);
      cockpit.visible = false;
      root.add(cockpit);
      parts.cockpit = cockpit;
    }

    root.userData.parts = parts;
    return root;
  }

  /** Pose the moving parts from the flight model. `env.dark` in 0..1 brightens the lights at night. */
  function animateAirplane(root, ac, dt, env) {
    const P = root.userData.parts;
    const out = ac.out || {};
    const s = ac.s;
    // control surfaces
    const flap = (s.flapDeg || 0) * U.DEG;
    for (const f of P.flaps) f.userData.rot.rotation.x = flap;
    const ail = out.ail || 0;
    for (const a of P.ailerons) a.grp.userData.rot.rotation.x = a.side > 0 ? -ail : ail;
    P.stab.userData.rot.rotation.x = -(out.stab || 0);
    P.rudder.userData.rot.rotation.x = out.rud || 0;

    // propeller
    const omega = s.omegaP || 0;
    P.prop.angle = (P.prop.angle + omega * dt) % (Math.PI * 2);
    P.prop.hub.rotation.z = -P.prop.angle; // clockwise from the cockpit
    const rpm = (omega * 60) / (2 * Math.PI);
    const blur = clamp((rpm - 120) / 420, 0, 1);
    P.prop.bladeMat.opacity = 1 - blur * 0.97;
    P.prop.bladeMesh.castShadow = blur < 0.5;
    P.prop.discMat.opacity = blur * (0.5 + 0.2 * clamp(rpm / 2700, 0, 1)) * (env && env.cockpit ? 0.35 : 1);

    // gear: oleo compression, wheel spin, nose-wheel steering
    const R = out.R;
    const gs = Math.hypot(s.vel[0], s.vel[1]);
    const fwdSpeed = R ? s.vel[0] * R[0] + s.vel[1] * R[3] + s.vel[2] * R[6] : gs;
    for (let i = 0; i < P.gear.length; i++) {
      const g = P.gear[i];
      const info = (out.gear && out.gear.find((x) => x.id === g.id)) || { comp: 0 };
      const comp = clamp(info.comp || 0, 0, 0.26);
      g.comp = M.lowpass(g.comp || 0, comp, dt, 0.03);
      g.leg.position.y = B(0, 0, 0).y + g.comp;
      const braking = g.id !== 'nose' && (ac.ctl.parkingBrake || (g.id === 'left' ? ac.ctl.brakeL : ac.ctl.brakeR) > 0.95);
      if (comp > 0) g.omega = braking && Math.abs(fwdSpeed) < 3 ? 0 : fwdSpeed / 0.19;
      else g.omega *= Math.exp(-dt / 6); // spins down slowly once airborne
      g.touch = comp > 0;
      g.spin = (g.spin + g.omega * dt) % (Math.PI * 2);
      g.wheel.rotation.x = -g.spin;
      if (g.id === 'nose') g.steer.rotation.y = -clamp(ac.ctl.rudder || 0, -1, 1) * ac.d.controls.noseSteerMax * (comp > 0 ? 1 : 0.4);
    }

    // tufts
    if (P.tufts.mesh.visible) {
      const T = P.tufts, pos = T.mesh.geometry.attributes.position, colr = T.mesh.geometry.attributes.color;
      const alpha = (out.alpha || 0) * U.RAD, aStall = (out.aStall || 0.28) * U.RAD, beta = out.beta || 0;
      const V = out.V || 0;
      const tt = (ac.time || 0);
      T.list.forEach((tf, i) => {
        // a PA-28 wing lets go at the root first and at the trailing edge first, and the stall creeps forward and outboard
        const onset = aStall - 4.5 + 5.5 * ((tf.y - 0.95) / 4.05) - (tf.xc - 0.22) * 9;
        const want = V > 12 ? clamp((alpha - onset) / 2.5, 0, 1) : 0;
        tf.sep = M.lowpass(tf.sep, want, dt || 0.016, 0.12);
        const sep = tf.sep;
        const live = V > 6 ? 1 : 0;
        const w1 = Math.sin(tt * 31 + tf.ph), w2 = Math.sin(tt * 23 + tf.ph * 1.7), w3 = Math.sin(tt * 17 + tf.ph * 2.3);
        // direction in local axes: +Z is aft. Attached: straight back with a little shimmer. Separated: forward, up and thrashing.
        let dx = (-Math.sin(beta) * 0.6 + w1 * 0.05) * (1 - sep) + sep * (w2 * 0.9 + tf.s * 0.3);
        let dy = (1 - sep) * 0.02 + sep * (0.35 + 0.35 * w3) + (1 - live) * -0.9;
        let dz = (1 - sep) * 1 + sep * (-0.55 + 0.5 * w1);
        if (!live) { dx = 0; dz = 0.25; }
        const l = Math.hypot(dx, dy, dz) || 1, L = 0.24;
        dx = (dx / l) * L; dy = (dy / l) * L; dz = (dz / l) * L;
        // ribbon width runs spanwise
        const wx = 0.022, a = tf.at;
        pos.setXYZ(i * 4, a.x - wx, a.y, a.z);
        pos.setXYZ(i * 4 + 1, a.x + wx, a.y, a.z);
        pos.setXYZ(i * 4 + 2, a.x - wx + dx, a.y + dy, a.z + dz);
        pos.setXYZ(i * 4 + 3, a.x + wx + dx, a.y + dy, a.z + dz);
        const r = lerp(0.1, 1.0, sep), g2 = lerp(0.85, 0.16, sep), b2 = lerp(1.0, 0.12, sep);
        for (let k = 0; k < 4; k++) colr.setXYZ(i * 4 + k, r, g2, b2);
      });
      pos.needsUpdate = true;
      colr.needsUpdate = true;
    }

    // lights
    const t = ac.time || 0;
    const L = P.lights;
    const dark = env ? env.dark : 0;
    const k = 0.35 + 0.65 * dark;
    const setI = (sp, i) => {
      sp.material.opacity = clamp(i, 0, 1);
      sp.scale.setScalar(sp.userData.size * (0.22 + 0.9 * dark));
    };
    setI(L.navL, k);
    setI(L.navR, k);
    setI(L.tail, k * 0.8);
    const bt = t % 1.25;
    setI(L.beacon, bt < 0.12 ? 1 : 0);
    const stt = t % 1.1;
    const strobe = stt < 0.045 || (stt > 0.13 && stt < 0.175) ? 1 : 0;
    setI(L.strobeL, strobe);
    setI(L.strobeR, strobe);
    setI(L.landing, 0.5 + 0.5 * dark);
  }

  // shared helper textures
  const G3 = {
    B,
    gridGeom,
    paint,
    paintBy,
    merge,
    prim,
    TRS,
    tube,
    smoothNormals,
    orientOutward,
    orientToward,
    _glow: null,
    glowTexture() {
      if (this._glow) return this._glow;
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.12, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
      this._glow = new THREE.CanvasTexture(cv);
      return this._glow;
    },
  };
  FS.G3 = G3;
  FS.buildAirplane = buildAirplane;
  FS.animateAirplane = animateAirplane;
})();
