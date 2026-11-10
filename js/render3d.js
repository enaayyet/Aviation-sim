/*
 * render3d.js — the WebGL renderer (three.js).
 *
 * Views:
 *   cockpit — the pilot's eye, with the cowling, wings and glareshield as attitude references
 *   chase   — an orbit camera on the airplane, showing control surfaces and live force vectors
 *   tower   — from the airport, great for watching your own landings
 *   flyby   — a fixed camera the airplane flies past (re-placed ahead of you every few seconds)
 *
 * The simulation is NED (north, east, down); three.js is Y-up: x = east, y = up, z = -north.
 * A transparent 2D canvas on top carries labels and the flight-path marker.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const THREE = globalThis.THREE;
  const { U, v3, quat, M } = FS;
  const { mulMV, mulMM, clamp } = M;

  const rotZ = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
  const rotY = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
  const rotX = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
  const P = (v) => new THREE.Vector3(v[1], -v[2], -v[0]);

  class Renderer {
    constructor(canvas, world) {
      this.cv = canvas;
      this.world = world;
      this.look = { yaw: 0, pitch: 0 };
      this.chase = { offset: null };
      this.rand = M.rng(42);
      this.shake = [0, 0];
      this.head = [0, 0, 0];
      this.cam = [0, 0, -2];
      this.flyby = { pos: null, t: 0 };
      this.ok = false;
      this.quality = 1;
      try {
        this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
      } catch (e) {
        this.fail(e);
        return;
      }
      const gl = this.gl;
      gl.outputColorSpace = THREE.SRGBColorSpace;
      gl.toneMapping = THREE.ACESFilmicToneMapping;
      gl.toneMappingExposure = 0.9;
      gl.shadowMap.enabled = true;
      gl.shadowMap.type = THREE.PCFSoftShadowMap;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(45, 1.6, 0.1, 90000);
      this.camera.matrixAutoUpdate = false;
      this.scenery = new FS.Scenery(world, this.scene);
      this.pmrem = new THREE.PMREMGenerator(gl);
      this.plane = null;
      this.buildArrows();
      this.buildSmoke();
      // 2D overlay for labels
      this.ov = document.createElement('canvas');
      this.ov.id = 'overlay2d';
      this.ov.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      canvas.parentNode.insertBefore(this.ov, canvas.nextSibling);
      this.ctx = this.ov.getContext('2d');
      this.ok = true;
      this.resize();
    }

    fail(e) {
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:#fff;background:#223;font:16px system-ui';
      d.textContent = 'This simulator needs WebGL. Enable hardware acceleration in your browser settings, or try a current Chrome, Edge, Firefox or Safari.';
      this.cv.parentNode.appendChild(d);
      console.error(e);
    }

    resize() {
      if (!this.ok) return;
      const r = this.cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.quality;
      this.Wc = Math.max(50, r.width);
      this.Hc = Math.max(50, r.height);
      this.dpr = dpr;
      this.gl.setPixelRatio(dpr);
      this.gl.setSize(this.Wc, this.Hc, false);
      this.ov.width = Math.round(this.Wc * dpr);
      this.ov.height = Math.round(this.Hc * dpr);
      this.W = this.ov.width;
      this.H = this.ov.height;
    }

    // ---------------------------------------------------------------- camera
    setupCamera(ac, view, dt) {
      const s = ac.s;
      const R = quat.toMatrix(s.q);
      this.R = R;
      const tele = view.tele;
      let C2W; // camera axes (columns: forward, right, down) in world NED
      let camPos;
      let near = 0.5;
      if (view.mode === 'cockpit') {
        this.look.yaw = M.lowpass(this.look.yaw, view.lookYaw * U.DEG, dt, 0.12);
        this.look.pitch = M.lowpass(this.look.pitch, view.lookPitch * U.DEG, dt, 0.12);
        // what the seat of your pants feels, shown as head motion: stall buffet, runway rumble, engine shake, G
        const buffet = tele.stall > 0.05 && !tele.onGround ? tele.stall : 0;
        const rumble = tele.onGround ? Math.min(1, tele.gs / 40) : 0;
        const engine = clamp(1 - Math.abs(tele.rpm - 700) / 500, 0, 1) * 0.03;
        const amp = (buffet * 0.6 + rumble * 0.12 + engine) * U.DEG;
        this.shake[0] = M.lowpass(this.shake[0], (this.rand() - 0.5) * 2 * amp, dt, 0.03);
        this.shake[1] = M.lowpass(this.shake[1], (this.rand() - 0.5) * 2 * amp, dt, 0.03);
        const f = ac.out;
        const spec = f ? f.spec : [0, 0, -U.G];
        // the head lags the airframe: sinks under G, slides outward in a skid, nods under braking
        this.head[0] = M.lowpass(this.head[0], clamp(-spec[0] * 0.004, -0.03, 0.03), dt, 0.25);
        this.head[1] = M.lowpass(this.head[1], clamp(-spec[1] * 0.006, -0.04, 0.04), dt, 0.25);
        this.head[2] = M.lowpass(this.head[2], clamp((-spec[2] / U.G - 1) * 0.03, -0.03, 0.06), dt, 0.2);
        const Rl = mulMM(rotZ(this.look.yaw), rotY(this.look.pitch - 4 * U.DEG + this.shake[0] + this.head[2] * 0.25));
        C2W = mulMM(R, mulMM(Rl, rotX(this.shake[1])));
        // looking over your shoulder moves the head toward the window
        const lean = Math.sin(this.look.yaw) * 0.1;
        const eye = mulMV(R, [ac.d.eye[0] + this.head[0], ac.d.eye[1] + this.head[1] + lean, ac.d.eye[2] + this.head[2]]);
        camPos = [s.pos[0] + eye[0], s.pos[1] + eye[1], s.pos[2] + eye[2]];
        this.hfov = view.fov || 74;
        near = 0.06;
      } else {
        if (view.mode === 'tower') {
          camPos = [520, 150, -14];
          const dist = v3.len(v3.sub(s.pos, camPos));
          this.hfov = clamp(2 * Math.atan(26 / dist) * U.RAD, 4, 70);
        } else if (view.mode === 'flyby') {
          const fb = this.flyby;
          fb.t -= dt;
          const dist = fb.pos ? v3.len(v3.sub(s.pos, fb.pos)) : 1e9;
          if (!fb.pos || view.snap || fb.t < 0 || dist > 900) {
            // park the camera ahead of the airplane, off to one side, near eye level (or on the ground when low)
            const lead = Math.max(60, v3.len(s.vel) * 4.5);
            const vel = v3.len(s.vel) > 5 ? v3.norm(s.vel) : [R[0], R[3], R[6]];
            const side = [-vel[1], vel[0], 0];
            const sgn = this.rand() < 0.5 ? -1 : 1;
            fb.pos = [s.pos[0] + vel[0] * lead + side[0] * 34 * sgn, s.pos[1] + vel[1] * lead + side[1] * 34 * sgn, Math.min(-1.7, s.pos[2] + vel[2] * lead - 9)];
            fb.t = 11;
          }
          camPos = fb.pos;
          const d2 = v3.len(v3.sub(s.pos, camPos));
          this.hfov = clamp(2 * Math.atan(30 / d2) * U.RAD, 16, 62);
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
          if (camPos[2] > -0.6) camPos[2] = -0.6;
          this.hfov = 58;
        }
        const fwd = v3.norm(v3.sub(s.pos, camPos));
        let right = v3.cross([0, 0, 1], fwd);
        if (v3.len(right) < 1e-3) right = [0, 1, 0];
        right = v3.norm(right);
        const down = v3.cross(fwd, right);
        C2W = [fwd[0], right[0], down[0], fwd[1], right[1], down[1], fwd[2], right[2], down[2]];
      }
      this.cam = camPos;
      const cam = this.camera;
      const fw = P([C2W[0], C2W[3], C2W[6]]), rt = P([C2W[1], C2W[4], C2W[7]]), dn = P([C2W[2], C2W[5], C2W[8]]);
      cam.matrix.makeBasis(rt, dn.negate(), fw.negate());
      cam.matrix.setPosition(P(camPos));
      cam.matrixWorldNeedsUpdate = true;
      cam.aspect = this.Wc / this.Hc;
      // the sim thinks in horizontal field of view; narrow windows keep a sensible vertical one
      const vf = 2 * Math.atan(Math.tan((this.hfov * U.DEG) / 2) / cam.aspect) * U.RAD;
      cam.fov = clamp(vf, 3, 75);
      cam.near = near;
      cam.far = 120000;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
    }

    /** Height of the terrain (m above field elevation) under a north/east position. */
    terrainHeight(n, e) {
      return this.ok ? this.scenery.heightAt(n, e) : 0;
    }

    /** World NED point -> overlay pixel, or null when behind the camera. */
    project(p) {
      const v = P(p).project(this.camera);
      if (v.z > 1 || v.z < -1) return null;
      return [(v.x * 0.5 + 0.5) * this.W, (-v.y * 0.5 + 0.5) * this.H];
    }

    // ---------------------------------------------------------------- main entry
    /** Watch the real frame time and trade resolution, then shadows, for smoothness on slower machines. */
    adapt() {
      const now = performance.now();
      if (this.lastT) {
        const ft = now - this.lastT;
        if (ft < 250) this.ftAvg = this.ftAvg === undefined ? ft : this.ftAvg + (ft - this.ftAvg) * 0.03;
        this.ftN = (this.ftN || 0) + 1;
        if (this.ftN > 150) {
          if (this.ftAvg > 30 && this.quality > 0.55) {
            this.quality = Math.max(0.5, this.quality - 0.2);
            this.resize();
            this.ftN = 0;
          } else if (this.ftAvg > 30 && this.gl.shadowMap.enabled) {
            this.gl.shadowMap.enabled = false;
            this.scenery.sun.castShadow = false;
            this.ftN = 0;
          } else if (this.ftAvg < 14 && this.quality < 1) {
            this.quality = Math.min(1, this.quality + 0.1);
            this.resize();
            this.ftN = -300;
          }
        }
      }
      this.lastT = now;
    }

    render(ac, view, dt) {
      if (!this.ok) return;
      if (!document.hidden) this.adapt();
      if (!this.plane) {
        this.plane = FS.buildAirplane(ac.d);
        this.plane.matrixAutoUpdate = false;
        this.scene.add(this.plane);
      }
      const cfg = ac.wx.cfg;
      const hour = cfg.timeOfDay === undefined ? 10 : cfg.timeOfDay;
      const visM = (cfg.visSm === undefined ? 30 : cfg.visSm) * 1609.34;
      if (this.scenery.setTime(hour, visM)) this.bakeEnvironment();
      this.scenery.setClouds(cfg.cloudCover === undefined ? 2 : cfg.cloudCover, cfg.cloudBaseFt === undefined ? 4500 : cfg.cloudBaseFt);
      const env = this.scenery.env;
      // the eye adapts: open up the exposure as the sun gets low, and again after dark
      this.gl.toneMappingExposure = 0.9 + 0.7 * (1 - M.smoothstep(4, 28, env.el)) + 0.2 * env.dark;

      this.setupCamera(ac, view, dt);

      // airplane pose
      const s = ac.s, R = this.R;
      const X = P([R[1], R[4], R[7]]), Y = P([-R[2], -R[5], -R[8]]), Z = P([-R[0], -R[3], -R[6]]);
      this.plane.matrix.makeBasis(X, Y, Z);
      this.plane.matrix.setPosition(P(s.pos));
      this.plane.matrixWorldNeedsUpdate = true;
      const parts = this.plane.userData.parts;
      const cockpit = view.mode === 'cockpit';
      parts.cockpit.visible = cockpit;
      parts.tufts.mesh.visible = !cockpit ? !!view.showForces : !!view.showAids;
      env.cockpit = cockpit;
      FS.animateAirplane(this.plane, ac, view.paused ? 0 : dt * (view.timeScale || 1), env);

      this.scenery.aimSun(P(s.pos));
      this.scenery.update(dt, this.camera, this.cam, ac.wx);
      this.updateSmoke(ac, dt, view);
      this.updateArrows(ac, view);

      this.gl.render(this.scene, this.camera);

      // ---- overlay
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.W, this.H);
      if (view.mode === 'chase' && view.showForces) this.drawForceLabels(ac);
      if (cockpit && view.showAids && Math.abs(this.look.yaw) < 0.2) this.drawHudAids(ac);
    }

    /** Re-bake sky reflections (paint, glass, water) when the time of day changes. */
    bakeEnvironment() {
      const sc = new THREE.Scene();
      const sky = new THREE.Mesh(this.scenery.sky.geometry, this.scenery.skyMat);
      sc.add(sky);
      const old = this.envRT;
      this.envRT = this.pmrem.fromScene(sc, 0.02, 1, 3000);
      this.scene.environment = this.envRT.texture;
      if (old) old.dispose();
    }

    // ---------------------------------------------------------------- touchdown smoke
    buildSmoke() {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(32, 32, 2, 32, 32, 32);
      g.addColorStop(0, 'rgba(235,235,240,0.9)');
      g.addColorStop(0.5, 'rgba(225,225,232,0.35)');
      g.addColorStop(1, 'rgba(220,220,230,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
      const tex = new THREE.CanvasTexture(cv);
      this.smoke = [];
      for (let i = 0; i < 28; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
        sp.visible = false;
        this.scene.add(sp);
        this.smoke.push({ sp, life: 0, vel: new THREE.Vector3() });
      }
      this.smokeI = 0;
      this.wasTouch = {};
    }
    updateSmoke(ac, dt, view) {
      const parts = this.plane.userData.parts;
      const gsp = Math.hypot(ac.s.vel[0], ac.s.vel[1]);
      if (!view.paused) {
        for (const g of parts.gear) {
          const was = this.wasTouch[g.id];
          if (g.touch && was === false && gsp > 12) {
            // the tyre goes from 0 to ~50 kt in an instant: it scrubs, and that is the puff you see
            const gr = ac.d.gear.find((x) => x.id === g.id);
            const wp = v3.add(ac.s.pos, mulMV(this.R, gr.pos));
            for (let k = 0; k < 5; k++) {
              const p = this.smoke[this.smokeI++ % this.smoke.length];
              p.life = 1;
              p.sp.position.copy(P([wp[0], wp[1], -0.15]));
              p.vel.set(ac.s.vel[1] * 0.12 + (this.rand() - 0.5) * 1.5, 0.5 + this.rand() * 0.9, -ac.s.vel[0] * 0.12 + (this.rand() - 0.5) * 1.5);
              p.size = 0.5 + this.rand() * 0.5;
              p.sp.visible = true;
            }
          }
          this.wasTouch[g.id] = !!g.touch;
        }
      }
      for (const p of this.smoke) {
        if (p.life <= 0) continue;
        p.life -= dt / 1.6;
        p.sp.position.addScaledVector(p.vel, dt);
        p.vel.multiplyScalar(Math.exp(-dt * 1.5));
        const age = 1 - p.life;
        p.sp.scale.setScalar(p.size + age * 4.5);
        p.sp.material.opacity = Math.max(0, p.life) * 0.55;
        if (p.life <= 0) p.sp.visible = false;
      }
    }

    // ---------------------------------------------------------------- teaching overlays
    buildArrows() {
      const mk = (color) => {
        const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95, fog: false, toneMapped: false });
        const g = new THREE.Group();
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 10).translate(0, 0.5, 0), mat);
        const head = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 14).translate(0, 0.3, 0), mat);
        shaft.renderOrder = head.renderOrder = 900;
        g.add(shaft, head);
        g.userData = { shaft, head };
        g.visible = false;
        this.scene.add(g);
        return g;
      };
      this.arrows = { weight: mk(0xff5a4e), lift: mk(0x4fa3ff), thrust: mk(0x3ee08f), drag: mk(0xffb03b), wind: mk(0xffffff) };
      this.arrows.wind.userData.shaft.material = this.arrows.wind.userData.head.material = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.7, fog: false, toneMapped: false });
      this.labels = [];
    }
    setArrow(a, from, dirNED, len, label, labelAtStart) {
      if (!(len > 0.05)) {
        a.visible = false;
        return;
      }
      a.visible = true;
      const d = P(dirNED).normalize();
      a.position.copy(P(from));
      a.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      const hl = Math.min(0.6, len * 0.4);
      a.userData.shaft.scale.set(1, Math.max(0.01, len - hl), 1);
      a.userData.head.position.y = len - hl;
      a.userData.head.scale.set(hl / 0.6, hl / 0.6, hl / 0.6);
      const tip = [from[0] + dirNED[0] * (len + 0.5), from[1] + dirNED[1] * (len + 0.5), from[2] + dirNED[2] * (len + 0.5)];
      this.labels.push({ at: labelAtStart ? from : tip, text: label, color: '#' + a.userData.shaft.material.color.getHexString(), start: labelAtStart });
    }
    updateArrows(ac, view) {
      this.labels.length = 0;
      const A = this.arrows;
      const f = ac.out;
      const show = view.mode === 'chase' && view.showForces && f;
      if (!show) {
        for (const k in A) A[k].visible = false;
        return;
      }
      const R = this.R;
      const cg = ac.s.pos;
      const W = ac.mass * U.G;
      const scale = 6; // metres of arrow for one airplane-weight
      const td = 5; // thrust & drag are ~1/10 of weight: magnify so they're visible
      const lb = (n) => `${Math.round(n / U.LBF).toLocaleString()} lb`;
      this.setArrow(A.weight, cg, [0, 0, 1], scale, `Weight ${lb(W)}`);
      this.setArrow(A.lift, cg, mulMV(R, f.liftDirB), (scale * f.lift) / W, `Lift ${lb(f.lift)}`);
      this.setArrow(A.thrust, cg, mulMV(R, [1, 0, 0]), (scale * td * Math.max(0, f.thrust)) / W, `Thrust ${lb(f.thrust)} (×${td})`);
      this.setArrow(A.drag, cg, mulMV(R, f.dragDirB), (scale * td * f.drag) / W, `Drag ${lb(f.drag)} (×${td})`);
      if (f.V > 3) {
        const rw = mulMV(R, [-f.vb[0] / f.V, -f.vb[1] / f.V, -f.vb[2] / f.V]);
        this.setArrow(A.wind, [cg[0] - rw[0] * 9, cg[1] - rw[1] * 9, cg[2] - rw[2] * 9], rw, 4, 'relative wind', true);
      } else A.wind.visible = false;
    }
    drawForceLabels() {
      const ctx = this.ctx, dpr = this.dpr;
      ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      for (const l of this.labels) {
        const p = this.project(l.at);
        if (!p) continue;
        const w = ctx.measureText(l.text).width;
        const x = l.start ? p[0] - w - 10 * dpr : p[0] + 6 * dpr, y = p[1];
        ctx.fillStyle = 'rgba(10,14,20,0.62)';
        ctx.beginPath();
        ctx.roundRect(x - 5 * dpr, y - 9 * dpr, w + 10 * dpr, 18 * dpr, 5 * dpr);
        ctx.fill();
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, x, y);
      }
    }

    drawHudAids(ac) {
      const ctx = this.ctx;
      const s = ac.s, R = this.R, dpr = this.dpr;
      const far = (d) => this.project([this.cam[0] + d[0], this.cam[1] + d[1], this.cam[2] + d[2]]);
      ctx.lineWidth = 2 * dpr;
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 3 * dpr;
      // boresight: where the nose points
      const p = far(mulMV(R, [1000, 0, 0]));
      if (p) {
        ctx.strokeStyle = 'rgba(255,230,90,0.95)';
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
      // flight-path vector: where the airplane is actually going
      const vl = v3.len(s.vel);
      if (vl > 8) {
        const k = 1000 / vl;
        const q = far([s.vel[0] * k, s.vel[1] * k, s.vel[2] * k]);
        if (q) {
          ctx.strokeStyle = 'rgba(90,255,140,0.98)';
          ctx.beginPath();
          ctx.arc(q[0], q[1], 7 * dpr, 0, Math.PI * 2);
          ctx.moveTo(q[0] - 7 * dpr, q[1]);
          ctx.lineTo(q[0] - 18 * dpr, q[1]);
          ctx.moveTo(q[0] + 7 * dpr, q[1]);
          ctx.lineTo(q[0] + 18 * dpr, q[1]);
          ctx.moveTo(q[0], q[1] - 7 * dpr);
          ctx.lineTo(q[0], q[1] - 14 * dpr);
          ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
    }
  }

  FS.Renderer = Renderer;
})();
