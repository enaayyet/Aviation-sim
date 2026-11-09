/*
 * audio.js — engine, wind, stall horn, tyre chirp, buffet. Pure Web Audio synthesis, no files.
 * Sound is a real cockpit cue: RPM changes, the rising wind roar of a dive, the stall horn.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { M } = FS;

  class Sound {
    constructor() {
      this.ctx = null;
      this.muted = false;
      this.volume = 0.6;
    }

    init() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = (this.ctx = new AC());
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(ctx.destination);

      // noise buffer shared by wind/rumble/chirp
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      const noise = () => {
        const n = ctx.createBufferSource();
        n.buffer = buf;
        n.loop = true;
        n.start();
        return n;
      };

      // engine: firing pulses (sawtooth) + low thump, through a low-pass "cowling"
      this.engOsc = ctx.createOscillator();
      this.engOsc.type = 'sawtooth';
      this.engSub = ctx.createOscillator();
      this.engSub.type = 'triangle';
      this.engFilter = ctx.createBiquadFilter();
      this.engFilter.type = 'lowpass';
      this.engFilter.frequency.value = 400;
      this.engFilter.Q.value = 2;
      this.engGain = ctx.createGain();
      this.engGain.gain.value = 0;
      this.engOsc.connect(this.engFilter);
      this.engSub.connect(this.engFilter);
      this.engFilter.connect(this.engGain).connect(this.master);
      this.engOsc.start();
      this.engSub.start();

      // wind
      this.wind = noise();
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'bandpass';
      this.windFilter.frequency.value = 800;
      this.windFilter.Q.value = 0.6;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      this.wind.connect(this.windFilter).connect(this.windGain).connect(this.master);

      // rumble (ground roll, buffet)
      this.rumble = noise();
      this.rumbleFilter = ctx.createBiquadFilter();
      this.rumbleFilter.type = 'lowpass';
      this.rumbleFilter.frequency.value = 90;
      this.rumbleGain = ctx.createGain();
      this.rumbleGain.gain.value = 0;
      this.rumble.connect(this.rumbleFilter).connect(this.rumbleGain).connect(this.master);

      // stall horn: two detuned square waves
      this.hornGain = ctx.createGain();
      this.hornGain.gain.value = 0;
      for (const f of [440, 466]) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = 0.05;
        o.connect(g).connect(this.hornGain);
        o.start();
      }
      this.hornGain.connect(this.master);
    }

    setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }

    chirp(strength) {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx;
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1800;
      f.Q.value = 3;
      const g = ctx.createGain();
      const now = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(M.clamp(strength, 0.05, 0.5), now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      n.connect(f).connect(g).connect(this.master);
      n.start(now, Math.random());
      n.stop(now + 0.3);
    }

    update(t, paused) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const set = (param, v, tc = 0.08) => param.setTargetAtTime(v, now, tc);
      if (paused || t.crashed) {
        set(this.engGain.gain, 0);
        set(this.windGain.gain, 0);
        set(this.rumbleGain.gain, 0);
        set(this.hornGain.gain, 0);
        return;
      }
      const rpm = Math.max(0, t.rpm);
      const fire = (rpm / 60) * 2; // 4-cylinder, 4-stroke: 2 power pulses per revolution
      set(this.engOsc.frequency, Math.max(8, fire), 0.05);
      set(this.engSub.frequency, Math.max(4, fire / 2), 0.05);
      set(this.engFilter.frequency, 200 + rpm * 0.35, 0.1);
      const running = !t.engineFailed && rpm > 300;
      set(this.engGain.gain, running ? 0.06 + 0.16 * t.throttle + rpm / 30000 : rpm / 60000);
      const v = Math.max(0, t.tas);
      set(this.windGain.gain, Math.min(0.5, (v / 130) * (v / 130) * 0.35));
      set(this.windFilter.frequency, 400 + v * 8);
      const rumble = (t.onGround ? Math.min(1, t.gs / 50) * 0.5 : 0) + (t.stall > 0.05 && !t.onGround ? t.stall * 0.6 : 0);
      set(this.rumbleGain.gain, rumble, 0.05);
      set(this.hornGain.gain, t.stallWarn ? 0.9 : 0, 0.03);
    }
  }

  FS.Sound = Sound;
})();
