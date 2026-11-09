/*
 * input.js — keyboard, mouse-yoke and gamepad -> control positions.
 *
 * Keyboard yoke behaves like a spring-loaded control: hold a key and the deflection builds up; let go
 * and it springs back to neutral — where "neutral" is wherever you've TRIMMED it. That's exactly how a
 * real yoke feels, which is why trimming matters.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { M } = FS;
  const { clamp, approach } = M;

  const CONTINUOUS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyZ', 'KeyX',
    'KeyQ', 'KeyE', 'Space', 'PageUp', 'PageDown', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'Comma', 'Period',
  ]);

  class Input {
    constructor(viewEl) {
      this.keys = {};
      this.shift = false;
      this.mouseYoke = false;
      this.mouse = { x: 0, y: 0 };
      this.settings = { spring: true, pitchRate: 0.8, rollRate: 1.6, mouseSens: 1.0, invertMouse: false };
      this.gamepadActive = false;
      this.viewEl = viewEl;
      this.onAction = null;
      this.wheelTrim = 0;
      this.wheelThrottle = 0;
      window.addEventListener('keydown', (e) => this.down(e));
      window.addEventListener('keyup', (e) => this.up(e));
      window.addEventListener('blur', () => (this.keys = {}));
      viewEl.addEventListener('mousemove', (e) => {
        const r = viewEl.getBoundingClientRect();
        this.mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
        this.mouse.y = ((e.clientY - r.top) / r.height) * 2 - 1;
      });
      viewEl.addEventListener(
        'wheel',
        (e) => {
          if (!this.mouseYoke) return;
          e.preventDefault();
          const d = e.deltaY > 0 ? -1 : 1;
          if (e.shiftKey) this.wheelThrottle += d * 0.04;
          else this.wheelTrim += d * 0.03;
        },
        { passive: false }
      );
    }

    isTyping(e) {
      const t = e.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    }

    down(e) {
      if (this.isTyping(e)) return;
      this.shift = e.shiftKey;
      if (CONTINUOUS.has(e.code)) {
        this.keys[e.code] = true;
        e.preventDefault();
        return;
      }
      if (e.repeat) return;
      if (this.onAction && this.onAction(e.code, e)) e.preventDefault();
    }

    up(e) {
      this.shift = e.shiftKey;
      delete this.keys[e.code];
      if (CONTINUOUS.has(e.code) && !this.isTyping(e)) e.preventDefault();
    }

    resetYoke() {
      this.yoke = { e: 0, a: 0 };
    }

    toggleMouseYoke(on) {
      this.mouseYoke = on === undefined ? !this.mouseYoke : on;
      return this.mouseYoke;
    }

    /** Update the control object in place. */
    update(dt, ctl) {
      const k = this.keys;
      const s = this.settings;
      const fine = this.shift ? 0.4 : 1;
      const back = s.spring ? 2.6 : 0;

      // ---- gamepad (overrides yoke/rudder if present and moved)
      const gp = this.pollGamepad();

      // ---- yoke. "Expo" softens the centre so small corrections are easy while full deflection is still there.
      const expo = (x) => 0.5 * x + 0.5 * x * x * x;
      const y = this.yoke || (this.yoke = { e: 0, a: 0 });
      if (gp) {
        y.e = gp.elevator;
        y.a = gp.aileron;
        ctl.rudder = gp.rudder;
      } else if (this.mouseYoke) {
        const dz = (v) => (Math.abs(v) < 0.03 ? 0 : (v - Math.sign(v) * 0.03) / 0.97);
        y.a = clamp(dz(this.mouse.x) * 1.15 * s.mouseSens, -1, 1);
        y.e = clamp(dz(this.mouse.y) * 1.25 * s.mouseSens * (s.invertMouse ? -1 : 1), -1, 1);
      } else {
        if (k.ArrowDown) y.e = Math.min(1, Math.max(y.e, 0) + s.pitchRate * fine * dt);
        else if (k.ArrowUp) y.e = Math.max(-1, Math.min(y.e, 0) - s.pitchRate * fine * dt);
        else y.e = approach(y.e, 0, back * dt);
        if (k.ArrowRight) y.a = Math.min(1, Math.max(y.a, 0) + s.rollRate * fine * dt);
        else if (k.ArrowLeft) y.a = Math.max(-1, Math.min(y.a, 0) - s.rollRate * fine * dt);
        else y.a = approach(y.a, 0, back * 1.3 * dt);
      }
      ctl.elevator = expo(y.e);
      ctl.aileron = expo(y.a);
      if (!gp) {
        const rr = 1.5 * fine;
        if (k.KeyD || k.KeyX) ctl.rudder = Math.min(1, ctl.rudder + rr * dt);
        else if (k.KeyA || k.KeyZ) ctl.rudder = Math.max(-1, ctl.rudder - rr * dt);
        else ctl.rudder = approach(ctl.rudder, 0, 2.2 * dt);
      }

      // ---- throttle
      const tr = this.shift ? 1.2 : 0.45;
      if (k.KeyW || k.PageUp || k.Equal || k.NumpadAdd) ctl.throttle += tr * dt;
      if (k.KeyS || k.PageDown || k.Minus || k.NumpadSubtract) ctl.throttle -= tr * dt;
      ctl.throttle += this.wheelThrottle;
      this.wheelThrottle = 0;
      if (gp && gp.throttleRate) ctl.throttle += gp.throttleRate * 0.5 * dt;
      ctl.throttle = clamp(ctl.throttle, 0, 1);

      // ---- trim (wheel)
      const trr = this.shift ? 0.6 : 0.22;
      if (k.KeyE) ctl.trim += trr * dt;
      if (k.KeyQ) ctl.trim -= trr * dt;
      if (gp && gp.trimRate) ctl.trim += gp.trimRate * 0.25 * dt;
      ctl.trim += this.wheelTrim;
      this.wheelTrim = 0;
      ctl.trim = clamp(ctl.trim, -1, 1);

      // ---- brakes
      const bk = k.Space || (gp && gp.brake > 0.1);
      const bv = gp && gp.brake > 0.1 ? gp.brake : 1;
      const bl = k.Comma ? 1 : 0, br = k.Period ? 1 : 0;
      ctl.brakeL = approach(ctl.brakeL, bk ? bv : bl, 4 * dt);
      ctl.brakeR = approach(ctl.brakeR, bk ? bv : br, 4 * dt);
    }

    pollGamepad() {
      if (!navigator.getGamepads) return null;
      const pads = navigator.getGamepads();
      let gp = null;
      for (const p of pads) if (p && p.connected) {
        gp = p;
        break;
      }
      if (!gp) return null;
      const dz = (v) => (Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92);
      const ax = gp.axes;
      const moved = ax.some((v) => Math.abs(v) > 0.2) || gp.buttons.some((b) => b.pressed);
      if (moved) this.gamepadActive = true;
      if (!this.gamepadActive) return null;
      const btn = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
      // edge-triggered buttons: bumpers = flaps
      this.gpPrev = this.gpPrev || {};
      const edge = (i) => {
        const now = btn(i) > 0.5;
        const was = this.gpPrev[i];
        this.gpPrev[i] = now;
        return now && !was;
      };
      if (edge(5) && this.onAction) this.onAction('KeyF', {});
      if (edge(4) && this.onAction) this.onAction('KeyV', {});
      if (edge(3) && this.onAction) this.onAction('KeyC', {});
      if (edge(9) && this.onAction) this.onAction('KeyP', {});
      return {
        aileron: dz(ax[0] || 0),
        elevator: dz(ax[1] || 0),
        rudder: dz(ax[2] || 0),
        throttleRate: btn(7) - btn(6),
        trimRate: btn(12) - btn(13),
        brake: btn(0),
      };
    }
  }

  FS.Input = Input;
})();
