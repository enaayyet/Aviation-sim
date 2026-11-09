/*
 * app.js — wires the simulator together: main loop, lessons, menus, settings, debriefs.
 */
(function () {
  'use strict';
  const FS = globalThis.FS;
  const { U, M } = FS;
  const $ = (id) => document.getElementById(id);
  const FT = 3.28084;

  const STORE = 'patternwork.v1';
  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE)) || {};
    } catch (e) {
      return {};
    }
  }
  function save(data) {
    try {
      localStorage.setItem(STORE, JSON.stringify(data));
    } catch (e) {
      /* storage unavailable: progress just isn't remembered */
    }
  }

  const TURB = [
    ['None', 0],
    ['Light', 0.3],
    ['Moderate', 0.6],
    ['Severe', 0.95],
  ];
  const VIEWS = ['cockpit', 'chase', 'tower'];
  const VIEW_NAMES = { cockpit: 'Cockpit', chase: 'Chase', tower: 'Tower' };
  const LOOK = { Digit1: [-90, -8], Digit2: [-45, -4], Digit3: [0, 0], Digit4: [45, -4], Digit5: [90, -8], Digit6: [-130, -15], Digit7: [130, -15] };

  class App {
    constructor() {
      const stored = load();
      this.store = stored;
      this.settings = Object.assign(
        {
          weather: Object.assign({}, FS.lessonHelpers.FIELD),
          loading: Object.assign({}, FS.lessonHelpers.LOAD_NORMAL),
          input: {},
          sound: true,
          aids: false,
        },
        stored.settings || {}
      );
      this.progress = stored.progress || {};

      this.wx = new FS.Weather(this.settings.weather);
      this.world = new FS.World();
      this.ac = new FS.Aircraft(FS.PA28, this.wx);
      this.renderer = new FS.Renderer($('view3d'), this.world);
      this.panel = new FS.Panel($('panel'), this.ac);
      this.panel.onSetAltimeter = () => {
        this.panel.setKollsman(this.wx.cfg.qnhInHg);
        this.toast(`Altimeter set to ${this.wx.cfg.qnhInHg.toFixed(2)} inHg`);
      };
      this.forces = new FS.ForcesDiagram($('forces'));
      this.map = new FS.MovingMap($('map'), this.world);
      this.input = new FS.Input($('view3d'));
      Object.assign(this.input.settings, this.settings.input);
      this.input.onAction = (code, e) => this.action(code, e);
      this.sound = new FS.Sound();
      this.sound.setMuted(!this.settings.sound);

      this.view = { mode: 'cockpit', lookYaw: 0, lookPitch: 0, orbitYaw: 35, orbitPitch: 14, orbitDist: 24, showForces: true, showAids: this.settings.aids, fov: 74 };
      this.ctl = FS.neutralControls();
      this.paused = true;
      this.timeScale = 1;
      this.runner = null;
      this.lesson = null;
      this.recorder = [];
      this.recT = 0;
      this.uiT = 0;
      this.last = performance.now();

      this.bindUI();
      this.buildMenu();
      this.onResize();
      window.addEventListener('resize', () => this.onResize());
      // a quiet scene behind the menu
      this.startLesson(FS.LESSONS.find((l) => l.id === 'free-air'), true);
      this.paused = true;
      this.openMenu();
      requestAnimationFrame((ts) => this.loop(ts));
    }

    // ================================================================= main loop
    loop(ts) {
      let dt = (ts - this.last) / 1000;
      this.last = ts;
      if (!(dt > 0)) dt = 0.016;
      dt = Math.min(dt, 0.05);
      const sdt = dt * this.timeScale;
      const ac = this.ac;

      if (!this.paused && !ac.crashed) {
        this.input.update(dt, this.ctl);
        this.ctl.flaps = this.ctl.flaps || 0;
        const pre = ac.telemetry();
        this.wx.update(sdt, pre.tas * U.KT, pre.agl / FT);
        ac.step(sdt, this.ctl);
      }
      const t = ac.telemetry();
      const events = ac.events;
      ac.events = [];
      this.handleEvents(events, t);
      if (this.runner && !this.paused) this.runner.update(t, sdt, events);
      if (!this.paused) this.record(t, sdt);

      this.view.tele = t;
      this.renderer.render(ac, this.view, dt);
      const targets = this.runner && !this.runner.done ? this.runner.targets() : null;
      this.panel.draw(t, targets);
      this.drawControls(t);
      this.forces.draw(ac);
      this.map.draw(ac, t, this.paused ? 0 : sdt, this.wx);
      this.sound.update(t, this.paused);
      this.uiT += dt;
      if (this.uiT > 0.1) {
        this.uiT = 0;
        this.updateHUD(t);
        this.updateLessonPanel();
      }
      requestAnimationFrame((x) => this.loop(x));
    }

    record(t, dt) {
      this.recT += dt;
      if (this.recT < 0.25) return;
      this.recT = 0;
      this.recorder.push({ t: t.time, alt: t.altInd, ias: t.ias, bank: t.bank, vs: t.vs, step: this.runner ? this.runner.i : 0 });
      if (this.recorder.length > 4000) this.recorder.shift();
    }

    handleEvents(events, t) {
      for (const ev of events) {
        if (ev.type === 'touchdown') {
          const td = ev.data;
          this.sound.chirp(Math.min(0.5, 0.08 + td.vsFpm / 1500));
          const q = td.vsFpm < 300 ? 'good' : td.vsFpm < 600 ? 'warn' : 'bad';
          const where = `${Math.round(td.n * FT)} ft past the threshold, ${Math.abs(td.e * FT).toFixed(0)} ft ${td.e > 0 ? 'right' : 'left'} of centreline`;
          this.toast(`Touchdown: ${Math.round(td.vsFpm)} fpm, ${td.firstGear} first — ${where}`, q, 5000);
        }
        if (ev.type === 'contact' && this.ac.touchdown == null) this.sound.chirp(0.1);
        if (ev.type === 'crash') {
          this.showBanner(`CRASH`, `${ev.reason}<br>Press <kbd>R</kbd> to try again.`);
        }
      }
      // automatic warnings
      const w = t.warnings;
      this.warnState = this.warnState || {};
      const warn = (key, on, msg) => {
        if (on && !this.warnState[key]) this.toast(msg, 'bad', 3500);
        this.warnState[key] = on;
      };
      warn('flap', w.flapSpeed, 'Flaps extended above 103 kt (Vfe)! Risk of flap damage.');
      warn('vne', w.overspeed, 'Above Vne (160 kt)! Reduce power, gently raise the nose.');
      warn('g', w.overG, 'Load factor limit exceeded (+3.8 G).');
      warn('rpm', w.rpm, 'Engine over-speed: reduce throttle (redline 2,700 RPM).');
    }

    // ================================================================= lessons
    startLesson(lesson, silent) {
      this.lesson = lesson;
      const S = lesson.setup;
      const wxCfg = S.useSettings ? this.settings.weather : Object.assign(FS.Weather.defaults(), S.weather || {});
      this.wx.turb = [0, 0, 0];
      this.wx.turbP = 0;
      this.wx.gustFactor = 0;
      this.wx.set(Object.assign({}, wxCfg));
      const loading = S.useSettings ? this.settings.loading : S.loading || FS.lessonHelpers.LOAD_NORMAL;
      this.ac.setLoading(loading);
      let ctl;
      if (S.ground) ctl = this.ac.placeOnGround(S.ground.n, S.ground.e, S.ground.hdg, { flaps: S.ground.flaps || 0 });
      else ctl = this.ac.placeInAir(S.air);
      this.ctl = Object.assign(FS.neutralControls(), ctl);
      this.input.resetYoke();
      this.panel.setKollsman(this.wx.cfg.qnhInHg);
      this.panel.hdgBug = S.air ? S.air.hdg : S.ground.hdg;
      this.view.mode = lesson.view || 'cockpit';
      this.view.lookYaw = 0;
      this.view.lookPitch = 0;
      this.view.snap = true;
      if (lesson.aids) this.view.showAids = true;
      this.renderer.chase.offset = null;
      this.map.options = S.map || {};
      this.map.clearTrail();
      this.recorder = [];
      this.warnState = {};
      this.hideBanner();
      this.runner = new FS.LessonRunner(lesson, this.ac, this.world, this);
      this.runner.onFinish = (d) => this.onLessonFinished(d);
      this.runner.onStep = () => this.renderStepList();
      this.runner.start(this.ac.telemetry());
      $('lesson-title').textContent = lesson.title;
      $('lesson-name').textContent = `${lesson.group} · ${lesson.title}`;
      this.renderStepList();
      this.updateButtons();
      if (!silent) {
        this.paused = false;
        this.sound.init();
        this.toast(lesson.free ? 'Free flight — Esc for the menu' : 'Lesson started — follow the instructor panel on the right', 'good');
      }
      setTimeout(() => (this.view.snap = false), 50);
    }

    /** Used by the Weight & Balance lesson: same position, new load, re-trimmed. */
    reloadInAir(loading) {
      const t = this.ac.telemetry();
      this.ac.setLoading(loading);
      const ctl = this.ac.placeInAir({ n: t.n, e: t.e, altFt: t.altMSL, hdg: t.hdg, ias: 100 });
      Object.assign(this.ctl, ctl, { elevator: 0, aileron: 0, rudder: 0 });
      this.toast(`New load: ${Math.round(this.ac.wb.weightLb)} lb, CG ${this.ac.cgIn.toFixed(1)} in`, 'good');
    }

    restart() {
      if (this.lesson) this.startLesson(this.lesson);
    }

    onLessonFinished(d) {
      if (this.lesson.free) return;
      const prev = this.progress[this.lesson.id];
      const rank = { pass: 3, marginal: 2, fail: 1 };
      if (d.completed || d.overall === 'fail') {
        if (!prev || rank[d.overall] > rank[prev.best]) this.progress[this.lesson.id] = { best: d.overall, at: Date.now() };
        this.persist();
      }
      setTimeout(() => this.showDebrief(d), this.ac.crashed ? 1800 : 600);
    }

    showDebrief(d) {
      this.paused = true;
      $('deb-title').textContent = d.lesson.title;
      const badge = $('deb-badge');
      const label = { pass: 'Satisfactory', marginal: 'Needs polish', fail: 'Unsatisfactory', info: 'Complete' }[d.overall];
      badge.textContent = label;
      badge.className = `badge ${d.overall}`;
      $('deb-reason').textContent = d.failReason || '';
      const box = $('deb-items');
      box.innerHTML = '';
      const icon = { pass: '✓', marginal: '~', fail: '✗', info: 'i' };
      if (!d.items.length) box.innerHTML = '<div class="note">Nothing was graded in this lesson — it\'s about seeing and feeling.</div>';
      for (const it of d.items) {
        const el = document.createElement('div');
        el.className = 'deb-item';
        el.innerHTML = `<span class="ic ${it.status}">${icon[it.status] || '•'}</span><span>${it.label}</span><span class="v">${it.value}</span><span class="n"></span>`;
        el.querySelector('.n').textContent = it.note || '';
        box.appendChild(el);
      }
      const idx = FS.LESSONS.indexOf(d.lesson);
      const next = FS.LESSONS[idx + 1];
      $('deb-next').classList.toggle('hidden', !next || !!next.free);
      $('debrief').classList.remove('hidden');
      this.drawDebriefChart();
    }

    drawDebriefChart() {
      const cv = $('deb-chart');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = cv.getBoundingClientRect();
      cv.width = r.width * dpr;
      cv.height = r.height * dpr;
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = r.width, H = r.height;
      const data = this.recorder;
      ctx.clearRect(0, 0, W, H);
      if (data.length < 4) return;
      const t0 = data[0].t, t1 = data[data.length - 1].t;
      const series = [
        { key: 'alt', color: '#5fb4ff', label: 'Altitude (ft)' },
        { key: 'ias', color: '#ffb547', label: 'Airspeed (kt)' },
        { key: 'bank', color: '#3ecf7a', label: 'Bank (°)' },
      ];
      const padL = 8, padR = 8, padT = 22, padB = 18;
      // step boundaries
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      for (let i = 1; i < data.length; i++) {
        if (data[i].step !== data[i - 1].step) {
          const x = padL + ((data[i].t - t0) / (t1 - t0 || 1)) * (W - padL - padR);
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, H - padB);
          ctx.stroke();
        }
      }
      series.forEach((s, si) => {
        let lo = Infinity, hi = -Infinity;
        for (const d of data) {
          lo = Math.min(lo, d[s.key]);
          hi = Math.max(hi, d[s.key]);
        }
        if (hi - lo < 1) {
          hi += 1;
          lo -= 1;
        }
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        data.forEach((d, i) => {
          const x = padL + ((d.t - t0) / (t1 - t0 || 1)) * (W - padL - padR);
          const y = padT + (1 - (d[s.key] - lo) / (hi - lo)) * (H - padT - padB);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.stroke();
        ctx.fillStyle = s.color;
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillText(`${s.label} ${Math.round(lo)}–${Math.round(hi)}`, padL + si * 170, 14);
      });
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${Math.round(t1 - t0)} s of flight · lines mark step changes`, padL, H - 4);
    }

    // ================================================================= input actions
    action(code, e) {
      const shift = e && e.shiftKey;
      switch (code) {
        case 'KeyF':
          return this.setFlaps(+1), true;
        case 'KeyV':
          return this.setFlaps(-1), true;
        case 'KeyB':
          this.ctl.parkingBrake = !this.ctl.parkingBrake;
          this.toast(this.ctl.parkingBrake ? 'Parking brake SET' : 'Parking brake released');
          return true;
        case 'KeyC':
          this.cycleView();
          return true;
        case 'KeyH':
          this.toggleAids();
          return true;
        case 'KeyP':
          this.togglePause();
          return true;
        case 'Escape':
          if (!$('menu').classList.contains('hidden')) this.closeMenu();
          else if (!$('briefing').classList.contains('hidden')) this.openMenu();
          else if (!$('debrief').classList.contains('hidden')) this.openMenu();
          else this.openMenu();
          return true;
        case 'KeyR':
          if (this.anyOverlay()) return false;
          this.restart();
          return true;
        case 'KeyM':
          this.toggleSound();
          return true;
        case 'KeyT':
          this.cycleSpeed();
          return true;
        case 'KeyY':
          this.toggleYoke();
          return true;
        case 'KeyN':
        case 'Enter':
          if (this.runner && this.runner.step && this.runner.step.manual) this.runner.ack();
          return true;
        case 'KeyK':
          this.panel.onSetAltimeter();
          return true;
        case 'Slash':
          this.openMenu('controls');
          return true;
        default:
          if (LOOK[code]) {
            this.view.lookYaw = LOOK[code][0];
            this.view.lookPitch = LOOK[code][1];
            if (this.view.mode !== 'cockpit') this.setView('cockpit');
            return true;
          }
      }
      void shift;
      return false;
    }

    setFlaps(dir) {
      const notches = [0, 10, 25, 40];
      let i = notches.indexOf(this.ctl.flaps);
      if (i < 0) i = 0;
      i = M.clamp(i + dir, 0, 3);
      this.ctl.flaps = notches[i];
      this.toast(`Flaps ${notches[i]}°`);
    }

    cycleView() {
      this.setView(VIEWS[(VIEWS.indexOf(this.view.mode) + 1) % VIEWS.length]);
    }
    setView(m) {
      this.view.mode = m;
      this.view.snap = true;
      setTimeout(() => (this.view.snap = false), 30);
      this.updateButtons();
    }
    toggleAids() {
      this.view.showAids = !this.view.showAids;
      this.settings.aids = this.view.showAids;
      this.persist();
      this.updateButtons();
    }
    togglePause() {
      if (this.anyOverlay()) return;
      this.paused = !this.paused;
      if (this.paused) this.showBanner('PAUSED', 'Press <kbd>P</kbd> to continue', 'info');
      else this.hideBanner();
      this.updateButtons();
    }
    toggleSound() {
      this.settings.sound = !this.settings.sound;
      this.sound.init();
      this.sound.setMuted(!this.settings.sound);
      this.persist();
      this.updateButtons();
    }
    cycleSpeed() {
      const speeds = [1, 0.5, 0.25, 2];
      this.timeScale = speeds[(speeds.indexOf(this.timeScale) + 1) % speeds.length];
      this.toast(`Simulation speed ${this.timeScale}×`);
      this.updateButtons();
    }
    toggleYoke() {
      const on = this.input.toggleMouseYoke();
      $('view3d').classList.toggle('yoke', on);
      this.toast(on ? 'Mouse yoke ON: mouse position = yoke. Wheel = trim, Shift+wheel = throttle. Click or Y to release.' : 'Mouse yoke off — keyboard flying');
      this.updateButtons();
    }

    anyOverlay() {
      return ['menu', 'briefing', 'debrief'].some((id) => !$(id).classList.contains('hidden'));
    }

    // ================================================================= UI wiring
    bindUI() {
      $('btn-menu').onclick = () => this.openMenu();
      $('btn-view').onclick = () => this.cycleView();
      $('btn-aids').onclick = () => this.toggleAids();
      $('btn-yoke').onclick = () => this.toggleYoke();
      $('btn-slow').onclick = () => this.cycleSpeed();
      $('btn-pause').onclick = () => this.togglePause();
      $('btn-restart').onclick = () => this.restart();
      $('btn-sound').onclick = () => this.toggleSound();
      $('btn-help').onclick = () => this.openMenu('controls');
      $('btn-side').onclick = () => {
        $('app').classList.toggle('no-side');
        setTimeout(() => this.onResize(), 30);
      };
      $('btn-ack').onclick = () => this.runner && this.runner.ack();
      $('btn-skip').onclick = () => this.runner && !this.runner.done && this.runner.skip();
      $('btn-end').onclick = () => this.runner && !this.runner.done && this.runner.finish('Lesson ended early by the pilot.');
      $('menu-close').onclick = () => this.closeMenu();
      $('brief-close').onclick = () => this.openMenu();
      $('brief-back').onclick = () => this.openMenu();
      $('brief-fly').onclick = () => {
        $('briefing').classList.add('hidden');
        this.startLesson(this.pending);
      };
      $('deb-menu').onclick = () => this.openMenu();
      $('deb-retry').onclick = () => {
        $('debrief').classList.add('hidden');
        this.startLesson(this.lesson);
      };
      $('deb-free').onclick = () => {
        $('debrief').classList.add('hidden');
        this.runner = null;
        this.paused = false;
        $('step-text').innerHTML = 'Free flight — no instructor. <kbd>Esc</kbd> for the menu.';
        $('step-list').innerHTML = '';
        $('meters').innerHTML = '';
      };
      $('deb-next').onclick = () => {
        const idx = FS.LESSONS.indexOf(this.lesson);
        $('debrief').classList.add('hidden');
        this.showBriefing(FS.LESSONS[idx + 1]);
      };
      document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => this.showTab(b.dataset.tab)));

      // mouse in the 3D view: click toggles mouse-yoke, drag orbits chase/tower camera, wheel zooms chase
      const v = $('view3d');
      let drag = null;
      v.addEventListener('mousedown', (e) => {
        drag = { x: e.clientX, y: e.clientY, moved: false, yaw: this.view.orbitYaw, pitch: this.view.orbitPitch };
      });
      window.addEventListener('mousemove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.hypot(dx, dy) > 4) drag.moved = true;
        if (drag.moved && this.view.mode === 'chase' && !this.input.mouseYoke) {
          this.view.orbitYaw = drag.yaw - dx * 0.4;
          this.view.orbitPitch = M.clamp(drag.pitch + dy * 0.3, -10, 80);
        }
      });
      window.addEventListener('mouseup', () => {
        if (drag && !drag.moved && !this.anyOverlay()) {
          this.sound.init();
          this.toggleYoke();
        }
        drag = null;
      });
      v.addEventListener(
        'wheel',
        (e) => {
          if (this.input.mouseYoke || this.view.mode !== 'chase') return;
          e.preventDefault();
          this.view.orbitDist = M.clamp(this.view.orbitDist * (e.deltaY > 0 ? 1.1 : 0.9), 7, 80);
        },
        { passive: false }
      );
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && !this.paused && !this.anyOverlay()) this.togglePause();
      });
    }

    updateButtons() {
      $('btn-view').textContent = `View: ${VIEW_NAMES[this.view.mode]}`;
      $('btn-aids').classList.toggle('on', this.view.showAids);
      $('btn-yoke').classList.toggle('on', this.input.mouseYoke);
      $('btn-slow').textContent = `${this.timeScale}×`;
      $('btn-slow').classList.toggle('on', this.timeScale !== 1);
      $('btn-pause').textContent = this.paused && !this.anyOverlay() ? 'Resume' : 'Pause';
      $('btn-sound').classList.toggle('on', this.settings.sound);
      $('btn-sound').textContent = this.settings.sound ? 'Sound on' : 'Sound off';
      $('hud').classList.toggle('hidden', !this.view.showAids);
      const hints = {
        cockpit: 'Look: <kbd>1</kbd>–<kbd>5</kbd> (3 = ahead)',
        chase: 'Drag to orbit · wheel to zoom · force vectors shown',
        tower: 'Tower camera tracks you',
      };
      $('viewhint').innerHTML = (this.input.mouseYoke ? '<b style="color:#ffb547">MOUSE YOKE</b> · ' : '') + hints[this.view.mode];
    }

    onResize() {
      this.renderer.resize();
      this.panel.resize();
      this.forces.resize();
      this.map.resize();
    }

    toast(msg, kind = '', ms = 2600) {
      const el = document.createElement('div');
      el.className = `toast ${kind}`;
      el.textContent = msg;
      const box = $('toasts');
      box.appendChild(el);
      while (box.children.length > 4) box.removeChild(box.firstChild);
      setTimeout(() => el.remove(), ms);
    }

    showBanner(title, sub, kind) {
      const b = $('banner');
      b.className = kind || '';
      b.innerHTML = `${title}${sub ? `<small>${sub}</small>` : ''}`;
    }
    hideBanner() {
      $('banner').className = 'hidden';
    }

    // ================================================================= HUD, side panel
    updateHUD(t) {
      if (this.view.showAids) {
        $('h-ias').textContent = Math.round(t.ias);
        $('h-alt').textContent = Math.round(t.altInd).toLocaleString();
        $('h-vs').textContent = (t.vs >= 0 ? '+' : '') + Math.round(t.vs / 10) * 10;
        $('h-hdg').textContent = String(Math.round(t.hdg) % 360).padStart(3, '0');
        $('h-aoa').textContent = t.alpha.toFixed(1);
        $('h-gs').textContent = Math.round(t.gs);
        $('h-agl').textContent = Math.round(t.agl);
      }
      const lb = (n) => `${Math.round(n).toLocaleString()} lb`;
      $('f-lift').textContent = lb(t.lift);
      $('f-weight').textContent = lb(t.weight);
      $('f-thrust').textContent = lb(t.thrust);
      $('f-drag').textContent = lb(t.drag);
      $('f-ld').textContent = t.ld ? t.ld.toFixed(1) : '—';
      $('f-g').textContent = `${t.g.toFixed(2)} G`;
      $('f-cl').textContent = t.CL.toFixed(2);
      $('f-aoa').textContent = `${t.alpha.toFixed(1)}° / ${t.alphaStall.toFixed(0)}°`;
      $('f-eq').textContent = `L = q·S·CL = ${t.qbarPsf.toFixed(1)} psf × 170 ft² × ${t.CL.toFixed(2)}`;
      const ps = t.excessPowerFpm;
      $('f-ps').textContent = `(T−D)·V/W → ${ps >= 0 ? 'surplus' : 'deficit'} worth ${Math.abs(Math.round(ps / 10) * 10)} fpm`;
      const d = this.wx.describe();
      $('wx-line').textContent = `· wind ${d.wind} · ${Math.round(t.oat)}°C · DA ${Math.round(t.densityAltFt).toLocaleString()} ft`;
      if (this.ac.crashed && $('banner').classList.contains('hidden')) this.showBanner('CRASH', `${this.ac.crashed}<br>Press <kbd>R</kbd> to try again.`);
    }

    renderStepList() {
      const r = this.runner;
      const ol = $('step-list');
      ol.innerHTML = '';
      if (!r) return;
      r.lesson.steps.forEach((s, i) => {
        const li = document.createElement('li');
        const div = document.createElement('div');
        div.innerHTML = r.text(s);
        li.textContent = (div.textContent || '').split(/[.:!]/)[0].slice(0, 70);
        li.className = i < r.i ? 'done' : i === r.i ? 'current' : '';
        ol.appendChild(li);
      });
      $('step-text').innerHTML = r.done ? 'Lesson complete.' : r.text();
      const st = r.step;
      $('step-tip').innerHTML = st && st.tip ? `💡 ${st.tip}` : '';
      $('btn-ack').classList.toggle('hidden', !(st && st.manual));
      $('btn-skip').classList.toggle('hidden', !!r.lesson.free);
      $('btn-end').classList.toggle('hidden', !!r.lesson.free);
    }

    updateLessonPanel() {
      const r = this.runner;
      const box = $('meters');
      if (!r || r.done) {
        box.innerHTML = '';
        return;
      }
      const ms = r.liveMeters();
      if (box.children.length !== ms.length) {
        box.innerHTML = '';
        for (let i = 0; i < ms.length; i++) {
          const m = document.createElement('div');
          m.className = 'meter';
          m.innerHTML = '<span class="lab"></span><span class="val"></span><div class="bar"><div class="zone"></div><div class="dot"></div></div>';
          box.appendChild(m);
        }
      }
      ms.forEach((m, i) => {
        const el = box.children[i];
        const span = Math.max(m.lo, m.hi) * 2.5 || 1;
        el.querySelector('.lab').textContent = m.label;
        const zone = el.querySelector('.zone');
        zone.style.left = `${50 - (m.lo / span) * 50}%`;
        zone.style.width = `${((m.lo + m.hi) / span) * 50}%`;
        const dot = el.querySelector('.dot');
        if (m.dev == null) {
          el.querySelector('.val').textContent = 'not graded now';
          dot.style.display = 'none';
          el.classList.remove('out');
        } else {
          dot.style.display = '';
          dot.style.left = `${M.clamp(50 + (m.dev / span) * 50, 0, 100)}%`;
          el.querySelector('.val').textContent = `${m.dev > 0 ? '+' : ''}${Math.round(m.dev)} ${m.unit}`;
          el.classList.toggle('out', !m.inTol);
        }
      });
    }

    drawControls(t) {
      const cv = $('ctlpos');
      const ctx = cv.getContext('2d');
      const W = cv.width, H = cv.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(0, 0, W, H);
      const s = 80, x0 = 10, y0 = 8;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.strokeRect(x0, y0, s, s);
      ctx.beginPath();
      ctx.moveTo(x0 + s / 2, y0);
      ctx.lineTo(x0 + s / 2, y0 + s);
      ctx.moveTo(x0, y0 + s / 2);
      ctx.lineTo(x0 + s, y0 + s / 2);
      ctx.stroke();
      // yoke: right = right aileron, down = pull back
      ctx.fillStyle = '#ffcf33';
      ctx.beginPath();
      ctx.arc(x0 + s / 2 + (t.aileron * s) / 2, y0 + s / 2 + (t.elevator * s) / 2, 5, 0, Math.PI * 2);
      ctx.fill();
      // rudder
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(x0, y0 + s + 8, s, 8);
      ctx.fillStyle = '#5fb4ff';
      ctx.fillRect(x0 + s / 2 + (t.rudder * s) / 2 - 3, y0 + s + 6, 6, 12);
      // trim
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(x0 + s + 10, y0, 8, s);
      ctx.fillStyle = '#3ecf7a';
      ctx.fillRect(x0 + s + 7, y0 + s / 2 - (t.trim * s) / 2 - 3, 14, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '600 9px system-ui';
      ctx.fillText('YOKE', x0 + 2, y0 + 10);
      ctx.fillText('TRIM', x0 + s + 2, y0 + s + 16);
      ctx.fillStyle = '#fff';
      ctx.font = '600 10px system-ui';
      ctx.fillText(`THR ${Math.round(t.throttle * 100)}%  FLAP ${Math.round(t.flaps)}°`, x0, H - 3);
    }

    // ================================================================= menu & settings
    openMenu(tab) {
      this.paused = true;
      this.hideBanner();
      $('briefing').classList.add('hidden');
      $('debrief').classList.add('hidden');
      $('menu').classList.remove('hidden');
      this.buildLessonCards();
      if (tab) this.showTab(tab);
      this.updateButtons();
    }
    closeMenu() {
      $('menu').classList.add('hidden');
      if (this.runner && !this.runner.done && !this.ac.crashed) {
        this.paused = false;
        this.sound.init();
      }
      this.updateButtons();
    }
    showTab(name) {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      document.querySelectorAll('#menu .tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${name}`));
      if (name === 'wb') this.drawWB();
      if (name === 'weather') this.updateWxReadout();
    }

    buildMenu() {
      this.buildLessonCards();
      this.buildWeather();
      this.buildWB();
      this.buildControls();
      this.buildAbout();
    }

    buildLessonCards() {
      const el = $('tab-lessons');
      el.innerHTML = '';
      const intro = document.createElement('p');
      intro.className = 'muted';
      intro.innerHTML = 'Work through the lessons in order — each builds on the last. Every lesson starts with a short ground-school briefing, then the instructor panel (right) talks you through it and grades you against the FAA Private Pilot ACS. New here? Start with <b>The Four Forces</b>, and read <b>Controls</b> first.';
      el.appendChild(intro);
      const groups = [];
      for (const l of FS.LESSONS) if (!groups.includes(l.group)) groups.push(l.group);
      for (const g of groups) {
        const h = document.createElement('div');
        h.className = 'group-title';
        h.textContent = g;
        el.appendChild(h);
        const cards = document.createElement('div');
        cards.className = 'cards';
        for (const l of FS.LESSONS.filter((x) => x.group === g)) {
          const b = document.createElement('button');
          b.className = 'card';
          const p = this.progress[l.id];
          const pill = p ? `<span class="pill ${p.best}">${{ pass: 'passed', marginal: 'close', fail: 'try again' }[p.best]}</span>` : '';
          b.innerHTML = `<span class="t"><span>${l.title}</span>${pill}</span><span class="s">${l.summary}</span>${l.minutes ? `<span class="s">~${l.minutes} min</span>` : ''}`;
          b.onclick = () => this.showBriefing(l);
          cards.appendChild(b);
        }
        el.appendChild(cards);
      }
    }

    showBriefing(lesson) {
      this.pending = lesson;
      $('menu').classList.add('hidden');
      $('debrief').classList.add('hidden');
      $('brief-group').textContent = lesson.group;
      $('brief-title').textContent = lesson.title;
      $('brief-body').innerHTML = lesson.briefing;
      const S = lesson.setup;
      const wx = new FS.Weather(S.useSettings ? this.settings.weather : Object.assign(FS.Weather.defaults(), S.weather || {}));
      const d = wx.describe();
      const tmpAc = new FS.Aircraft(FS.PA28, wx);
      tmpAc.setLoading(S.useSettings ? this.settings.loading : S.loading || FS.lessonHelpers.LOAD_NORMAL);
      const comp = wx.components(0);
      const xw = Math.abs(comp.cross) >= 1 ? ` (${Math.abs(comp.cross).toFixed(0)} kt crosswind from the ${comp.cross > 0 ? 'right' : 'left'} on runway 36)` : '';
      $('brief-conditions').innerHTML = `
        <span>Wind <b>${d.wind}</b>${xw}</span>
        <span>Temp <b>${d.tempC}°C</b></span>
        <span>Altimeter <b>${d.qnh}</b></span>
        <span>Field elev <b>${wx.cfg.fieldElevFt.toLocaleString()} ft</b></span>
        <span>Density alt <b>${d.densityAltFt.toLocaleString()} ft</b></span>
        <span>Weight <b>${Math.round(tmpAc.wb.weightLb).toLocaleString()} lb</b>, CG <b>${tmpAc.cgIn.toFixed(1)} in</b></span>
        <span>Turbulence <b>${TURB.reduce((a, x) => (wx.cfg.turbulence >= x[1] - 0.01 ? x[0] : a), 'None')}</b></span>`;
      $('briefing').classList.remove('hidden');
      this.paused = true;
    }

    // ---------------------------------------------------------------- weather tab
    buildWeather() {
      const el = $('tab-weather');
      const w = this.settings.weather;
      el.innerHTML = `
        <p class="muted">These conditions are used by the <b>Free Flight</b> lessons. Each training lesson sets its own weather (shown in its briefing).</p>
        <div class="form">
          ${this.slider('wx-dir', 'Wind direction (from)', 0, 359, 1, w.windDir, '°')}
          ${this.slider('wx-kt', 'Wind speed', 0, 30, 1, w.windKt, ' kt')}
          ${this.slider('wx-gust', 'Gusts to', 0, 40, 1, w.gustKt, ' kt')}
          <div class="field"><label>Turbulence</label><select id="wx-turb">${TURB.map(([n, v]) => `<option value="${v}" ${Math.abs(w.turbulence - v) < 0.01 ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          ${this.slider('wx-temp', 'Temperature at the field', -20, 45, 1, w.tempC, ' °C')}
          ${this.slider('wx-qnh', 'Altimeter setting (QNH)', 28.5, 31, 0.01, w.qnhInHg, ' inHg')}
          ${this.slider('wx-elev', 'Field elevation', 0, 8000, 100, w.fieldElevFt, ' ft')}
        </div>
        <div class="conditions" id="wx-readout" style="margin-top:14px"></div>
        <p class="note">Density altitude is computed from the pressure and temperature you set — the airplane, engine and propeller all respond to the actual air density, so hot & high really does hurt.</p>
        <div class="row"><button class="primary" id="wx-fly">Fly free flight in these conditions</button></div>`;
      const upd = () => {
        w.windDir = +$('wx-dir').value;
        w.windKt = +$('wx-kt').value;
        w.gustKt = Math.max(+$('wx-gust').value, 0);
        w.turbulence = +$('wx-turb').value;
        w.tempC = +$('wx-temp').value;
        w.qnhInHg = +$('wx-qnh').value;
        w.fieldElevFt = +$('wx-elev').value;
        this.syncSliderLabels(el);
        this.updateWxReadout();
        this.persist();
      };
      el.querySelectorAll('input,select').forEach((i) => (i.oninput = upd));
      $('wx-fly').onclick = () => this.showBriefing(FS.LESSONS.find((l) => l.id === 'free-runway'));
    }
    updateWxReadout() {
      const wx = new FS.Weather(this.settings.weather);
      const d = wx.describe();
      const c = wx.components(0);
      $('wx-readout').innerHTML = `<span>Wind <b>${d.wind}</b></span><span>Runway 36: headwind <b>${c.head.toFixed(0)} kt</b>, crosswind <b>${Math.abs(c.cross).toFixed(0)} kt ${c.cross >= 0 ? 'from right' : 'from left'}</b></span><span>Pressure alt <b>${d.pressureAltFt.toLocaleString()} ft</b></span><span>Density alt <b>${d.densityAltFt.toLocaleString()} ft</b></span>`;
    }

    slider(id, label, min, max, step, val, unit) {
      return `<div class="field"><label>${label} <b data-for="${id}" data-unit="${unit}">${val}${unit}</b></label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"></div>`;
    }
    syncSliderLabels(root) {
      root.querySelectorAll('b[data-for]').forEach((b) => {
        const i = $(b.dataset.for);
        if (i) b.textContent = `${i.value}${b.dataset.unit}`;
      });
    }

    // ---------------------------------------------------------------- weight & balance tab
    buildWB() {
      const el = $('tab-wb');
      const L = this.settings.loading;
      const wb = FS.PA28.wb;
      el.innerHTML = `
        <p class="muted">Load the airplane and watch the centre of gravity move. Used by <b>Free Flight</b>. The flight model responds to weight (stall speed, climb, takeoff roll) and CG (pitch stability, trim, control feel).</p>
        <div class="presets">
          <button data-p="solo">Solo student</button>
          <button data-p="two">Two adults, full fuel</button>
          <button data-p="four">Four adults, full fuel</button>
          <button data-p="aft">Aft CG</button>
          <button data-p="fwd">Forward CG</button>
        </div>
        <div class="wb-grid">
          <div>
            <div class="form" style="grid-template-columns:1fr">
              ${wb.stations.map((s) => this.slider(`wb-${s.id}`, `${s.label} (arm ${s.arm} in)`, 0, s.max + 60, 10, L[s.id] || 0, ' lb')).join('')}
              ${this.slider('wb-fuel', `Fuel (arm ${wb.fuelArm} in, ${wb.fuelUsableGal} gal usable)`, 0, wb.fuelUsableGal, 1, L.fuelGal, ' gal')}
            </div>
            <table class="wb-table" id="wb-table"></table>
            <div id="wb-status" class="wb-status"></div>
          </div>
          <div><canvas id="wb-chart"></canvas><p class="note">The shaded shape is the CG envelope (normal category). Your loading must sit inside it — at takeoff <i>and</i> as fuel burns off (the dot's trail).</p></div>
        </div>
        <div class="row"><button class="primary" id="wb-fly">Fly free flight with this load</button></div>`;
      const presets = {
        solo: { front: 170, rear: 0, baggage: 0, fuelGal: 30 },
        two: { front: 360, rear: 0, baggage: 40, fuelGal: 48 },
        four: { front: 360, rear: 340, baggage: 20, fuelGal: 48 },
        aft: { front: 300, rear: 260, baggage: 140, fuelGal: 30 },
        fwd: { front: 400, rear: 0, baggage: 0, fuelGal: 20 },
      };
      el.querySelectorAll('[data-p]').forEach(
        (b) =>
          (b.onclick = () => {
            const p = presets[b.dataset.p];
            for (const s of wb.stations) $(`wb-${s.id}`).value = p[s.id];
            $('wb-fuel').value = p.fuelGal;
            upd();
          })
      );
      const upd = () => {
        for (const s of wb.stations) L[s.id] = +$(`wb-${s.id}`).value;
        L.fuelGal = +$('wb-fuel').value;
        this.syncSliderLabels(el);
        this.drawWB();
        this.persist();
      };
      el.querySelectorAll('input').forEach((i) => (i.oninput = upd));
      $('wb-fly').onclick = () => this.showBriefing(FS.LESSONS.find((l) => l.id === 'free-runway'));
    }

    drawWB() {
      const L = this.settings.loading;
      const r = this.ac.computeWB(L);
      const wb = FS.PA28.wb;
      const rows = [['Empty airplane', wb.emptyLb, wb.emptyArm]];
      for (const s of wb.stations) rows.push([s.label, L[s.id] || 0, s.arm]);
      rows.push([`Fuel ${L.fuelGal} gal × 6 lb`, L.fuelGal * 6, wb.fuelArm]);
      $('wb-table').innerHTML = `<tr><th>Item</th><th>Weight</th><th>Arm</th><th>Moment</th></tr>${rows.map(([n, w, a]) => `<tr><td>${n}</td><td>${Math.round(w)}</td><td>${a.toFixed(1)}</td><td>${Math.round(w * a).toLocaleString()}</td></tr>`).join('')}<tr><th>Total</th><th>${Math.round(r.weightLb)}</th><th>${r.cgIn.toFixed(1)}</th><th>${Math.round(r.momentInLb).toLocaleString()}</th></tr>`;
      const st = $('wb-status');
      const tmp = new FS.Aircraft(FS.PA28, new FS.Weather({}));
      tmp.setLoading(L);
      st.className = `wb-status ${r.ok ? 'ok' : 'bad'}`;
      st.innerHTML = r.ok
        ? `Within limits. Static margin ${(tmp.staticMargin * 100).toFixed(0)}% MAC — ${tmp.staticMargin > 0.16 ? 'very stable, heavy in pitch' : tmp.staticMargin < 0.08 ? 'light, lively pitch: careful' : 'normal feel'}. Clean stall ≈ ${Math.round(50 * Math.sqrt(r.weightLb / 2440))} KIAS.`
        : `NOT airworthy: ${r.problems.join('; ')}.`;
      // chart
      const cv = $('wb-chart');
      if (!cv) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = cv.getBoundingClientRect();
      if (rect.width < 10) return;
      cv.width = rect.width * dpr;
      cv.height = rect.height * dpr;
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = rect.width, H = rect.height;
      const x = (cg) => 40 + ((cg - 81) / 14) * (W - 55);
      const y = (w) => H - 28 - ((w - 1400) / 1300) * (H - 45);
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '11px system-ui';
      for (let cg = 82; cg <= 95; cg += 1) {
        ctx.beginPath();
        ctx.moveTo(x(cg), y(1400));
        ctx.lineTo(x(cg), y(2700));
        ctx.stroke();
        if (cg % 2 === 0) ctx.fillText(String(cg), x(cg) - 6, H - 12);
      }
      for (let w = 1400; w <= 2700; w += 200) {
        ctx.beginPath();
        ctx.moveTo(x(81), y(w));
        ctx.lineTo(x(95), y(w));
        ctx.stroke();
        ctx.fillText(String(w), 4, y(w) + 4);
      }
      ctx.fillText('CG (inches aft of datum) →', W - 170, H - 1);
      const env = wb.envelope;
      ctx.fillStyle = 'rgba(62,207,122,0.16)';
      ctx.strokeStyle = 'rgba(62,207,122,0.8)';
      ctx.beginPath();
      env.forEach((e, i) => (i ? ctx.lineTo(x(e[1]), y(e[0])) : ctx.moveTo(x(e[1]), y(e[0]))));
      for (let i = env.length - 1; i >= 0; i--) ctx.lineTo(x(env[i][2]), y(env[i][0]));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,90,78,0.6)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x(81), y(wb.maxGrossLb));
      ctx.lineTo(x(95), y(wb.maxGrossLb));
      ctx.stroke();
      ctx.setLineDash([]);
      // fuel burn line
      const empty = this.ac.computeWB(Object.assign({}, L, { fuelGal: 0 }));
      ctx.strokeStyle = 'rgba(255,181,71,0.6)';
      ctx.beginPath();
      ctx.moveTo(x(r.cgIn), y(r.weightLb));
      ctx.lineTo(x(empty.cgIn), y(empty.weightLb));
      ctx.stroke();
      ctx.fillStyle = r.ok ? '#ffb547' : '#ff5a4e';
      ctx.beginPath();
      ctx.arc(x(r.cgIn), y(r.weightLb), 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---------------------------------------------------------------- controls tab
    buildControls() {
      const el = $('tab-controls');
      const k = (keys, what) => `<div><span>${what}</span><span>${keys.map((x) => `<kbd>${x}</kbd>`).join(' ')}</span></div>`;
      const s = this.input.settings;
      el.innerHTML = `
        <p class="muted"><b>Best experience:</b> click the 3D view to fly with the <b>mouse yoke</b> (mouse position = yoke position, wheel = trim) and keep your left hand on <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> for throttle and rudder. A USB gamepad or joystick also works (left stick = yoke, right stick = rudder, triggers = throttle, bumpers = flaps).</p>
        <div class="group-title">Flying</div>
        <div class="keys">
          ${k(['↓'], 'Pull back (nose up)')}
          ${k(['↑'], 'Push forward (nose down)')}
          ${k(['←', '→'], 'Roll (ailerons)')}
          ${k(['A', 'D'], 'Rudder left / right (also nose-wheel steering)')}
          ${k(['W', 'S'], 'Throttle up / down (hold; Shift = faster)')}
          ${k(['E', 'Q'], 'Trim nose-up / nose-down (hold)')}
          ${k(['F', 'V'], 'Flaps down / up one notch (0-10-25-40°)')}
          ${k(['Space'], 'Brakes (hold)')}
          ${k([',', '.'], 'Left / right brake (differential)')}
          ${k(['B'], 'Parking brake on/off')}
          ${k(['Shift'], 'Hold for finer yoke / rudder inputs')}
        </div>
        <div class="group-title">Sim</div>
        <div class="keys">
          ${k(['Y'], 'Mouse yoke on/off (or click the view)')}
          ${k(['C'], 'View: cockpit → chase → tower')}
          ${k(['1', '2', '3', '4', '5'], 'Look left · front-left · ahead · front-right · right')}
          ${k(['6', '7'], 'Look back-left / back-right')}
          ${k(['H'], 'Teaching aids (flight-path marker, digital HUD)')}
          ${k(['N'], 'Continue (instructor steps that wait for you)')}
          ${k(['P'], 'Pause')}
          ${k(['T'], 'Simulation speed 1× → ½× → ¼× → 2×')}
          ${k(['R'], 'Restart lesson')}
          ${k(['K'], 'Set altimeter to current setting')}
          ${k(['M'], 'Sound on/off')}
          ${k(['Esc'], 'Menu')}
        </div>
        <p class="note">Mouse wheel over the <b>altimeter</b> sets the Kollsman window; over the <b>heading indicator</b> moves the heading bug (click it to sync to your heading).</p>
        <div class="group-title">Options</div>
        <div class="form">
          <div class="field"><label>Spring-centred keyboard yoke</label><select id="opt-spring"><option value="1" ${s.spring ? 'selected' : ''}>Yes — returns to trimmed neutral (realistic)</option><option value="0" ${!s.spring ? 'selected' : ''}>No — stays where you leave it</option></select></div>
          ${this.slider('opt-pitch', 'Keyboard pitch rate', 0.3, 2, 0.1, s.pitchRate, '')}
          ${this.slider('opt-roll', 'Keyboard roll rate', 0.5, 3, 0.1, s.rollRate, '')}
          ${this.slider('opt-mouse', 'Mouse-yoke sensitivity', 0.5, 2, 0.05, s.mouseSens, '')}
          <div class="field"><label>Mouse-yoke pitch</label><select id="opt-inv"><option value="0" ${!s.invertMouse ? 'selected' : ''}>Mouse down = pull back</option><option value="1" ${s.invertMouse ? 'selected' : ''}>Mouse up = pull back</option></select></div>
        </div>`;
      const upd = () => {
        s.spring = $('opt-spring').value === '1';
        s.pitchRate = +$('opt-pitch').value;
        s.rollRate = +$('opt-roll').value;
        s.mouseSens = +$('opt-mouse').value;
        s.invertMouse = $('opt-inv').value === '1';
        this.settings.input = Object.assign({}, s);
        this.syncSliderLabels(el);
        this.persist();
      };
      el.querySelectorAll('input,select').forEach((i) => (i.oninput = upd));
    }

    // ---------------------------------------------------------------- about tab
    buildAbout() {
      const el = $('tab-about');
      const ac = new FS.Aircraft(FS.PA28, new FS.Weather({ fieldElevFt: 0, tempC: 15 }));
      ac.setLoading(FS.lessonHelpers.LOAD_GROSS);
      const climb = ac.solveTrim({ altMSL: 0, ias: 79, throttle: 1 });
      const glide = ac.solveTrim({ altMSL: 300, ias: 73, throttle: 0 });
      const cruise = ac.solveTrim({ altMSL: 0, ias: 110, gamma: 0 });
      el.innerHTML = `
        <div class="prose">
          <p><b>This isn't a game engine pretending to fly — it's a flight-dynamics model.</b> Every frame (240 times a second) the simulator computes the forces on a rigid airplane and integrates Newton's laws in six degrees of freedom (three of position, three of rotation).</p>
          <ul>
            <li><b>Weight</b> — 9.81 m/s² × the mass you load on the W&amp;B page, acting at the centre of gravity you load it at.</li>
            <li><b>Lift</b> — ½ρV²·S·C<sub>L</sub>, with C<sub>L</sub> from angle of attack, a rounded stall break, flaps, pitch rate, downwash lag and ground effect.</li>
            <li><b>Drag</b> — parasite + induced (C<sub>L</sub>²/πAe) + flaps + sideslip + flow separation past the stall.</li>
            <li><b>Thrust</b> — from a fixed-pitch propeller modelled with thrust and power coefficients vs. advance ratio, driven by a 160-hp engine whose power falls with density. RPM is not set by the throttle: it's where engine torque and propeller torque balance, so it rises in a dive and sags in a climb — just like the real thing.</li>
            <li><b>Moments</b> — static stability (C<sub>mα</sub>, C<sub>nβ</sub>, dihedral C<sub>lβ</sub>), damping, adverse yaw, P-factor &amp; slipstream, engine torque, gyroscopic precession, and a CG-dependent pitch moment.</li>
            <li><b>Ground</b> — three spring/damper struts with tyre friction, brakes, and rudder-linked nose-wheel steering. Wingtips, tail and prop can strike the ground.</li>
            <li><b>Air</b> — a non-standard atmosphere from altimeter setting and temperature (density altitude is physical, not a lookup), a log-profile wind gradient near the ground, gusts, and Dryden-style turbulence.</li>
          </ul>
          <p>The instruments read what they physically sense: the ASI reads pitot pressure (so it shows wind on the ground and reads low at high AoA), the altimeter reads static pressure against your Kollsman setting, the VSI lags, the ball is a ball.</p>
          <p><b>Calibration</b> (gross weight, sea level, standard day) — see <code>tools/calibrate.js</code>:</p>
          <table class="perf">
            <tr><th>Item</th><th>This sim</th><th>PA-28-161 POH (approx.)</th></tr>
            <tr><td>Stall, clean / full flaps</td><td>51 / 44 KIAS</td><td>50 / 44 KIAS</td></tr>
            <tr><td>Climb at Vy (79 KIAS)</td><td>${Math.round((climb.tas * Math.sin(climb.gamma)) / U.FPM)} fpm</td><td>~640 fpm</td></tr>
            <tr><td>Best glide 73 KIAS, idle</td><td>${(1 / Math.tan(-glide.gamma)).toFixed(1)} : 1</td><td>~10 : 1</td></tr>
            <tr><td>Level at 110 KIAS</td><td>${Math.round(cruise.rpm)} RPM</td><td>~2,450 RPM</td></tr>
            <tr><td>Max level speed</td><td>~122 KIAS</td><td>~125 kt</td></tr>
            <tr><td>Takeoff ground roll (flaps 25)</td><td>~1,030 ft</td><td>~975 ft</td></tr>
          </table>
          <p class="note">For learning fundamentals only. Always fly the real airplane by its Pilot's Operating Handbook and your CFI.</p>
        </div>`;
    }

    persist() {
      this.store.settings = this.settings;
      this.store.progress = this.progress;
      save(this.store);
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
  });
})();
