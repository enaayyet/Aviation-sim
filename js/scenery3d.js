/*
 * scenery3d.js — the world for the WebGL renderer: sky and sun, haze, terrain, the airport, trees,
 * buildings, clouds, lights. Built once from world.js (which stays the single source of truth for
 * where the runway, landmarks and PAPI are) and then animated every frame.
 *
 * Axes: the simulation is NED (north, east, down). three.js is Y-up, so   x = east, y = up, z = -north.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const THREE = globalThis.THREE;
  if (!THREE) return;
  const { U, M } = FS;
  const { clamp, lerp } = M;
  const G3 = FS.G3;

  const P = (n, e, d) => new THREE.Vector3(e, -d, -n);
  const col = (c) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);

  // Plain exponential haze (Koschmieder): contrast falls as exp(-distance / scale). The stock exp² fog
  // keeps the near field too clear and then walls off the distance, which hides aerial perspective.
  THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace(
    'float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
    'float fogFactor = 1.0 - exp( - fogDensity * vFogDepth );'
  );

  // ------------------------------------------------------------------ time of day
  const KEYS = [
    // sun elevation, zenith, horizon, sun colour, sun intensity, sky-fill intensity, ground bounce
    { el: -14, zen: 0x02040a, hor: 0x0b1222, sun: 0x8fa4d8, si: 0.28, hi: 0.16, gnd: 0x06080c },
    { el: -5, zen: 0x0b1838, hor: 0x4a465c, sun: 0xff7a3c, si: 0.0, hi: 0.24, gnd: 0x101216 },
    { el: 0, zen: 0x1d3f7c, hor: 0xc9a48c, sun: 0xff8a45, si: 1.0, hi: 0.7, gnd: 0x2a2620 },
    { el: 7, zen: 0x2a5ca8, hor: 0xcfd0cc, sun: 0xffc58a, si: 2.8, hi: 1.25, gnd: 0x4a463a },
    { el: 22, zen: 0x2b66bd, hor: 0xbdd6ea, sun: 0xfff0dc, si: 3.0, hi: 1.0, gnd: 0x5a5a48 },
    { el: 60, zen: 0x2460c0, hor: 0xb4d0ea, sun: 0xfffaf0, si: 3.3, hi: 1.05, gnd: 0x60604c },
  ];
  function envFor(hour) {
    const ang = ((hour - 6) / 12) * Math.PI;
    const el = 58 * Math.sin(ang);
    const az = (90 + (hour - 6) * 15) * U.DEG; // east at 06, south at 12, west at 18
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].el < el) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = clamp((el - a.el) / (b.el - a.el), 0, 1);
    const mixc = (x, y) => new THREE.Color(x).lerp(new THREE.Color(y), t);
    // keep the light above the horizon so shadows stay sane; after dusk the moon takes over, high in the opposite sky
    const moon = el < -5;
    const elr = (moon ? 48 : Math.max(el, 2)) * U.DEG;
    const azl = moon ? az + Math.PI : az;
    const dirNED = [Math.cos(elr) * Math.cos(azl), Math.cos(elr) * Math.sin(azl), -Math.sin(elr)]; // toward the light
    const trueEl = el * U.DEG;
    return {
      hour,
      el,
      zen: mixc(a.zen, b.zen),
      hor: mixc(a.hor, b.hor),
      sunCol: mixc(a.sun, b.sun),
      sunI: lerp(a.si, b.si, t),
      hemiI: lerp(a.hi, b.hi, t),
      gnd: mixc(a.gnd, b.gnd),
      dark: 1 - M.smoothstep(-5, 9, el),
      sunDir: P(dirNED[0], dirNED[1], dirNED[2]).normalize(),
      sunDirTrue: P(Math.cos(trueEl) * Math.cos(az), Math.cos(trueEl) * Math.sin(az), -Math.sin(trueEl)).normalize(),
    };
  }

  // ------------------------------------------------------------------ shaders
  const NOISE_GLSL = `
    float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ return 0.5*vnoise(p) + 0.3*vnoise(p*2.13+7.1) + 0.2*vnoise(p*4.31+3.7); }
  `;
  /** A Lambert material that adds procedural ground texture (so speed and height are readable). */
  function groundMaterial({ rows = 0, patch = 0, grain = 1, color = 0xffffff, vertexColors = true, depthWrite = false } = {}) {
    const m = new THREE.MeshLambertMaterial({ vertexColors, color, depthWrite });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uRows = { value: rows };
      sh.uniforms.uPatch = { value: patch };
      sh.uniforms.uGrain = { value: grain };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nuniform float uRows, uPatch, uGrain;\n${NOISE_GLSL}`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec2 p = vWPos.xz;
            float d = distance(cameraPosition, vWPos);
            #define FADE(D) (1.0 - smoothstep((D)*0.4, (D), d))
            if (uPatch > 0.5) {
              // endless farmland beyond the modelled area: quarter-section patches of crop colours
              vec2 cell = floor(p / 804.5);
              float h = hash21(cell), h2 = hash21(cell + 17.0);
              vec3 a = mix(vec3(0.17,0.26,0.07), vec3(0.29,0.31,0.10), h);
              a = mix(a, vec3(0.38,0.33,0.15), step(0.72, h2) * 0.8);
              a = mix(a, vec3(0.10,0.19,0.05), step(h2, 0.2) * 0.7);
              vec2 fp = fract(p / 804.5);
              float edge = smoothstep(0.0, 0.012, min(min(fp.x, 1.0-fp.x), min(fp.y, 1.0-fp.y)));
              diffuseColor.rgb = mix(diffuseColor.rgb * 0.8, a, 0.85 * edge);
            }
            float f = 1.0;
            f += 0.22 * (fbm(p / 260.0) - 0.5);
            f += 0.16 * (fbm(p / 31.0) - 0.5) * FADE(4000.0);
            f += uGrain * 0.20 * (fbm(p / 3.1) - 0.5) * FADE(700.0);
            f += uGrain * 0.22 * (vnoise(p / 0.33) - 0.5) * FADE(70.0);
            if (uRows > 0.5) {
              // crop rows: direction and spacing change from field to field
              vec2 cell = floor(p / 402.25);
              float h = hash21(cell + 3.0);
              float c = h > 0.5 ? p.x : p.y;
              float period = mix(3.0, 7.0, hash21(cell + 9.0));
              f += 0.10 * sin(c * 6.2832 / period) * FADE(600.0);
              f += 0.06 * sin(c * 6.2832 / (period * 9.0)) * FADE(5000.0);
            }
            diffuseColor.rgb *= f;
          }`
        );
    };
    return m;
  }

  const SKY_VERT = `
    varying vec3 vDir;
    void main(){
      vDir = normalize(position);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
    }`;
  const SKY_FRAG = `
    uniform vec3 uZen, uHor, uSun, uSunDir, uGnd;
    uniform float uSunI, uDark;
    varying vec3 vDir;
    ${NOISE_GLSL}
    void main(){
      vec3 d = normalize(vDir);
      float h = d.y;
      float cosS = max(dot(d, uSunDir), 0.0);
      // gradient: deep at the zenith, pale at the horizon, with a brighter band toward the sun
      float t = pow(clamp(h, 0.0, 1.0), 0.42);
      vec3 col = mix(uHor, uZen, t);
      float lowSun = 1.0 - smoothstep(0.0, 0.45, uSunDir.y);
      col += uSun * pow(cosS, 8.0) * 0.22 * (0.4 + lowSun) * (1.0 - t * 0.7);
      col += uSun * vec3(1.0, 0.62, 0.35) * pow(cosS, 2.0) * 0.38 * lowSun * (1.0 - t) * min(uSunI + 0.4, 1.0);
      // below the horizon: haze fading to dark ground (only visible in steep banks at altitude)
      if (h < 0.0) col = mix(uHor, uGnd, smoothstep(0.0, -0.35, h));
      // sun disc and aureole
      float disc = smoothstep(0.99985, 0.99996, cosS);
      col += uSun * (disc * 30.0 + pow(cosS, 900.0) * 3.0 + pow(cosS, 120.0) * 0.5) * step(-0.02, uSunDir.y + 0.03) * min(uSunI + 0.3, 1.5);
      // high cirrus streaks
      vec2 cp = d.xz / max(h + 0.12, 0.05);
      float ci = fbm(cp * vec2(0.55, 1.7) + 4.0) * fbm(cp * 0.23 + 11.0);
      col = mix(col, mix(uHor, vec3(1.0), 0.6) * (1.0 - 0.8 * uDark), smoothstep(0.3, 0.62, ci) * 0.35 * smoothstep(0.02, 0.3, h));
      // stars
      if (uDark > 0.5 && h > 0.0) {
        vec2 sp = d.xz / (h + 0.4) * 160.0;
        float s = step(0.9982, hash21(floor(sp))) * (0.4 + 0.6 * hash21(floor(sp) + 5.0));
        col += vec3(s) * (uDark - 0.5) * 2.0 * smoothstep(0.0, 0.25, h);
      }
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  // ------------------------------------------------------------------ textures
  function cloudTexture(seed) {
    const r = M.rng(seed);
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d');
    // a heap of soft blobs: flat-ish bottom, cauliflower top
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2, rad = Math.pow(r(), 0.7) * 62;
      const x = S / 2 + Math.cos(a) * rad * 1.25, y = S / 2 + 18 - Math.abs(Math.sin(a)) * rad * 0.85;
      const rr = 26 + r() * 34;
      const g = c.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.28)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, S, S);
    }
    // shade the base
    c.globalCompositeOperation = 'source-atop';
    const g = c.createLinearGradient(0, S * 0.3, 0, S * 0.78);
    g.addColorStop(0, 'rgba(120,130,150,0)');
    g.addColorStop(1, 'rgba(96,106,128,0.62)');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ------------------------------------------------------------------ scenery
  class Scenery {
    constructor(world, scene) {
      this.world = world;
      this.scene = scene;
      this.rand = M.rng(99);
      this.env = null;
      this.t = 0;
      this.buildSky();
      this.buildLights();
      this.buildGround();
      this.buildHills();
      this.buildObjects();
      this.buildClouds();
    }

    // ---------------------------------------------------------------- sky & light
    buildSky() {
      this.skyMat = new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        uniforms: {
          uZen: { value: new THREE.Color() },
          uHor: { value: new THREE.Color() },
          uSun: { value: new THREE.Color() },
          uGnd: { value: new THREE.Color() },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunI: { value: 1 },
          uDark: { value: 0 },
        },
      });
      this.sky = new THREE.Mesh(new THREE.SphereGeometry(60000, 32, 20), this.skyMat);
      this.sky.renderOrder = -100;
      this.sky.frustumCulled = false;
      this.scene.add(this.sky);
      this.scene.fog = new THREE.FogExp2(0xbdd6ea, 0.00006);
    }

    buildLights() {
      this.sun = new THREE.DirectionalLight(0xffffff, 3);
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      const sc = this.sun.shadow.camera;
      sc.left = sc.bottom = -34;
      sc.right = sc.top = 34;
      sc.near = 50;
      sc.far = 1600;
      this.sun.shadow.bias = -0.00004;
      this.sun.shadow.normalBias = 0.03;
      this.scene.add(this.sun, this.sun.target);
      this.hemi = new THREE.HemisphereLight(0xbdd6ea, 0x5a5a48, 1);
      this.scene.add(this.hemi);
    }

    /** Apply a time of day. Returns true when the sky changed enough to re-bake reflections. */
    setTime(hour, visM) {
      const changed = !this.env || Math.abs(this.env.hour - hour) > 1e-3;
      if (changed) {
        const e = (this.env = envFor(hour));
        const u = this.skyMat.uniforms;
        u.uZen.value.copy(e.zen);
        u.uHor.value.copy(e.hor);
        u.uSun.value.copy(e.sunCol);
        u.uGnd.value.copy(e.gnd);
        u.uSunDir.value.copy(e.sunDirTrue);
        u.uSunI.value = e.sunI;
        u.uDark.value = e.dark;
        this.sun.color.copy(e.sunCol);
        this.sun.intensity = e.sunI;
        this.hemi.color.copy(e.hor).lerp(e.zen, 0.45);
        this.hemi.groundColor.copy(e.gnd);
        this.hemi.intensity = e.hemiI;
        this.scene.fog.color.copy(e.hor);
        this.placeTreeShadows();
        const day = 1 - e.dark;
        this.cloudMat.forEach((m) => m.color.copy(e.sunCol).lerp(new THREE.Color(0xffffff), 0.6).multiplyScalar(0.25 + 0.75 * day).lerp(e.hor, 0.12));
        this.lightsMat.size = lerp(1.1, 5.5, e.dark);
        this.lightsMat.opacity = lerp(0.55, 1, e.dark);
      }
      this.scene.fog.density = 3.0 / Math.max(1500, visM);
      return changed;
    }

    // ---------------------------------------------------------------- ground
    buildGround() {
      const C = FS.World.COLORS;
      const grp = new THREE.Group();
      // endless base
      const base = new THREE.Mesh(new THREE.PlaneGeometry(240000, 240000, 1, 1).rotateX(-Math.PI / 2), groundMaterial({ patch: 1, vertexColors: false, color: col(C.grass) }));
      base.renderOrder = -60;
      base.receiveShadow = true;
      grp.add(base);

      // world polygons, one mesh per paint layer
      const layers = new Map();
      const water = [];
      for (const f of this.world.flat) {
        const isWater = f.color === C.water;
        let L = isWater ? water : layers.get(f.layer);
        if (!L) layers.set(f.layer, (L = []));
        const c = col(f.color);
        const pts = f.pts;
        // fan from the centroid (the lake outline is star-shaped about it)
        const cx = f.cn, cy = f.ce;
        if (pts.length === 4) {
          for (const [a, b, d] of [[0, 1, 2], [0, 2, 3]]) L.push([pts[a], pts[b], pts[d], c]);
        } else {
          for (let i = 0; i < pts.length; i++) L.push([[cx, cy], pts[i], pts[(i + 1) % pts.length], c]);
        }
      }
      const toGeom = (tris) => {
        const pos = new Float32Array(tris.length * 9), colr = new Float32Array(tris.length * 9), nrm = new Float32Array(tris.length * 9);
        tris.forEach((t, i) => {
          // wind counter-clockwise seen from above
          const [a, b, c] = t;
          const cross = (b[1] - a[1]) * -(c[0] - a[0]) - -(b[0] - a[0]) * (c[1] - a[1]);
          const order = cross < 0 ? [a, b, c] : [a, c, b];
          order.forEach((p, k) => {
            pos.set([p[1], 0, -p[0]], i * 9 + k * 3);
            colr.set([t[3].r, t[3].g, t[3].b], i * 9 + k * 3);
            nrm.set([0, 1, 0], i * 9 + k * 3);
          });
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(colr, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        return g;
      };
      const matFor = (layer) => (layer === 0 ? groundMaterial({ rows: 1 }) : layer >= 5 ? groundMaterial({ grain: 0.35 }) : groundMaterial({ grain: 0.8 }));
      for (const [layer, tris] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
        const mat = matFor(layer);
        mat.side = THREE.DoubleSide;
        const m = new THREE.Mesh(toGeom(tris), mat);
        m.renderOrder = -50 + layer;
        m.receiveShadow = true;
        m.frustumCulled = false;
        grp.add(m);
      }
      if (water.length) {
        const wm = new THREE.MeshStandardMaterial({ color: 0x0f2a44, roughness: 0.08, metalness: 0.35, envMapIntensity: 1.5, depthWrite: false, side: THREE.DoubleSide });
        const m = new THREE.Mesh(toGeom(water), wm);
        m.material.vertexColors = false;
        m.renderOrder = -49;
        grp.add(m);
        this.waterMat = wm;
      }
      // rubber on the touchdown zones and an oil-stained centreline: makes the runway read as used
      {
        const rw = this.world.runway;
        const r = M.rng(5);
        const tris = [];
        const k = new THREE.Color(0x000000);
        const quad = (n0, n1, e0, e1) => {
          tris.push([[n0, e0], [n1, e0], [n1, e1], k], [[n0, e0], [n1, e1], [n0, e1], k]);
        };
        for (const dir of [1, -1]) {
          for (let i = 0; i < 90; i++) {
            const along = 150 + Math.abs(r.gauss()) * 170;
            const n = dir > 0 ? along : rw.length - along;
            const e = (r() < 0.5 ? -1 : 1) * (1.5 + r.gauss() * 0.5) + r.gauss() * 1.2;
            const len = 12 + r() * 40;
            quad(n, n + dir * len, e - 0.16, e + 0.16);
          }
        }
        const m = new THREE.Mesh(toGeom(tris), new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }));
        m.renderOrder = -42;
        grp.add(m);
      }
      this.scene.add(grp);
    }

    // ---------------------------------------------------------------- distant terrain
    buildHills() {
      const r = M.rng(31);
      const ph = [r() * 6.28, r() * 6.28, r() * 6.28, r() * 6.28];
      // value noise on a lattice (CPU)
      const hsh = (i, j) => {
        const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
        return s - Math.floor(s);
      };
      const vn = (x, y) => {
        const i = Math.floor(x), j = Math.floor(y);
        let fx = x - i, fy = y - j;
        fx = fx * fx * (3 - 2 * fx);
        fy = fy * fy * (3 - 2 * fy);
        return lerp(lerp(hsh(i, j), hsh(i + 1, j), fx), lerp(hsh(i, j + 1), hsh(i + 1, j + 1), fx), fy);
      };
      const height = (x, z) => {
        const rad = Math.hypot(x, z), a = Math.atan2(z, x);
        const ramp = M.smoothstep(15500, 27000, rad);
        if (ramp <= 0) return 0;
        const big = 0.5 + 0.5 * Math.sin(a * 2 + ph[0]); // ranges in two opposite quadrants: a heading reference
        const ridge = 1 - Math.abs(2 * vn(x / 5200 + 3, z / 5200) - 1);
        const n = 0.55 * ridge * ridge + 0.3 * vn(x / 2300, z / 2300) + 0.15 * vn(x / 900 + 9, z / 900);
        return ramp * (0.18 + 0.82 * big) * n * 2100;
      };
      /** Terrain height (m above the field) at a north/east position — the mountains are solid. */
      this.heightAt = (n, e) => height(e, -n);
      const NR = 40, NA = 240;
      const rows = [];
      for (let i = 0; i <= NR; i++) {
        const rad = lerp(15000, 52000, Math.pow(i / NR, 1.25));
        const row = [];
        for (let j = 0; j <= NA; j++) {
          const a = (j / NA) * Math.PI * 2;
          const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
          row.push(new THREE.Vector3(x, height(x, z) - (i === 0 ? 2 : 0), z));
        }
        rows.push(row);
      }
      const g = G3.gridGeom(rows);
      G3.orientToward(g, () => new THREE.Vector3(0, 1, 0));
      g.computeVertexNormals();
      const nrm = g.attributes.normal;
      const low = new THREE.Color(0x3b5a24), forest = new THREE.Color(0x24401f), rock = new THREE.Color(0x6a6458), snow = new THREE.Color(0xdfe4ea);
      const c = new THREE.Color();
      G3.paintBy(g, () => 0xffffff);
      const ca = g.attributes.color;
      for (let i = 0; i < ca.count; i++) {
        const h = g.attributes.position.getY(i), slope = 1 - nrm.getY(i);
        c.copy(low).lerp(forest, M.smoothstep(40, 300, h));
        c.lerp(rock, M.smoothstep(650, 1100, h + slope * 900));
        c.lerp(snow, M.smoothstep(1350, 1650, h - slope * 500));
        ca.setXYZ(i, c.r, c.g, c.b);
      }
      const m = new THREE.Mesh(g, groundMaterial({ grain: 1.6, depthWrite: true }));
      m.frustumCulled = false;
      this.scene.add(m);
    }

    // ---------------------------------------------------------------- objects
    buildObjects() {
      const world = this.world;
      const r = this.rand;
      const rw = world.runway;
      const objs = world.objects.slice();
      // extra farmsteads so the countryside has scale cues (a house is ~6 m tall: a ruler you already own)
      const S = 1609;
      for (let k = 0; k < 110; k++) {
        const n = (Math.floor(r.range(-8, 8)) + r.range(0.08, 0.3)) * S, e = (Math.floor(r.range(-8, 8)) + r.range(0.08, 0.3)) * S;
        if (n > -900 && n < rw.length + 900 && Math.abs(e) < 700) continue;
        const rot = r() < 0.5;
        objs.push({ type: 'box', p: [n, e, 0], l: rot ? 9 : 14, w: rot ? 14 : 9, h: 4.5, color: [222, 216, 200], roof: [92, 70, 62], gable: true });
        objs.push({ type: 'box', p: [n + 34, e + 12, 0], l: 22, w: 12, h: 7, color: r() < 0.6 ? [150, 44, 38] : [188, 190, 186], roof: [70, 72, 76], gable: true });
        if (r() < 0.6) objs.push({ type: 'tower', p: [n + 48, e + 26, 0], h: r.range(14, 22), r: 3, color: [196, 198, 196] });
        for (let t = 0; t < 7; t++) objs.push({ type: 'tree', p: [n + r.range(-40, 60), e + r.range(-45, 50), 0], h: r.range(8, 15), r: r.range(3, 6), shade: r.range(0.85, 1.15) });
      }
      // more woodland and shelter belts
      for (let k = 0; k < 2600; k++) {
        let n, e;
        if (k < 1100) {
          const line = Math.floor(r.range(-8, 8));
          const along = r.range(-13000, 13000);
          const off = r.range(10, 26) * (r() < 0.5 ? -1 : 1);
          if (r() < 0.5) [n, e] = [line * S + off, along];
          else [n, e] = [along, line * S + off];
          if (hash(Math.floor(along / 500), line) < 0.55) continue; // belts come in runs, with gaps
        } else {
          const cl = WOODS[k % WOODS.length];
          n = cl[0] + r.gauss() * cl[2];
          e = cl[1] + r.gauss() * cl[2];
        }
        if (n > -700 && n < rw.length + 700 && e > -420 && e < 440) continue;
        objs.push({ type: 'tree', p: [n, e, 0], h: r.range(9, 19), r: r.range(3.5, 7), shade: r.range(0.8, 1.15) });
      }

      // ---- trees (instanced)
      const trees = objs.filter((o) => o.type === 'tree');
      {
        const canopy = new THREE.IcosahedronGeometry(1, 1);
        const p = canopy.attributes.position;
        const v = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i);
          const bump = 1 + 0.22 * Math.sin(v.x * 5.1 + 1) * Math.sin(v.y * 4.3 + 2) * Math.sin(v.z * 4.7);
          v.multiplyScalar(bump);
          p.setXYZ(i, v.x, v.y * 1.05 + 0.2, v.z);
        }
        canopy.computeVertexNormals();
        G3.paintBy(canopy, (q) => new THREE.Color(0xffffff).multiplyScalar(lerp(0.5, 1.08, clamp((q.y + 0.8) / 2, 0, 1))));
        const cm = new THREE.InstancedMesh(canopy, new THREE.MeshLambertMaterial({ vertexColors: true }), trees.length);
        const tm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.17, 1, 6), new THREE.MeshLambertMaterial({ color: 0x4a3a2a }), trees.length);
        const sm = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }), trees.length);
        const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
        const greens = [0x35591f, 0x2c4d1c, 0x44662a, 0x3d5a18, 0x506c2c];
        trees.forEach((t, i) => {
          const [n, e] = t.p;
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28);
          const ch = t.h * 0.72;
          mat.compose(new THREE.Vector3(e, t.h - ch * 0.52, -n), q, new THREE.Vector3(t.r, ch * 0.52, t.r));
          cm.setMatrixAt(i, mat);
          c.set(greens[(r() * greens.length) | 0]).multiplyScalar(t.shade);
          cm.setColorAt(i, c);
          mat.compose(new THREE.Vector3(e, t.h * 0.22, -n), q, new THREE.Vector3(t.r * 0.9, t.h * 0.44, t.r * 0.9));
          tm.setMatrixAt(i, mat);
        });
        cm.frustumCulled = tm.frustumCulled = sm.frustumCulled = false;
        sm.renderOrder = -30;
        this.scene.add(cm, tm, sm);
        this.trees = trees;
        this.treeShadows = sm;
      }

      // ---- buildings and towers (one merged mesh)
      {
        const parts = [];
        for (const o of objs) {
          const [n, e] = o.p;
          if (o.type === 'box') {
            const wall = col(o.color), roof = col(o.roof || [110, 110, 110]);
            // l runs north-south, w east-west
            const body = new THREE.BoxGeometry(o.w, o.h, o.l);
            body.translate(e, o.h / 2, -n);
            parts.push(G3.paint(body.toNonIndexed(), wall));
            const big = o.l > 30 && o.h > 7;
            if (o.gable || (o.h < 13 && !big)) {
              // gable roof along the long axis
              const rh = Math.min(o.w, o.l) * 0.28;
              const along = o.l >= o.w;
              const hw = (along ? o.w : o.l) / 2 + 0.4, hl = (along ? o.l : o.w) / 2 + 0.4;
              const v = [
                [-hw, 0, -hl], [hw, 0, -hl], [0, rh, -hl],
                [-hw, 0, hl], [hw, 0, hl], [0, rh, hl],
              ].map(([x, y, z]) => (along ? new THREE.Vector3(e + x, o.h + y, -n + z) : new THREE.Vector3(e + z, o.h + y, -n + x)));
              const tri = [[0, 2, 1], [3, 4, 5], [0, 3, 5], [0, 5, 2], [1, 2, 5], [1, 5, 4]];
              const pos = [];
              for (const t of tri) for (const k of t) pos.push(v[k].x, v[k].y, v[k].z);
              const g = new THREE.BufferGeometry();
              g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
              g.setIndex([...Array(pos.length / 3).keys()]);
              G3.orientOutward(g);
              g.computeVertexNormals();
              // gable ends take the wall colour
              parts.push(G3.paintBy(g.toNonIndexed(), () => roof));
            } else if (big) {
              // hangar: low arched roof and a dark door on the runway side
              const arch = new THREE.CylinderGeometry(o.w / 2, o.w / 2, o.l, 16, 1, false, 0, Math.PI);
              arch.rotateX(Math.PI / 2).rotateZ(Math.PI / 2);
              arch.scale(1, 0.22, 1);
              arch.translate(e, o.h, -n);
              parts.push(G3.paint(arch.toNonIndexed(), roof));
              const door = new THREE.BoxGeometry(0.3, o.h * 0.8, o.l * 0.78);
              door.translate(e - o.w / 2 - 0.05, o.h * 0.4, -n);
              parts.push(G3.paint(door.toNonIndexed(), new THREE.Color(0x3a4048)));
            } else {
              const top = new THREE.BoxGeometry(o.w + 0.6, 0.5, o.l + 0.6);
              top.translate(e, o.h + 0.25, -n);
              parts.push(G3.paint(top.toNonIndexed(), roof));
              // rows of windows on taller buildings
              if (o.h > 15) {
                for (let y = 3; y < o.h - 2; y += 3.4) {
                  const band = new THREE.BoxGeometry(o.w + 0.12, 1.3, o.l + 0.12);
                  band.translate(e, y, -n);
                  parts.push(G3.paint(band.toNonIndexed(), new THREE.Color(0x263442)));
                }
              }
            }
          } else if (o.type === 'tower') {
            const c = col(o.color);
            if (o.label === 'water tower') {
              const tank = new THREE.SphereGeometry(o.r * 1.5, 16, 10);
              tank.scale(1, 0.62, 1);
              tank.translate(e, o.h - o.r * 0.8, -n);
              parts.push(G3.paint(tank.toNonIndexed(), c));
              const stem = new THREE.CylinderGeometry(o.r * 0.25, o.r * 0.5, o.h - o.r, 10);
              stem.translate(e, (o.h - o.r) / 2, -n);
              parts.push(G3.paint(stem.toNonIndexed(), c));
            } else {
              const cyl = new THREE.CylinderGeometry(o.r, o.r, o.h, 16);
              cyl.translate(e, o.h / 2, -n);
              parts.push(G3.paint(cyl.toNonIndexed(), c));
              const dome = new THREE.SphereGeometry(o.r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
              dome.translate(e, o.h, -n);
              parts.push(G3.paint(dome.toNonIndexed(), c.clone().multiplyScalar(0.8)));
            }
          }
        }
        parts.forEach((g) => g.computeVertexNormals());
        const m = new THREE.Mesh(G3.merge(parts), new THREE.MeshLambertMaterial({ vertexColors: true }));
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        this.scene.add(m);
      }

      // ---- airfield lights
      {
        const lights = objs.filter((o) => o.type === 'light');
        const pos = [], colr = [];
        for (const l of lights) {
          pos.push(l.p[1], -l.p[2], -l.p[0]);
          const c = col(l.color);
          colr.push(c.r, c.g, c.b);
        }
        // rotating beacon position (on the FBO) handled separately
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
        this.lightsMat = new THREE.PointsMaterial({ size: 1.2, map: G3.glowTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false });
        const pts = new THREE.Points(g, this.lightsMat);
        pts.frustumCulled = false;
        this.scene.add(pts);
        // little fixtures so the lights exist by day too
        const fix = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.12, 0.4, 6), new THREE.MeshLambertMaterial({ color: 0xd8c440 }), lights.length);
        const mat = new THREE.Matrix4();
        lights.forEach((l, i) => fix.setMatrixAt(i, mat.makeTranslation(l.p[1], 0.2, -l.p[0])));
        fix.frustumCulled = false;
        this.scene.add(fix);
      }

      // ---- PAPI
      this.papi = [];
      for (const o of objs.filter((x) => x.type === 'papi')) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.9), new THREE.MeshLambertMaterial({ color: 0xd87a1e }));
        box.position.set(o.p[1], 0.5, -o.p[0]);
        const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.1), new THREE.MeshLambertMaterial({ color: 0x555555 }));
        legs.position.set(o.p[1], 0.17, -o.p[0]);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: G3.glowTexture(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, sizeAttenuation: true }));
        sp.position.set(o.p[1], 0.55, -o.p[0]);
        this.scene.add(box, legs, sp);
        this.papi.push({ idx: o.idx, sprite: sp, p: o.p });
      }

      // ---- windsock: a pole and a chain of tapered fabric rings
      {
        const o = objs.find((x) => x.type === 'windsock');
        const grp = new THREE.Group();
        grp.position.set(o.p[1], 0, -o.p[0]);
        const H = 6.5;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, H, 8), new THREE.MeshLambertMaterial({ color: 0xe8e8e8 }));
        pole.position.y = H / 2;
        grp.add(pole);
        // segmented circle on the ground
        const ring = new THREE.Mesh(new THREE.RingGeometry(7.2, 8, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xf2f2ea, transparent: true, opacity: 0.85, depthWrite: false }));
        ring.renderOrder = -41;
        grp.add(ring);
        const yaw = new THREE.Group();
        yaw.position.y = H;
        grp.add(yaw);
        const segs = [];
        let parent = yaw;
        const N = 6, L = 3.4;
        for (let k = 0; k < N; k++) {
          const j = new THREE.Group();
          j.position.z = k === 0 ? 0 : -L / N; // sock streams along local -Z
          const r0 = lerp(0.48, 0.2, k / N), r1 = lerp(0.48, 0.2, (k + 1) / N);
          const cone = new THREE.CylinderGeometry(r1, r0, L / N, 12, 1, true);
          cone.rotateX(-Math.PI / 2);
          cone.translate(0, 0, -L / N / 2);
          const m = new THREE.Mesh(cone, new THREE.MeshLambertMaterial({ color: k % 2 ? 0xf4f4ee : 0xff6a14, side: THREE.DoubleSide }));
          j.add(m);
          parent.add(j);
          parent = j;
          segs.push(j);
        }
        this.scene.add(grp);
        this.sock = { yaw, segs, H };
      }

      // ---- airport beacon (green / white) on a short tower by the apron
      {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: G3.glowTexture(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
        sp.position.set(205, 14, -640);
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.35, 14, 6), new THREE.MeshLambertMaterial({ color: 0xb04030 }));
        mast.position.set(205, 7, -640);
        this.scene.add(mast, sp);
        this.beacon = sp;
      }
    }

    placeTreeShadows() {
      if (!this.treeShadows || !this.env) return;
      const s = this.env.sunDir;
      const horiz = Math.hypot(s.x, s.z), k = Math.min(horiz / Math.max(s.y, 0.12), 5); // shadow length per metre of height
      const dx = horiz > 1e-4 ? -s.x / horiz : 0, dz = horiz > 1e-4 ? -s.z / horiz : 0;
      const ang = Math.atan2(dx, dz);
      const mat = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
      this.trees.forEach((t, i) => {
        const len = t.h * 0.55 * k;
        mat.compose(new THREE.Vector3(t.p[1] + dx * len * 0.9, 0.02, -t.p[0] + dz * len * 0.9), q, new THREE.Vector3(t.r * 1.05, 1, t.r + len));
        this.treeShadows.setMatrixAt(i, mat);
      });
      this.treeShadows.instanceMatrix.needsUpdate = true;
      this.treeShadows.material.opacity = 0.34 * clamp(this.env.sunI / 2.5, 0, 1);
    }

    // ---------------------------------------------------------------- clouds
    buildClouds() {
      this.cloudMat = [1, 2, 3].map((s) => new THREE.SpriteMaterial({ map: cloudTexture(s * 17), transparent: true, depthWrite: false, fog: true, opacity: 0.93 }));
      this.clouds = new THREE.Group();
      this.scene.add(this.clouds);
      this.cloudKey = '';
      this.cloudDrift = new THREE.Vector3();
    }
    setClouds(cover, baseFt, fieldElevM) {
      const key = `${cover}|${baseFt}`;
      if (key === this.cloudKey) return;
      this.cloudKey = key;
      while (this.clouds.children.length) this.clouds.remove(this.clouds.children[0]);
      const count = [0, 16, 46, 110][clamp(cover | 0, 0, 3)];
      const r = M.rng(404);
      const base = baseFt * U.FT;
      const SPAN = 26000;
      for (let k = 0; k < count; k++) {
        const cx = r.range(-SPAN, SPAN), cz = r.range(-SPAN, SPAN);
        const size = r.range(0.7, 1.6) * (cover === 3 ? 1.35 : 1);
        const puffs = 5 + ((r() * 8) | 0);
        for (let i = 0; i < puffs; i++) {
          const sp = new THREE.Sprite(this.cloudMat[(r() * 3) | 0]);
          const w = r.range(520, 1050) * size;
          const up = Math.pow(r(), 1.6) * 420 * size; // towers are rarer than the flat base
          sp.position.set(cx + r.gauss() * 430 * size, base + up + w * 0.2, cz + r.gauss() * 430 * size);
          sp.scale.set(w, w * 0.62, 1);
          sp.userData.home = sp.position.clone();
          this.clouds.add(sp);
        }
      }
      void fieldElevM;
    }

    // ---------------------------------------------------------------- per-frame
    update(dt, cam, eyeNED, wx, darkOverride) {
      this.t += dt;
      const env = this.env;
      this.sky.position.copy(cam.position);
      // clouds drift with the wind aloft and wrap around the airplane so the sky never empties
      const w = wx.windAt(900);
      this.cloudDrift.x += w[1] * dt;
      this.cloudDrift.z -= w[0] * dt;
      const SPAN = 26000;
      for (const sp of this.clouds.children) {
        const h = sp.userData.home;
        let x = h.x + this.cloudDrift.x - cam.position.x, z = h.z + this.cloudDrift.z - cam.position.z;
        x = ((((x + SPAN) % (2 * SPAN)) + 2 * SPAN) % (2 * SPAN)) - SPAN;
        z = ((((z + SPAN) % (2 * SPAN)) + 2 * SPAN) % (2 * SPAN)) - SPAN;
        sp.position.set(cam.position.x + x, h.y, cam.position.z + z);
        // fade puffs at the wrap boundary and when the eye is inside one
        const dist = Math.hypot(x, z);
        sp.material = sp.material; // shared materials: per-sprite fade is done with scale-free opacity below
        sp.visible = dist < SPAN * 0.98;
      }
      // windsock
      {
        const wv = wx.windAt(this.sock.H);
        const spd = Math.hypot(wv[0], wv[1]) / U.KT;
        if (spd > 0.3) {
          const target = Math.atan2(-wv[1], wv[0]); // rotate local -Z (north) toward the downwind direction
          const cur = this.sock.yaw.rotation.y;
          let dy = target - cur;
          dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          this.sock.yaw.rotation.y = cur + dy * Math.min(1, dt * 2) + Math.sin(this.t * 1.3) * 0.004 * spd;
        }
        const droop = (1 - clamp(spd / 15, 0, 1)) * 78 * U.DEG;
        this.sock.segs.forEach((s, k) => {
          const flutter = Math.sin(this.t * (5 + spd * 0.5) - k * 0.9) * 0.05 * clamp(spd / 6, 0.15, 1.2);
          s.rotation.x = -(k === 0 ? droop * 0.45 : droop * 0.55 / (this.sock.segs.length - 1)) + flutter * (k ? 1 : 0.3);
          s.rotation.y = Math.cos(this.t * (4 + spd * 0.4) - k * 1.1) * 0.04 * clamp(spd / 6, 0.15, 1.2) * (k ? 1 : 0);
        });
      }
      // PAPI: white above its angle, red below — each box is a slice of the glide path
      for (const p of this.papi) {
        const white = this.world.papiLight(p.idx, eyeNED) === 'W';
        p.sprite.material.color.set(white ? 0xffffff : 0xff2414);
        const d = Math.hypot(eyeNED[0] - p.p[0], eyeNED[1] - p.p[1], eyeNED[2]);
        // keep the lights a readable size from the downwind leg to short final
        p.sprite.scale.setScalar(clamp(d * 0.011, 1.3, 46) * lerp(1, 1.5, env.dark));
        // the units only shine up the approach
        p.sprite.visible = eyeNED[0] < p.p[0] + 30;
      }
      // rotating beacon: alternating white / green flashes
      {
        const ph = (this.t * 0.42) % 1;
        const on = ph < 0.08 || (ph > 0.5 && ph < 0.58);
        this.beacon.material.color.set(ph < 0.3 ? 0xffffff : 0x30ff60);
        this.beacon.material.opacity = on ? 1 : 0;
        const d = this.beacon.position.distanceTo(cam.position);
        this.beacon.scale.setScalar(clamp(d * 0.012, 2, 80) * (0.5 + env.dark));
      }
      void darkOverride;
    }

    /** Keep the shadow frustum centred on the airplane. */
    aimSun(target) {
      this.sun.target.position.copy(target);
      this.sun.position.copy(target).addScaledVector(this.env.sunDir, 500);
    }
  }

  const WOODS = [
    [-1500, -2200, 260], [3000, -1800, 300], [-2600, 1300, 240], [1800, 2200, 220], [4600, 800, 320], [-800, 4200, 300],
    [7200, -5200, 520], [-6800, 6100, 600], [9500, 3800, 450], [-9200, -2600, 500], [5600, 9400, 560], [-4400, -8800, 620],
    [11800, -9000, 700], [-11500, 9800, 650], [2200, -11200, 480], [-2800, 11600, 520],
  ];
  function hash(i, j) {
    const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  FS.Scenery = Scenery;
  FS.sceneP = P;
})();
