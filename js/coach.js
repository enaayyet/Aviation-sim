/*
 * coach.js — the live flight instructor and the pilot assists.
 *
 * Coach watches telemetry every frame, in lessons and in free flight, and speaks up the way a CFI in
 * the right seat does: only when an error has persisted for a moment, one thing at a time, most
 * urgent first, and with the reason attached. It also keeps a tally for the debrief.
 *
 * AutoRudder is the one flying assist: it keeps the ball centred in the air and the nose on the
 * runway heading during the takeoff and landing roll, so a new pilot can learn pitch, bank and power
 * first and take the rudder over later.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { M } = FS;
  const { clamp, wrap180 } = M;
  const FT = 3.28084;
  const NM = 1852;

  /**
   * Where the airplane is relative to the runway, for whichever end it is pointed at.
   * dist = metres still to fly to the landing threshold (negative once past it), lat = metres right
   * of the extended centreline as seen by the pilot, hdgErr = heading minus runway heading.
   */
  function runwayFrame(t, world) {
    const rw = world.runway;
    const south = Math.abs(wrap180(t.hdg - 180)) < 90; // landing/taking off on 18
    const dist = south ? t.n - rw.length : -t.n;
    const lat = south ? -t.e : t.e;
    const rwyHdg = south ? 180 : 0;
    return { south, dist, lat, rwyHdg, hdgErr: wrap180(t.hdg - rwyHdg), aim: rw.aimN, onRunway: t.n >= -10 && t.n <= rw.length + 10 && Math.abs(t.e) <= rw.width / 2 + 2 };
  }

  /** Glide-path angle (deg) from the airplane down to the aiming point. */
  function pathAngle(t, rf) {
    const d = rf.dist + rf.aim;
    if (d < 30) return null;
    return Math.atan2(t.agl / FT, d) * (180 / Math.PI);
  }

  // Each rule: id, pri (higher wins), hold (s the condition must persist), cool (s before repeating),
  // kind (toast colour), when(t, c) -> bool, say(t, c) -> text.
  const RULES = [
    {
      id: 'spin', pri: 100, hold: 0.6, cool: 8, kind: 'bad',
      when: (t) => !t.onGround && t.stalled && Math.abs(t.turnRate) > 25 && t.agl > 50,
      say: (t) => `Spin entry! Power idle, ailerons neutral, full ${t.turnRate > 0 ? 'LEFT' : 'RIGHT'} rudder, then yoke forward to break the stall.`,
    },
    {
      id: 'stall', pri: 95, hold: 0.4, cool: 7, kind: 'bad',
      when: (t) => !t.onGround && t.stallWarn && t.agl > 15,
      say: (t) => (t.agl < 1000 ? 'Stall warning, and you are low. Lower the nose now and add full power.' : 'Stall warning. The wing is near its critical angle of attack: ease the yoke forward, then add power.'),
    },
    {
      id: 'sink', pri: 90, hold: 1.0, cool: 8, kind: 'bad',
      when: (t, c) => c.phase === 'approach' && t.agl < 300 && t.agl > 15 && t.vs < -1000,
      say: (t) => `Sink rate ${Math.round(-t.vs / 50) * 50} fpm this close to the ground. Add power and raise the nose a little.`,
    },
    {
      id: 'low-slow-turn', pri: 85, hold: 1.0, cool: 12, kind: 'bad',
      when: (t) => !t.onGround && t.agl < 800 && Math.abs(t.bank) > 33 && t.ias < 72,
      say: (t) => `${Math.round(Math.abs(t.bank))}° of bank at ${Math.round(t.ias)} kt, low. Stall speed rises with bank; shallow the turn and lower the nose.`,
    },
    {
      id: 'slow-final', pri: 80, hold: 1.5, cool: 9, kind: 'bad',
      when: (t, c) => c.phase === 'approach' && t.agl > 20 && t.ias < (t.flaps > 20 ? 57 : 62),
      say: (t) => `Airspeed ${Math.round(t.ias)}, too slow. Lower the nose a touch and add power. Hold 65 on final.`,
    },
    {
      id: 'balloon', pri: 78, hold: 0.5, cool: 6, kind: 'warn',
      when: (t, c) => c.phase === 'flare' && t.vs > 150 && t.agl > 4,
      say: () => 'Ballooning. Freeze the yoke where it is, do not push. Let it settle, then keep flaring. Too high? Add a little power or go around.',
    },
    {
      id: 'flat', pri: 76, hold: 0.5, cool: 6, kind: 'warn',
      when: (t, c) => c.phase === 'flare' && t.agl < 10 && t.pitch < 1.5 && t.vs < -150,
      say: () => 'Flare. Ease the yoke back and hold the airplane off so the main wheels touch first.',
    },
    {
      id: 'low-path', pri: 74, hold: 2.5, cool: 16, kind: 'bad',
      when: (t, c) => c.phase === 'approach' && t.agl > 40 && c.path !== null && c.path < 2.1,
      say: () => 'You are low on the glide path, red lights on the PAPI. Add power and hold this speed until the lights turn two white, two red.',
    },
    {
      id: 'high-path', pri: 60, hold: 3, cool: 14, kind: 'warn',
      when: (t, c) => c.phase === 'approach' && t.agl > 150 && c.path !== null && c.path > 4.6 && c.rf.dist < 1.5 * NM,
      say: (t) => (t.flaps < 35 ? 'High on the glide path, all white on the PAPI. Reduce power and add flaps.' : 'High with full flaps. Power to idle and slip, or go around. Do not dive at the runway: you will only gain speed.'),
    },
    {
      id: 'fast-final', pri: 58, hold: 2.5, cool: 12, kind: 'warn',
      when: (t, c) => c.phase === 'approach' && t.agl < 300 && t.agl > 20 && t.ias > 80,
      say: (t) => `${Math.round(t.ias)} kt is fast for short final. Every extra knot is float in the flare. Power back and hold the nose up to bleed it off.`,
    },
    {
      id: 'centerline', pri: 56, hold: 2.5, cool: 12, kind: 'warn',
      when: (t, c) => c.phase === 'approach' && t.agl < 400 && c.rf.dist < 0.8 * NM && Math.abs(c.rf.lat) > 12 + Math.max(0, c.rf.dist) * 0.05,
      say: (t, c) => `You are ${c.rf.lat > 0 ? 'right' : 'left'} of the centreline. Small bank ${c.rf.lat > 0 ? 'left' : 'right'} to slide back over it, then level the wings.`,
    },
    {
      id: 'spiral', pri: 72, hold: 1.5, cool: 10, kind: 'bad',
      when: (t) => !t.onGround && t.vs < -1800 && t.ias > 125,
      say: () => 'Nose low and accelerating. Power to idle, roll the wings level first, then ease out of the dive.',
    },
    {
      id: 'overbank', pri: 50, hold: 2, cool: 15, kind: 'warn',
      when: (t) => !t.onGround && Math.abs(t.bank) > 52 && !t.stalled,
      say: (t) => {
        const g = 1 / Math.cos((Math.min(75, Math.abs(t.bank)) * Math.PI) / 180);
        return `${Math.round(Math.abs(t.bank))}° of bank needs ${g.toFixed(1)} G to hold altitude, and stall speed is up ${Math.round((Math.sqrt(g) - 1) * 100)}%. Roll out to 45° or less.`;
      },
    },
    {
      id: 'rudder-climb', pri: 48, hold: 5, cool: 18, kind: 'warn',
      when: (t) => !t.onGround && t.agl > 30 && t.throttle > 0.85 && t.ias < 95 && t.ball > 1.1 && Math.abs(t.bank) < 30,
      say: () => 'More right rudder. At full power and a high nose the propeller pulls the nose left; step on the ball to centre it.',
    },
    {
      id: 'wings-climb', pri: 49, hold: 2.5, cool: 10, kind: 'warn',
      when: (t, c) => c.phase === 'climbout' && Math.abs(t.bank) > 15 && t.agl > 20,
      say: (t) => `Your ${t.bank < 0 ? 'left' : 'right'} wing is dropping, ${Math.round(Math.abs(t.bank))}° of bank. Level the wings with ${t.bank < 0 ? 'right' : 'left'} aileron${t.bank < 0 ? ' and hold right rudder: engine torque and P-factor roll and yaw you left in the climb' : ''}.`,
    },
    {
      id: 'ball', pri: 44, hold: 2.5, cool: 14, kind: 'warn',
      when: (t, c) => !t.onGround && t.agl > 300 && Math.abs(t.ball) > 3 && c.phase !== 'approach',
      say: (t) => `Step on the ball: ${t.ball > 0 ? 'right' : 'left'} rudder. You are ${Math.abs(t.bank) > 10 ? (t.ball * t.bank > 0 ? 'slipping' : 'skidding') + ' through the turn' : 'flying sideways through the air'}, which is pure drag.`,
    },
    {
      id: 'rotate', pri: 46, hold: 2, cool: 10, kind: 'warn',
      when: (t) => t.onGround && t.throttle > 0.8 && t.ias > 62,
      say: (t) => `${Math.round(t.ias)} kt and still on the runway. Ease the yoke back and let it fly off.`,
    },
    {
      id: 'early-rotate', pri: 46, hold: 1.2, cool: 12, kind: 'warn',
      when: (t) => t.mainsOnGround && t.throttle > 0.8 && t.ias < 45 && t.ias > 15 && t.pitch > 9,
      say: () => 'Nose is too high too early. That is drag without lift. Lower it and wait for 55 kt before you rotate.',
    },
    {
      id: 'roll-centerline', pri: 45, hold: 1.5, cool: 9, kind: 'warn',
      when: (t, c) => t.onGround && c.rf.onRunway && t.gs > 15 && Math.abs(c.rf.lat) > 5.5,
      say: (t, c) => `Drifting ${c.rf.lat > 0 ? 'right' : 'left'} of the centreline. ${c.rf.lat > 0 ? 'Left' : 'Right'} rudder, small and early.`,
    },
    {
      id: 'parking-brake', pri: 70, hold: 1, cool: 10, kind: 'warn',
      when: (t) => t.onGround && t.parkingBrake && t.throttle > 0.4,
      say: () => 'The parking brake is still set. Press B to release it.',
    },
    {
      id: 'climb-slow', pri: 42, hold: 3, cool: 14, kind: 'warn',
      when: (t, c) => c.phase === 'climbout' && t.ias < 66 && !t.stallWarn,
      say: (t) => `${Math.round(t.ias)} kt in the climb. The nose is too high and you are behind the power curve. Lower it to hold 79 (Vy).`,
    },
    {
      id: 'climb-fast', pri: 30, hold: 6, cool: 20, kind: '',
      when: (t, c) => c.phase === 'climbout' && t.ias > 96,
      say: (t) => `${Math.round(t.ias)} kt after takeoff. You are spending power on speed instead of height. Raise the nose and hold 79 (Vy).`,
    },
    {
      id: 'flaps-climb', pri: 28, hold: 12, cool: 30, kind: '',
      when: (t) => !t.onGround && t.agl > 400 && t.flaps > 5 && t.throttle > 0.9 && t.vs > 100 && t.ias > 68,
      say: () => 'Positive rate and above 400 ft: retract the flaps one notch at a time (V). They are only drag now.',
    },
    {
      id: 'flap-speed', pri: 40, hold: 1.5, cool: 15, kind: 'warn',
      when: (t) => !t.onGround && t.flapsSel > 0 && t.ias > 100,
      say: () => 'Slow below 103 kt (the white arc) before you lower flaps.',
    },
    {
      id: 'trim', pri: 20, hold: 10, cool: 30, kind: '',
      when: (t, c) => !t.onGround && t.agl > 300 && c.phase === 'cruise' && Math.abs(t.elevator) > 0.14 && Math.abs(t.q) < 1.5 && Math.abs(t.bank) < 20,
      say: (t) => `You have been holding ${t.elevator > 0 ? 'back' : 'forward'} pressure for a while. Trim nose-${t.elevator > 0 ? 'up (E)' : 'down (Q)'} until the yoke stays put by itself.`,
    },
    {
      id: 'carb-idle-high', pri: 18, hold: 20, cool: 60, kind: '',
      when: (t) => !t.onGround && t.throttle > 0.97 && t.vs > -100 && t.vs < 100 && t.agl > 1200 && t.ias > 112,
      say: () => 'Level at full throttle. Set cruise power, about 2,400 RPM, then re-trim. Power sets speed in level flight.',
    },
  ];

  class Coach {
    constructor(world) {
      this.world = world;
      this.muted = new Set();
      this.reset();
    }

    reset() {
      this.timers = {};
      this.lastSaid = {};
      this.counts = {};
      this.texts = {};
      this.quiet = 0;
      this.time = 0;
      this.phase = 'cruise';
      this.airTime = 0;
      this.liftoffAgo = 1e9;
    }

    /** Rule ids that should stay silent (a stall lesson does not need "stall warning!"). */
    setMuted(ids) {
      this.muted = new Set(ids || []);
    }

    detectPhase(t, rf, path) {
      if (t.onGround) return 'ground';
      const aligned = Math.abs(rf.hdgErr) < 30 && Math.abs(rf.lat) < 150 + Math.max(0, rf.dist) * 0.25;
      const inbound = rf.dist > -this.world.runway.length * 0.7 && rf.dist < 3 * NM;
      if (aligned && inbound && t.agl < 35 && t.throttle < 0.7 && this.liftoffAgo > 20) return 'flare';
      if (aligned && inbound && t.agl < 900 && t.throttle < 0.75 && t.vs < 150 && this.liftoffAgo > 20) return 'approach';
      if (t.agl < 1000 && t.throttle > 0.85 && t.vs > 100) return 'climbout';
      return 'cruise';
    }

    /** Returns the one message to speak this frame, or null. */
    update(t, dt) {
      this.time += dt;
      this.quiet -= dt;
      if (t.onGround) this.liftoffAgo = 0;
      else this.liftoffAgo += dt;
      const rf = runwayFrame(t, this.world);
      const path = pathAngle(t, rf);
      this.phase = this.detectPhase(t, rf, path);
      const c = { phase: this.phase, rf, path };
      if (t.crashed) return null;
      let best = null;
      for (const r of RULES) {
        if (this.muted.has(r.id)) continue;
        const on = r.when(t, c);
        this.timers[r.id] = on ? (this.timers[r.id] || 0) + dt : 0;
        if (!on || this.timers[r.id] < r.hold) continue;
        const last = this.lastSaid[r.id];
        if (last !== undefined && this.time - last < r.cool) continue;
        if (!best || r.pri > best.pri) best = r;
      }
      if (!best) return null;
      // one voice at a time: only something urgent may interrupt
      if (this.quiet > 0 && best.pri < 75) return null;
      const text = best.say(t, c);
      this.lastSaid[best.id] = this.time;
      this.counts[best.id] = (this.counts[best.id] || 0) + 1;
      this.texts[best.id] = text;
      this.quiet = 4.5;
      return { id: best.id, text, kind: best.kind, pri: best.pri };
    }

    /** Is the condition behind this call-out still true right now? */
    isActive(id) {
      return (this.timers[id] || 0) > 0;
    }

    /** What the instructor had to say, most repeated first — for the debrief. */
    summary() {
      return Object.keys(this.counts)
        .map((id) => ({ id, count: this.counts[id], text: this.texts[id] }))
        .sort((a, b) => b.count - a.count);
    }
  }

  /** Rudder assist. Returns the rudder to add to the pilot's own input. */
  class AutoRudder {
    constructor(world) {
      this.world = world;
      this.i = 0;
      this.out = 0;
    }
    reset() {
      this.i = 0;
      this.out = 0;
    }
    update(t, dt) {
      let cmd = 0;
      if (t.onGround) {
        this.i = 0;
        const rf = runwayFrame(t, this.world);
        // only on the runway, roughly lined up, and actually rolling
        if (rf.onRunway && Math.abs(rf.hdgErr) < 35 && t.gs > 4) {
          const want = clamp(-rf.lat * 1.6, -8, 8); // steer a few degrees back toward the centreline
          const gain = clamp(30 / Math.max(t.gs, 10), 0.4, 1.5); // less authority needed as speed builds
          cmd = clamp((0.05 * (want - rf.hdgErr) - 0.02 * t.turnRate) * gain, -1, 1);
        }
      } else {
        this.i = clamp(this.i + t.ball * dt * 0.02, -0.5, 0.5);
        cmd = clamp(0.045 * t.ball + this.i, -1, 1);
      }
      this.out += clamp(cmd - this.out, -4 * dt, 4 * dt);
      return this.out;
    }
  }

  FS.Coach = Coach;
  FS.AutoRudder = AutoRudder;
  FS.COACH_RULES = RULES;
  FS.runwayFrame = runwayFrame;
})();
