/*
 * lessons.js — the curriculum and the "flight instructor" that runs it.
 *
 * Every lesson is: a briefing (the why), a setup (where you start, the weather, the load), and a list of
 * steps. Each step tells you what to do, decides when you've done it, and grades you while you do it
 * against tolerances taken from the FAA Private Pilot Airman Certification Standards (ACS).
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { M } = FS;
  const { wrap180, clamp } = M;
  const FT = 3.28084; // feet per metre

  // ------------------------------------------------------------------ grading helpers
  const G = {
    alt: (target, tol = 100, o = {}) => Object.assign({ key: 'alt', label: 'Altitude', unit: 'ft', get: (t) => t.altInd, target, tol }, o),
    ias: (target, tol = 10, o = {}) => Object.assign({ key: 'ias', label: 'Airspeed', unit: 'kt', get: (t) => t.ias, target, tol }, o),
    hdg: (target, tol = 10, o = {}) => Object.assign({ key: 'hdg', label: 'Heading', unit: '°', get: (t) => t.hdg, target, tol, wrap: true }, o),
    bank: (target, tol = 5, o = {}) => Object.assign({ key: 'bank', label: 'Bank angle', unit: '°', get: (t) => Math.abs(t.bank), target, tol }, o),
    ball: (tol = 4, o = {}) => Object.assign({ key: 'ball', label: 'Coordination (ball)', unit: '°', get: (t) => t.ball, target: 0, tol }, o),
    vs: (target, tol = 200, o = {}) => Object.assign({ key: 'vs', label: 'Vertical speed', unit: 'fpm', get: (t) => t.vs, target, tol }, o),
    centerline: (tolFt = 20, o = {}) => Object.assign({ key: 'cl', label: 'Centreline', unit: 'ft', get: (t) => t.e * FT, target: 0, tol: tolFt }, o),
  };

  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const hdgNear = (a, b, tol) => Math.abs(wrap180(a - b)) <= tol;
  const status = (v, passMax, margMax) => (v <= passMax ? 'pass' : v <= margMax ? 'marginal' : 'fail');

  /** Grade a touchdown against the ACS normal-landing standard (specified point = 1000-ft aiming markers). */
  function gradeLanding(ctx, td, opts = {}) {
    const world = ctx.world;
    const L = world.runway.length;
    const onRunway = td.n >= -5 && td.n <= L && Math.abs(td.e) <= world.runway.width / 2;
    ctx.result('Touchdown sink rate', `${Math.round(Math.max(0, td.vsFpm))} fpm`, status(td.vsFpm, 300, 600), td.vsFpm > 600 ? 'Hard landing — inspect the gear. Flare higher and more gradually.' : td.vsFpm > 300 ? 'Firm. Hold the flare longer and let it settle.' : 'Nice and smooth.');
    if (!onRunway) {
      ctx.result('Touchdown location', td.n < 0 ? 'short of the runway' : 'off the runway', 'fail', 'Plan the approach so the aiming point stays fixed in the windshield.');
    } else if (!opts.anywhere) {
      const dFt = td.n * FT;
      const aim = world.runway.aimN * FT;
      const st = dFt >= aim - 100 && dFt <= aim + 400 ? 'pass' : dFt >= aim - 400 && dFt <= aim + 900 ? 'marginal' : 'fail';
      ctx.result('Touchdown point', `${Math.round(dFt)} ft from threshold (target ${Math.round(aim)}–${Math.round(aim + 400)})`, st, dFt < aim - 100 ? 'Landed short of the specified point: aim further down or carry a little power.' : dFt > aim + 400 ? 'Floated long: too fast or too high on short final. Fly the PAPI and the numbers.' : 'Right in the box.');
    }
    const clFt = Math.abs(td.e * FT);
    ctx.result('Centreline at touchdown', `${clFt.toFixed(0)} ft off`, status(clFt, 10, 25), clFt > 10 ? 'Fly the centreline all the way: aileron for position, rudder for alignment.' : '');
    ctx.result('Drift at touchdown', `${Math.abs(td.driftKt).toFixed(1)} kt sideways`, status(Math.abs(td.driftKt), 2.5, 5), Math.abs(td.driftKt) > 2.5 ? 'Sideways motion side-loads the gear. Lower the upwind wing to stop drift.' : '');
    ctx.result('Alignment (crab) at touchdown', `${Math.abs(td.crabDeg).toFixed(1)}°`, status(Math.abs(td.crabDeg), 5, 10), Math.abs(td.crabDeg) > 5 ? 'Kick the crab out with rudder just before touchdown.' : '');
    ctx.result('Landing attitude', `${td.pitchDeg.toFixed(1)}° nose-${td.pitchDeg >= 0 ? 'up' : 'down'}, ${td.firstGear} first`, td.firstGear === 'mains' && td.pitchDeg > 0.5 ? 'pass' : td.firstGear === 'mains' ? 'marginal' : 'fail', td.firstGear === 'nose' ? 'Nosewheel first risks a porpoise or a collapsed nose gear. Flare: keep raising the nose as it settles.' : '');
  }

  // ------------------------------------------------------------------ common setups
  const FIELD = { fieldElevFt: 600, qnhInHg: 29.92, tempC: 15, windDir: 360, windKt: 0, gustKt: 0, turbulence: 0 };
  const TPA = 1600; // pattern altitude (MSL)
  const LOAD_NORMAL = { front: 340, rear: 0, baggage: 20, fuelGal: 40 };
  const LOAD_GROSS = { front: 340, rear: 340, baggage: 0, fuelGal: 40 };

  // ------------------------------------------------------------------ the curriculum
  const LESSONS = [
    // ============================================================ FUNDAMENTALS
    {
      id: 'forces',
      group: 'Fundamentals',
      title: 'The Four Forces',
      minutes: 6,
      summary: 'See lift, weight, thrust and drag live — and what happens when you unbalance them.',
      view: 'chase',
      aids: true,
      briefing: `
        <p><b>Every moment in flight is a tug-of-war between four forces.</b> Lift (up, perpendicular to the relative wind) fights weight (straight down toward the centre of the Earth). Thrust (along the crankshaft) fights drag (straight back along the relative wind).</p>
        <p class="analogy">Analogy: think of steady flight as a market in equilibrium. Lift and weight are the bid and ask that set the price — your altitude. Thrust and drag set the trend — your speed. While they balance, nothing changes (no acceleration — <i>not</i> no motion). Unbalance one side and the "price" moves until a new equilibrium is found.</p>
        <p><b>The lift equation</b>: L = ½ ρ V² S C<sub>L</sub>. ρ is air density, V is true airspeed, S is the wing area (170 ft²), and C<sub>L</sub> depends mostly on <b>angle of attack (AoA)</b>. The only thing the pilot controls directly is AoA, with the yoke. Slow down and you must increase AoA to keep lift equal to weight — until you reach the critical AoA (~17° here) and the wing stalls.</p>
        <p><b>Drag</b> has two parts: <i>parasite</i> drag (skin friction, the fixed landing gear — grows with V²) and <i>induced</i> drag (the price of making lift — grows as you slow down). Their sum is lowest at about 73 kt: the best glide speed.</p>
        <p>In this lesson you're in the chase view with the force vectors drawn on the airplane. Thrust and drag are drawn ×5 so you can see them: they really are about 1/10th of lift — that ratio (L/D) is why a 2,440 lb airplane flies on 160 hp.</p>`,
      setup: { air: { n: -9000, e: -2000, altFt: 3500, hdg: 360, ias: 100 }, weather: FIELD, loading: LOAD_NORMAL },
      steps: [
        { say: 'Level, unaccelerated flight: Lift ≈ Weight and Thrust ≈ Drag. Hands off — just watch the arrows and the numbers in the Forces panel.', done: (t, c) => c.stepTime > 7 },
        { say: 'Pull the throttle to idle (hold <kbd>S</kbd>). Thrust is now much smaller than drag — watch the airspeed.', done: (t) => t.throttle < 0.04, hold: 0.5 },
        {
          say: 'Hold altitude by easing back on the yoke (<kbd>↓</kbd>) or rolling in nose-up trim (<kbd>E</kbd>) as the speed decays. To keep Lift = Weight at a lower V, angle of attack must rise. Slow to 70 kt.',
          tip: 'Watch the AoA gauge climb as speed falls. Same lift, less speed → more angle.',
          targets: (c) => ({ alt: c.alt0, ias: 70 }),
          enter: (c) => (c.alt0 = c.t.altInd),
          grade: [G.alt((c) => c.alt0, 150, { grace: 3 })],
          done: (t) => t.ias < 71.5,
          hold: 0.5,
        },
        {
          say: 'Now lower the nose and hold <b>73 kt</b> — best glide. You\'re descending: gravity\'s component along the flight path has replaced thrust.',
          targets: { ias: 73 },
          done: (t) => near(t.ias, 73, 5) && t.vs < -250,
          hold: 5,
        },
        {
          say: 'Full power (hold <kbd>W</kbd>) and raise the nose to hold <b>79 kt</b> (Vy). Thrust now exceeds drag — the surplus becomes a climb. Keep the ball centred with right rudder (<kbd>D</kbd>).',
          targets: { ias: 79 },
          done: (t) => t.throttle > 0.9 && t.vs > 300 && near(t.ias, 79, 8),
          hold: 5,
        },
        {
          say: 'Level off: lower the nose, let the speed build toward 100 kt, then reduce power to about 2,300 RPM.',
          targets: { rpm: 2300 },
          done: (t) => Math.abs(t.vs) < 200 && t.throttle < 0.85 && t.ias > 85,
          hold: 4,
        },
        {
          say: 'Roll into a <b>45° bank</b> and pull to hold altitude. Lift tilts with the wings, so only its vertical part opposes weight — you need √2 = <b>1.41 G</b>. Watch the G-meter.',
          tip: 'The horizontal part of lift is what turns the airplane. That\'s the only "turning force" there is.',
          targets: (c) => ({ alt: c.alt0, bank: 45 }),
          enter: (c) => (c.alt0 = c.t.altInd),
          grade: [G.alt((c) => c.alt0, 150, { grace: 5 })],
          done: (t) => Math.abs(t.bank) > 38 && Math.abs(t.bank) < 55 && t.g > 1.25,
          hold: 5,
        },
        {
          say: 'Roll wings level. Now explore: try flaps (<kbd>F</kbd>/<kbd>V</kbd>), slow flight, a dive. Watch which forces change. Press <kbd>N</kbd> when you\'re done.',
          manual: true,
        },
      ],
    },

    {
      id: 'straight-level',
      group: 'Fundamentals',
      title: 'Straight-and-Level & Trim',
      minutes: 4,
      summary: 'Hold altitude, heading and airspeed — then change speed and re-trim.',
      briefing: `
        <p><b>Attitude flying:</b> Attitude + Power = Performance. Set a pitch attitude (where the cowling sits on the horizon), set a power (RPM), and the airplane settles into a predictable speed and climb/descent rate. Then <b>trim</b> it there.</p>
        <p class="analogy">Analogy: trim is a standing limit order. You set it once and the airplane keeps returning to that speed without you holding pressure. Holding the yoke instead of trimming is like manually babysitting every tick — tiring, and you'll make mistakes.</p>
        <p><b>Scan:</b> 90% of your attention outside on the horizon, quick glances inside: attitude indicator → altimeter → heading → airspeed → back outside. Small corrections, early.</p>
        <p><b>To slow down in level flight:</b> reduce power → the nose wants to drop → raise it gradually to hold altitude as speed decays → re-trim. <b>To speed up:</b> add power → lower the nose to stay level → re-trim nose-down.</p>
        <p><b>ACS standard:</b> altitude ±100 ft, heading ±10°, airspeed ±10 kt. Light turbulence is on, so you'll have to work for it.</p>`,
      setup: { air: { n: -6000, e: -6000, altFt: 3500, hdg: 90, ias: 100 }, weather: Object.assign({}, FIELD, { turbulence: 0.25, windDir: 300, windKt: 8 }), loading: LOAD_NORMAL },
      steps: [
        {
          say: 'Fly straight and level for 40 seconds: 3,500 ft, heading 090°, 100 kt. Pick a point on the horizon and keep the cowling still against it.',
          targets: { alt: 3500, hdg: 90, ias: 100 },
          grade: [G.alt(3500), G.hdg(90), G.ias(100)],
          done: (t, c) => c.stepTime > 40,
        },
        {
          say: 'Slow to <b>85 kt</b> holding altitude: reduce power to about 2,050 RPM, raise the nose as the speed bleeds off, then <b>re-trim</b> (<kbd>E</kbd> nose-up) until you can let go.',
          tip: 'Trim until the airplane holds the attitude with no keys pressed.',
          targets: { alt: 3500, hdg: 90, ias: 85, rpm: 2050 },
          grade: [G.alt(3500), G.hdg(90)],
          done: (t) => near(t.ias, 85, 4) && Math.abs(t.vs) < 200,
          hold: 6,
          timeout: 120,
        },
        {
          say: 'Hold 85 kt straight-and-level for 30 seconds — hands off as much as possible.',
          targets: { alt: 3500, hdg: 90, ias: 85 },
          grade: [G.alt(3500), G.hdg(90), G.ias(85)],
          done: (t, c) => c.stepTime > 30,
        },
        {
          say: 'Accelerate to <b>105 kt</b>: add power to about 2,450 RPM, lower the nose to stay level, re-trim nose-down (<kbd>Q</kbd>).',
          targets: { alt: 3500, hdg: 90, ias: 105, rpm: 2450 },
          grade: [G.alt(3500), G.hdg(90)],
          done: (t) => near(t.ias, 105, 4) && Math.abs(t.vs) < 200,
          hold: 5,
          timeout: 120,
        },
      ],
    },

    {
      id: 'climb-descent',
      group: 'Fundamentals',
      title: 'Climbs, Descents & Level-offs',
      minutes: 6,
      summary: 'Climb at Vy, level off on altitude, descend at 500 fpm and level off again.',
      briefing: `
        <p><b>Climbing is about excess power, not lift.</b> In a steady climb, lift is actually slightly <i>less</i> than weight; it's the surplus of thrust over drag that lifts you. Vy (79 kt) is the speed where that surplus power is greatest — the most altitude per minute. Vx (63 kt) gives the most altitude per distance (obstacles).</p>
        <p class="analogy">Analogy: altitude is your savings account, airspeed is your checking account, and the engine is your income. You can transfer between accounts (pitch up: trade speed for height), but only income (power) grows your total energy.</p>
        <p><b>Left-turning tendencies:</b> at full power and low speed the propeller slipstream spirals into the left side of the tail and the descending blade takes a bigger bite (P-factor). Both yaw the nose left. <b>Right rudder</b> keeps the ball centred in the climb.</p>
        <p><b>Level-off:</b> start leveling at 10% of your vertical speed before the target (700 fpm → ~70 ft early). Lower the nose to the cruise attitude, let it accelerate, <i>then</i> reduce power and trim. <b>Descents:</b> reduce power, hold the attitude for your target speed, trim.</p>
        <p><b>ACS:</b> airspeed ±10 kt, heading ±10°, level off ±100 ft.</p>`,
      setup: { air: { n: -9000, e: 4000, altFt: 3000, hdg: 360, ias: 100 }, weather: FIELD, loading: LOAD_NORMAL },
      steps: [
        {
          say: 'Climb at <b>Vy 79 kt</b> to <b>4,000 ft</b>: full throttle (<kbd>W</kbd>), raise the nose about 10°, trim nose-up. Right rudder to keep the ball centred.',
          targets: { alt: 4000, ias: 79, hdg: 360 },
          grade: [G.ias(79, 10, { grace: 12 }), G.hdg(360), G.ball(5, { grace: 6 })],
          done: (t) => t.altInd >= 3930,
          timeout: 240,
        },
        {
          say: 'Level off at <b>4,000 ft</b>: lower the nose, let the speed build to ~100 kt, reduce power to ~2,300 RPM, trim.',
          targets: { alt: 4000, ias: 100, hdg: 360, rpm: 2300 },
          grade: [G.alt(4000), G.hdg(360)],
          done: (t) => near(t.altInd, 4000, 70) && Math.abs(t.vs) < 150 && t.ias > 92,
          hold: 5,
          timeout: 120,
        },
        {
          say: 'Descend at <b>500 fpm, 90 kt</b> to <b>3,000 ft</b>: reduce power to ~1,900 RPM, lower the nose slightly, trim.',
          targets: { alt: 3000, ias: 90, vs: -500, rpm: 1900 },
          grade: [G.ias(90, 10, { grace: 10 }), G.vs(-500, 250, { grace: 15 }), G.hdg(360)],
          done: (t) => t.altInd <= 3060,
          timeout: 240,
        },
        {
          say: 'Level off at <b>3,000 ft</b>: start ~50 ft early, add power to ~2,300 RPM as you raise the nose, trim.',
          targets: { alt: 3000, hdg: 360, rpm: 2300 },
          grade: [G.alt(3000)],
          done: (t) => near(t.altInd, 3000, 60) && Math.abs(t.vs) < 150,
          hold: 6,
          timeout: 120,
        },
      ],
    },

    {
      id: 'turns',
      group: 'Fundamentals',
      title: 'Coordinated Turns',
      minutes: 4,
      summary: 'Medium-bank (30°) turns to headings with the ball centred.',
      briefing: `
        <p><b>What turns an airplane?</b> Not the rudder — the horizontal component of lift. Bank the wings and lift tilts; its sideways part pulls the airplane around a circle. Because only the vertical part now holds you up, you must add a little back pressure (more AoA) to hold altitude: about 1.15 G at 30°.</p>
        <p><b>Adverse yaw:</b> the aileron that goes down (on the rising wing) makes more lift <i>and more drag</i>, so the nose initially yaws away from the turn. Lead with rudder in the direction of the turn as you roll — "step on the ball". The turn coordinator's ball shows slip (ball to the inside of the turn → more rudder) or skid (ball outside → less rudder).</p>
        <p class="analogy">Analogy: a coordinated turn is like a cyclist leaning into a corner — the lean (bank) does the turning, the handlebars (rudder) just keep the wheel aligned with where the bike is going.</p>
        <p><b>Rollout lead:</b> start rolling out about half your bank angle before the target heading (30° bank → 15° early).</p>`,
      setup: { air: { n: -8000, e: 3000, altFt: 3500, hdg: 360, ias: 100 }, weather: FIELD, loading: LOAD_NORMAL },
      steps: [
        {
          say: 'Turn <b>left to 270°</b> with <b>30° of bank</b>. Roll in with left aileron <i>and</i> left rudder together, then add a little back pressure to hold 3,500 ft.',
          targets: { alt: 3500, hdg: 270, bank: 30 },
          grade: [G.alt(3500), G.bank(30, 7, { when: (t) => Math.abs(wrap180(t.hdg - 270)) > 20 && Math.abs(wrap180(t.hdg - 360)) > 15 }), G.ball(4, { grace: 2 })],
          done: (t) => hdgNear(t.hdg, 270, 18),
          timeout: 90,
        },
        {
          say: 'Roll out on <b>270°</b>: opposite aileron and rudder together, release the back pressure.',
          targets: { alt: 3500, hdg: 270 },
          grade: [G.alt(3500), G.ball(4)],
          done: (t) => hdgNear(t.hdg, 270, 10) && Math.abs(t.bank) < 5,
          hold: 3,
          timeout: 60,
          exit: (c, t) => c.result('Rollout heading 270°', `${Math.round(t.hdg)}°`, status(Math.abs(wrap180(t.hdg - 270)), 10, 20)),
        },
        {
          say: 'Now turn <b>right 180° to heading 090°</b> at 30° bank. Watch the ball as you roll in — right rudder with right aileron.',
          targets: { alt: 3500, hdg: 90, bank: 30 },
          grade: [G.alt(3500), G.bank(30, 7, { when: (t) => Math.abs(wrap180(t.hdg - 90)) > 20 && Math.abs(wrap180(t.hdg - 270)) > 15 }), G.ball(4, { grace: 2 })],
          done: (t) => hdgNear(t.hdg, 90, 18),
          timeout: 120,
        },
        {
          say: 'Roll out on <b>090°</b>.',
          targets: { alt: 3500, hdg: 90 },
          grade: [G.alt(3500), G.ball(4)],
          done: (t) => hdgNear(t.hdg, 90, 10) && Math.abs(t.bank) < 5,
          hold: 3,
          timeout: 60,
          exit: (c, t) => c.result('Rollout heading 090°', `${Math.round(t.hdg)}°`, status(Math.abs(wrap180(t.hdg - 90)), 10, 20)),
        },
      ],
    },

    // ============================================================ PERFORMANCE MANEUVERS
    {
      id: 'steep-turns',
      group: 'Performance Maneuvers',
      title: 'Steep Turns (ACS)',
      minutes: 5,
      summary: '360° turns at 45° of bank, left then right, within checkride tolerances.',
      briefing: `
        <p><b>Steep turns teach energy and load-factor management.</b> At 45° of bank you need 1.41 G to hold altitude, so the wing works 41% harder: higher AoA, more induced drag, and your stall speed rises by √1.41 = 19% (51 → 61 kt).</p>
        <p><b>Overbanking tendency:</b> in a steep turn the outside wing travels faster than the inside one and makes more lift, so the bank wants to keep increasing. Hold a little opposite aileron.</p>
        <p><b>Technique:</b> roll in smoothly; passing 30° add back pressure and about 100 RPM. Put the horizon at a fixed spot on the cowling and keep it there. If you lose altitude, <i>reduce bank first</i>, then pull — pulling harder at steep bank mostly tightens the turn.</p>
        <p class="analogy">Analogy: lift in a steep turn is like leverage — the more you tilt, the more gross exposure you need just to hold the same net position (altitude). And leverage raises your stall "margin call".</p>
        <p><b>ACS:</b> 45° ±5° bank, altitude ±100 ft, airspeed ±10 kt, roll out on the entry heading ±10°.</p>`,
      setup: { air: { n: -9000, e: -5000, altFt: 3500, hdg: 360, ias: 100 }, weather: FIELD, loading: LOAD_NORMAL },
      steps: (() => {
        const turn = (dir) => {
          const D = dir < 0 ? 'LEFT' : 'RIGHT';
          return [
            {
              say: `Roll into a <b>45° ${D}</b> bank. Passing 30°, add back pressure and ~100 RPM.`,
              targets: { alt: 3500, ias: 100, bank: 45, hdg: 360 },
              enter: (c) => {
                c.vars.prev = c.t.hdg;
                c.vars.turned = 0;
              },
              grade: [G.alt(3500, 100), G.ias(100, 10)],
              done: (t) => Math.abs(t.bank) > 40 && Math.sign(t.bank) === dir,
              hold: 0.5,
              timeout: 60,
            },
            {
              say: `Hold 45° through a full 360°. Start the rollout about 20° before heading 360°.`,
              targets: { alt: 3500, ias: 100, bank: 45, hdg: 360 },
              every: (t, c) => {
                c.vars.turned += Math.abs(wrap180(t.hdg - c.vars.prev));
                c.vars.prev = t.hdg;
              },
              grade: [G.alt(3500, 100), G.ias(100, 10), G.bank(45, 5, { grace: 2, when: (t, c) => c.vars.turned < 320 })],
              done: (t, c) => c.vars.turned > 335,
              timeout: 120,
            },
            {
              say: 'Roll out on <b>360°</b>, reduce power, relax the back pressure.',
              targets: { alt: 3500, ias: 100, hdg: 360 },
              grade: [G.alt(3500, 100)],
              done: (t) => Math.abs(t.bank) < 6,
              hold: 1,
              timeout: 40,
              exit: (c, t) => c.result(`Rollout heading (${D.toLowerCase()} turn)`, `${Math.round(t.hdg)}°`, status(Math.abs(wrap180(t.hdg - 360)), 10, 20)),
            },
          ];
        };
        return [...turn(-1), { say: 'Stabilise wings-level at 3,500 ft, 100 kt.', targets: { alt: 3500, ias: 100, hdg: 360 }, done: (t) => Math.abs(t.bank) < 4 && Math.abs(t.vs) < 200, hold: 3, timeout: 60 }, ...turn(1)];
      })(),
    },

    {
      id: 'slow-flight',
      group: 'Performance Maneuvers',
      title: 'Slow Flight',
      minutes: 6,
      summary: 'Fly controlled at the edge of the stall — on the back side of the power curve.',
      briefing: `
        <p><b>Slow flight is flying at a high angle of attack, just above the stall warning.</b> It's how the airplane feels in the flare and on a go-around, so you need to own it.</p>
        <p><b>The back side of the power curve:</b> below about 70 kt, induced drag grows faster than parasite drag falls, so flying <i>slower</i> takes <i>more</i> power. Here, pitch controls airspeed and power controls altitude. If you're sinking, pulling back just slows you down further (and adds drag) — add power instead.</p>
        <p class="analogy">Analogy: it's an illiquid market. Every input has a large, delayed effect and you can't get out fast. Small, early, deliberate corrections.</p>
        <p><b>Feel:</b> mushy controls (low dynamic pressure), big rudder needed for coordination at high power, AoA gauge near yellow.</p>
        <p><b>ACS:</b> altitude ±100 ft, heading ±10°, airspeed +10/−0 kt of the target (we allow −3), bank ±10°, no stall.</p>`,
      setup: { air: { n: -9000, e: 6000, altFt: 3500, hdg: 360, ias: 90 }, weather: FIELD, loading: LOAD_NORMAL },
      steps: [
        {
          say: 'Reduce power to about 1,500 RPM. Below 103 kt extend flaps in stages (<kbd>F</kbd>) to <b>40°</b>, raising the nose to hold altitude. Stabilise at <b>55 kt</b> with power.',
          tip: 'As the speed bleeds below ~65 kt, ADD power — you\'ll need around 2,100–2,200 RPM to stay level at 55 kt.',
          targets: { alt: 3500, hdg: 360, ias: 55 },
          grade: [G.alt(3500, 100), G.hdg(360)],
          done: (t) => near(t.ias, 57, 5) && t.flaps > 38 && Math.abs(t.vs) < 200,
          hold: 5,
          timeout: 150,
        },
        {
          say: 'Hold <b>55 kt</b>, 3,500 ft and heading 360° for 30 s. Pitch for airspeed, power for altitude.',
          targets: { alt: 3500, hdg: 360, ias: 55 },
          grade: [G.alt(3500, 100), G.hdg(360), G.ias(55, 0, { tolLo: 3, tolHi: 10 })],
          fail: (t) => (t.stalled ? 'Stalled during slow flight — lower the nose a touch and add power before the horn.' : null),
          done: (t, c) => c.stepTime > 30,
        },
        {
          say: 'Turn <b>left to 270°</b> with no more than 15° of bank, still at 55 kt and 3,500 ft. Stall speed rises in the turn — add a little power.',
          targets: { alt: 3500, hdg: 270, ias: 55, bank: 15 },
          grade: [G.alt(3500, 100), G.ias(55, 0, { tolLo: 3, tolHi: 10 }), G.bank(10, 10, { when: (t) => Math.abs(wrap180(t.hdg - 270)) > 15 })],
          fail: (t) => (t.stalled ? 'Stalled in the slow-flight turn.' : null),
          done: (t) => hdgNear(t.hdg, 270, 10) && Math.abs(t.bank) < 5,
          hold: 2,
          timeout: 120,
        },
        {
          say: 'Recover: <b>full power</b>, lower the nose to hold altitude, retract flaps in stages (<kbd>V</kbd>) as you accelerate past 60, 65, 70 kt. Then climb at Vy.',
          targets: { alt: 3500, ias: 79 },
          enter: (c) => (c.vars.minAlt = c.t.altInd),
          every: (t, c) => (c.vars.minAlt = Math.min(c.vars.minAlt, t.altInd)),
          done: (t) => t.flaps < 1 && t.ias > 72 && t.vs > 0,
          hold: 3,
          timeout: 90,
          exit: (c) => c.result('Altitude lost in recovery', `${Math.round(Math.max(0, 3500 - c.vars.minAlt))} ft`, status(3500 - c.vars.minAlt, 100, 200), 'Retract flaps gradually — dumping them all at once drops CLmax and you sink.'),
        },
      ],
    },

    {
      id: 'stall-power-off',
      group: 'Performance Maneuvers',
      title: 'Power-Off Stall (approach)',
      minutes: 4,
      summary: 'Stall the airplane in landing configuration and recover with minimum altitude loss.',
      briefing: `
        <p><b>A stall is an angle-of-attack event, not a speed event.</b> Above about 17° AoA (less with flaps) the airflow can no longer follow the curved upper wing surface; it separates, lift drops and drag soars. You can stall at any speed and any attitude — it just happens to occur at 51 kt clean (44 kt with full flaps) in 1-G flight.</p>
        <p class="analogy">Analogy: stall speed is like a price level for a stop-loss — it moves with conditions (weight, bank, load factor). The critical AoA is the real rule. Respect the rule, not the price.</p>
        <p><b>This one simulates an approach:</b> flaps 25°, idle, descending — then you raise the nose too far, as if trying to stretch a glide. Cues: stall horn (a lift detector on the left wing, ~5 kt early), mushy controls, buffet, then the nose drops ("the break").</p>
        <p><b>Recovery (in this order):</b> (1) <b>Reduce AoA</b> — yoke forward until the buffet/horn stops. (2) Level the wings with coordinated aileron and rudder. (3) <b>Full power</b>, right rudder. (4) Flaps to 10°, then up as you climb at Vy. Don't pull too hard on the way out — that's a secondary stall.</p>
        <p><b>ACS:</b> heading ±10° (wings level ±10° bank) going in; recover promptly after the full stall; no secondary stall.</p>`,
      setup: { air: { n: -9000, e: 8000, altFt: 3500, hdg: 360, ias: 70, flaps: 25, throttle: 0.0 }, weather: FIELD, loading: LOAD_NORMAL },
      steps: [
        {
          say: 'You\'re descending at idle, flaps 25°, 70 kt. Hold heading 360°. Smoothly raise the nose to a landing attitude and <b>keep raising it</b> until the airplane stalls. Listen for the horn.',
          targets: { hdg: 360 },
          grade: [G.hdg(360, 10), G.bank(0, 10)],
          done: (t) => t.stalled,
          hold: 0.25,
          timeout: 120,
        },
        {
          say: '<b>STALL! Recover:</b> yoke forward to reduce AoA → level wings → full power → right rudder → flaps up to 10° (<kbd>V</kbd>) → climb.',
          targets: { ias: 79 },
          enter: (c) => {
            c.vars.entryAlt = c.t.altInd;
            c.vars.minAlt = c.t.altInd;
            c.vars.restalls = 0;
            c.vars.wasStalled = true;
            c.vars.maxBank = 0;
            c.vars.t0 = c.lessonTime;
          },
          every: (t, c) => {
            c.vars.minAlt = Math.min(c.vars.minAlt, t.altInd);
            c.vars.maxBank = Math.max(c.vars.maxBank, Math.abs(t.bank));
            if (t.stalled && !c.vars.wasStalled) c.vars.restalls++;
            c.vars.wasStalled = t.stalled;
          },
          done: (t) => !t.stalled && t.throttle > 0.85 && t.vs > 150 && t.flaps <= 11,
          hold: 2,
          timeout: 60,
          exit: (c) => {
            const lost = c.vars.entryAlt - c.vars.minAlt;
            c.result('Altitude lost', `${Math.round(lost)} ft`, status(lost, 250, 400), lost > 250 ? 'Faster, smoother power + less pitch-down. Unload just enough to stop the stall.' : 'Efficient recovery.');
            c.result('Secondary stalls', String(c.vars.restalls), c.vars.restalls === 0 ? 'pass' : 'fail', c.vars.restalls ? 'You pulled back too early/hard and stalled again. Let the speed build first.' : '');
            c.result('Max bank in recovery', `${Math.round(c.vars.maxBank)}°`, status(c.vars.maxBank, 20, 35), c.vars.maxBank > 20 ? 'A wing dropped — keep the ball centred with rudder and use aileron gently at high AoA.' : '');
          },
        },
        {
          say: 'Clean up: flaps <b>0°</b>, climb at <b>Vy 79 kt</b>.',
          targets: { ias: 79 },
          done: (t) => t.flaps < 1 && near(t.ias, 79, 8) && t.vs > 200,
          hold: 4,
          timeout: 60,
        },
      ],
    },

    {
      id: 'stall-power-on',
      group: 'Performance Maneuvers',
      title: 'Power-On Stall (departure)',
      minutes: 4,
      summary: 'Stall at full power in a steep climb — and keep the ball centred.',
      briefing: `
        <p><b>Simulates a departure stall</b>: full power, too steep a climb (maybe trying to clear trees). With power on, the slipstream keeps the tail effective and the nose very high (~20°) before the stall. The left-turning tendencies are at their strongest: <b>lots of right rudder</b>.</p>
        <p><b>Why coordination matters:</b> if the airplane is yawing when it stalls, one wing stalls more deeply than the other and drops — the first step of a <b>spin</b>. Keep the ball centred and the wings stay level.</p>
        <p><b>Recovery:</b> reduce AoA (forward), level wings, power is already full, climb at Vy once the speed is back. ACS: heading ±10° (straight), bank ±10°, full stall then prompt recovery.</p>`,
      setup: { air: { n: -9000, e: -8000, altFt: 3500, hdg: 360, ias: 80 }, weather: FIELD, loading: LOAD_NORMAL },
      steps: [
        {
          say: 'Reduce power to idle and hold altitude while slowing to <b>60 kt</b> (lift-off speed).',
          targets: { alt: 3500, ias: 60, hdg: 360 },
          grade: [G.alt(3500, 100), G.hdg(360)],
          done: (t) => t.ias < 62,
          timeout: 90,
        },
        {
          say: 'Now <b>full power</b> and pitch up to ~20°. Keep pulling until it stalls. <b>Right rudder</b> — keep that ball centred!',
          targets: { hdg: 360 },
          grade: [G.hdg(360, 10, { grace: 2 }), G.ball(6, { grace: 2 }), G.bank(0, 10, { grace: 2 })],
          done: (t) => t.stalled && t.throttle > 0.8,
          hold: 0.25,
          timeout: 90,
        },
        {
          say: '<b>STALL! Recover:</b> yoke forward to break the stall, level the wings, keep full power, then climb at Vy 79 kt.',
          targets: { ias: 79 },
          enter: (c) => {
            c.vars.entryAlt = c.t.altInd;
            c.vars.minAlt = c.t.altInd;
            c.vars.maxBank = Math.abs(c.t.bank);
          },
          every: (t, c) => {
            c.vars.minAlt = Math.min(c.vars.minAlt, t.altInd);
            c.vars.maxBank = Math.max(c.vars.maxBank, Math.abs(t.bank));
          },
          done: (t) => !t.stalled && t.vs > 200 && t.ias > 68,
          hold: 3,
          timeout: 60,
          exit: (c) => {
            c.result('Altitude lost', `${Math.round(Math.max(0, c.vars.entryAlt - c.vars.minAlt))} ft`, status(c.vars.entryAlt - c.vars.minAlt, 150, 300));
            c.result('Wing drop (max bank)', `${Math.round(c.vars.maxBank)}°`, status(c.vars.maxBank, 15, 30), c.vars.maxBank > 15 ? 'Uncoordinated at the stall: one wing stalled first. More right rudder in the climb.' : 'Wings stayed level.');
          },
        },
      ],
    },

    {
      id: 'turns-point',
      group: 'Performance Maneuvers',
      title: 'Turns Around a Point',
      minutes: 6,
      summary: 'Fly a constant-radius circle around a silo in a 12-kt wind.',
      briefing: `
        <p><b>Ground reference maneuvers teach wind correction.</b> The airplane flies in the air mass; the air mass moves over the ground. To fly a perfect circle <i>over the ground</i>, you must vary your bank angle with your groundspeed.</p>
        <p><b>Rule:</b> the bank is steepest when your groundspeed is highest (downwind) and shallowest when it's lowest (upwind). At 90 kt in a 12-kt wind, groundspeed swings from 78 to 102 kt.</p>
        <p class="analogy">Analogy: it's like hedging a position whose delta keeps changing — the faster the underlying (groundspeed) moves, the more you have to adjust (bank) to stay neutral (on the circle).</p>
        <p><b>Setup:</b> wind from the west (270°) at 12 kt. You enter <b>downwind</b> (heading east) with the red barn &amp; silo on your left. Fly two left circles of about ¼ nm radius, at 1,000 ft AGL (1,600 ft MSL). Watch your ground track on the map.</p>
        <p><b>ACS:</b> altitude ±100 ft, airspeed ±10 kt; maintain a constant radius; don't exceed 45° of bank.</p>`,
      setup: { air: { n: -2600 - 420, e: 2600 - 1500, altFt: 1600, hdg: 90, ias: 90 }, weather: Object.assign({}, FIELD, { windDir: 270, windKt: 12, turbulence: 0.15 }), loading: LOAD_NORMAL, map: { circle: { n: -2600, e: 2600, r: 420 } } },
      steps: [
        {
          say: 'Fly east toward the <b>red barn &amp; silo</b> (it\'s ahead and slightly left). When it\'s directly off your left wing, roll into a left turn — steep, since you\'re downwind.',
          targets: { alt: 1600, ias: 90 },
          grade: [G.alt(1600), G.ias(90)],
          done: (t, c) => t.e > c.world.landmarks.silo.e - 30,
          timeout: 90,
        },
        {
          say: 'Circle the silo <b>twice</b> at a constant ¼-nm radius: steepest bank downwind, shallowest upwind. Hold 1,600 ft and 90 kt.',
          targets: { alt: 1600, ias: 90 },
          enter: (c) => {
            const s = c.world.landmarks.silo;
            c.vars.prevA = Math.atan2(c.t.e - s.e, c.t.n - s.n);
            c.vars.circled = 0;
          },
          every: (t, c) => {
            const s = c.world.landmarks.silo;
            const a = Math.atan2(t.e - s.e, t.n - s.n);
            c.vars.circled += Math.abs(M.wrapPi(a - c.vars.prevA)) * (180 / Math.PI);
            c.vars.prevA = a;
          },
          grade: [
            G.alt(1600),
            G.ias(90),
            { key: 'radius', label: 'Radius from silo', unit: 'm', get: (t, c) => Math.hypot(t.n - c.world.landmarks.silo.n, t.e - c.world.landmarks.silo.e), target: 420, tol: 120, grace: 8 },
            { key: 'bankmax', label: 'Bank ≤ 45°', unit: '°', get: (t) => Math.abs(t.bank), target: 22, tol: 23 },
          ],
          done: (t, c) => c.vars.circled >= 715,
          timeout: 300,
        },
        {
          say: 'Exit on the downwind heading (<b>090°</b>) and roll wings level.',
          targets: { alt: 1600, hdg: 90 },
          grade: [G.alt(1600)],
          done: (t) => hdgNear(t.hdg, 90, 15) && Math.abs(t.bank) < 6,
          hold: 2,
          timeout: 60,
        },
      ],
    },

    // ============================================================ TAKEOFFS & LANDINGS
    {
      id: 'takeoff',
      group: 'Takeoffs & Landings',
      title: 'Normal Takeoff & Climb',
      minutes: 3,
      summary: 'Take off from runway 36, rotate at 55 kt, climb at Vy to pattern altitude.',
      view: 'cockpit',
      briefing: `
        <p><b>The takeoff roll is a drag race between thrust and drag + rolling friction.</b> As speed builds, dynamic pressure builds, and at about 55 kt (Vr) the stabilator has enough authority to lift the nosewheel. A few knots later the wing reaches the lift it needs at ~10° pitch and you're flying — first in <b>ground effect</b>, which reduces induced drag while the wing is within about one wingspan of the runway.</p>
        <p><b>Keep it straight:</b> full power at low speed means maximum left-turning tendency. Right rudder from the moment you add power. The nosewheel is steered by the rudder pedals, so small inputs!</p>
        <p><b>Technique:</b> release brakes (<kbd>B</kbd>) → smoothly full throttle (hold <kbd>W</kbd>) → check RPM in the green, airspeed alive → centreline with rudder (<kbd>A</kbd>/<kbd>D</kbd>) → at 55 kt rotate with gentle back pressure (<kbd>↓</kbd>) to ~8–10° nose-up → lift off → accelerate to Vy 79 kt → trim → climb straight ahead.</p>
        <p><b>ACS:</b> stay on the centreline, lift off at the recommended speed, climb at Vy +10/−5 kt, maintain runway heading.</p>`,
      setup: { ground: { n: 15, e: 0, hdg: 360 }, weather: Object.assign({}, FIELD, { windDir: 340, windKt: 6 }), loading: LOAD_NORMAL },
      steps: [
        {
          say: 'Release the parking brake (<kbd>B</kbd>) and smoothly apply <b>full power</b> (hold <kbd>W</kbd>). Keep the centreline with rudder (<kbd>A</kbd>/<kbd>D</kbd>).',
          targets: { ias: 55 },
          enter: (c) => (c.vars.startN = c.t.n),
          done: (t) => !t.parkingBrake && t.throttle > 0.9 && t.gs > 15,
          timeout: 60,
        },
        {
          say: 'Airspeed alive. RPM ~2,300. At <b>55 kt rotate</b>: gentle back pressure (<kbd>↓</kbd>) to ~8° nose-up. Let it fly off.',
          targets: { ias: 55 },
          grade: [G.centerline(20, { when: (t) => t.onGround })],
          every: (t, c) => {
            for (const ev of c.events) if (ev.type === 'liftoff') c.vars.liftoff = { n: ev.data.n, ias: ev.data.ias };
          },
          done: (t) => !t.onGround && t.agl > 15,
          timeout: 90,
          exit: (c) => {
            const lo = c.vars.liftoff;
            if (lo) {
              c.result('Lift-off speed', `${Math.round(lo.ias)} KIAS`, lo.ias >= 50 && lo.ias <= 70 ? 'pass' : 'marginal', lo.ias < 50 ? 'Pulled it off too early — it\'s flying in ground effect only. Risky.' : '');
              c.result('Ground roll', `${Math.round((lo.n - c.vars.startN) * FT)} ft`, 'info', 'POH: about 975–1,150 ft at gross weight, sea level.');
            }
          },
        },
        {
          say: 'Climb at <b>Vy 79 kt</b>, straight out along the runway heading (360°). Trim, right rudder for the ball. Climb to <b>1,000 ft AGL</b> (1,600 MSL).',
          targets: { ias: 79, hdg: 360, alt: 1600 },
          grade: [G.ias(79, 0, { tolLo: 5, tolHi: 10, grace: 8 }), G.hdg(360, 10), G.ball(5, { grace: 3 })],
          done: (t) => t.altInd >= 1580,
          timeout: 240,
        },
      ],
    },

    {
      id: 'pattern',
      group: 'Takeoffs & Landings',
      title: 'Traffic Pattern & Normal Landing',
      minutes: 6,
      summary: 'Downwind → base → final → flare → touchdown on the 1,000-ft markers.',
      briefing: `
        <p><b>The traffic pattern is a rectangle that makes every landing the same.</b> You're joining on the <b>downwind</b> leg at 1,000 ft AGL, about ¾ nm west of runway 36, flying south. Left traffic.</p>
        <ol>
          <li><b>Downwind:</b> 1,000 ft AGL, 90 kt. Look left (<kbd>1</kbd>) to see the runway.</li>
          <li><b>Abeam the numbers:</b> power to ~1,600 RPM, hold altitude until below 103 kt, flaps 10°, start a 500 fpm descent at 80 kt.</li>
          <li><b>Base</b> (when the runway threshold is 45° behind your left wing): turn left to 090°, flaps 25°, 75 kt.</li>
          <li><b>Final:</b> turn left to 360°, line up, flaps 40°, <b>66 kt</b>. <b>PAPI</b> (4 lights left of the runway): 2 white + 2 red = on the 3° glidepath. More white = high, more red = low.</li>
          <li><b>Flare:</b> over the runway at ~10–15 ft, idle power, and gradually raise the nose to stop the descent. Keep raising it as it sinks — hold the nosewheel off. Touch down on the mains.</li>
        </ol>
        <p><b>Aim point:</b> the spot on the runway that doesn't move in your windshield is where you're going. Use pitch to put it on the 1,000-ft markers and power to hold your speed.</p>
        <p class="analogy">Analogy: a stabilized approach is a pre-defined trade plan — speed, path and configuration are all set before you're committed. If any parameter is out at 300 ft, go around (full power, flaps to 25°, climb) — the equivalent of "no setup, no trade".</p>
        <p><b>ACS:</b> stabilized approach at the recommended speed +10/−5 kt; touch down within 400 ft beyond the specified point (the 1,000-ft markers), on the centreline, no drift, longitudinal axis aligned.</p>
        <p><i>Tip:</i> press <kbd>H</kbd> to show the flight-path marker — the green circle shows where you're going.</p>`,
      setup: { air: { n: 700, e: -1350, altFt: TPA, hdg: 180, ias: 90 }, weather: Object.assign({}, FIELD, { windDir: 10, windKt: 6 }), loading: LOAD_NORMAL, map: { pattern: true } },
      steps: [
        {
          say: 'Downwind: hold <b>1,600 ft</b> (1,000 AGL) and <b>90 kt</b>, parallel to the runway. Look left with <kbd>1</kbd> (back with <kbd>3</kbd>).',
          targets: { alt: TPA, ias: 90, hdg: 180 },
          grade: [G.alt(TPA, 100), G.ias(90, 10)],
          done: (t) => t.n < 0,
          timeout: 120,
        },
        {
          say: '<b>Abeam the numbers</b>: power to ~1,600 RPM. Below 103 kt, flaps <b>10°</b> (<kbd>F</kbd>). Descend at <b>80 kt</b>, about 500 fpm.',
          targets: { ias: 80, rpm: 1600, vs: -500 },
          grade: [G.ias(80, 10, { grace: 12 })],
          done: (t) => -t.n > Math.abs(t.e) * 0.85,
          timeout: 120,
          exit: (c, t) => c.result('Flaps 10° by base', `${Math.round(t.flaps)}°`, t.flaps >= 9 ? 'pass' : 'marginal'),
        },
        {
          say: 'Turn <b>base</b>: left to <b>090°</b>. Flaps <b>25°</b>, <b>75 kt</b>, keep descending. Watch the runway out the left window.',
          targets: { ias: 75, hdg: 90 },
          grade: [G.ias(75, 10, { grace: 8 })],
          done: (t) => t.e > -380 && hdgNear(t.hdg, 90, 50),
          timeout: 150,
        },
        {
          say: 'Turn <b>final</b>: left to <b>360°</b> and line up on the centreline. Flaps <b>40°</b>, <b>66 kt</b>. PAPI: two white, two red.',
          tip: 'Pitch puts the aim point on the 1,000-ft markers; power holds 66 kt. Small corrections.',
          targets: { ias: 66, hdg: 360 },
          grade: [
            G.ias(66, 0, { tolLo: 5, tolHi: 10, label: 'Approach speed', when: (t) => t.agl < 500 && t.agl > 40 && hdgNear(t.hdg, 360, 30) }),
            G.centerline(40, { label: 'Final-approach alignment', when: (t) => t.agl < 400 && t.agl > 20 && t.n > -2000 }),
          ],
          done: (t, c) => c.events.some((e) => e.type === 'touchdown'),
          timeout: 240,
          exit: (c) => c.ac.touchdown && gradeLanding(c, c.ac.touchdown),
        },
        {
          say: 'Hold the nose up as you slow, then lower the nosewheel gently. Brake (<kbd>Space</kbd>) to a stop on the centreline.',
          every: (t, c) => {
            for (const e of c.events) if (e.type === 'liftoff') c.vars.bounced = true;
          },
          done: (t) => t.onGround && t.gs < 3,
          hold: 1,
          timeout: 90,
          exit: (c) => c.result('Bounce', c.vars.bounced ? 'yes' : 'none', c.vars.bounced ? 'fail' : 'pass', c.vars.bounced ? 'You touched down and flew again. Usually too fast, or pulling up sharply on contact. Hold the attitude after touchdown.' : ''),
        },
      ],
    },

    {
      id: 'xwind-takeoff',
      group: 'Takeoffs & Landings',
      title: 'Crosswind Takeoff',
      minutes: 3,
      summary: 'Ailerons into the wind, rudder for the centreline, crab after lift-off.',
      briefing: `
        <p><b>A crosswind tries to do two things:</b> weathervane the nose into the wind (the big vertical tail acts like a weathervane), and lift the upwind wing / push you sideways.</p>
        <p><b>Technique:</b> start the roll with <b>full aileron into the wind</b> (wind from the left → left aileron, <kbd>←</kbd>). As speed builds and the ailerons become effective, ease it off progressively, keeping the wings level. Rudder holds the centreline (you'll need right rudder against the weathervaning). Rotate a little firmer, so you lift off cleanly without skipping sideways. After lift-off, turn slightly into the wind (<b>crab</b>) to track the extended centreline.</p>
        <p class="analogy">Analogy: a crosswind is a constant bias in your data. You don't ignore it and you don't overreact — you apply a steady, measured correction and keep checking that the result (your track) is where it should be.</p>
        <p>Today: wind <b>300° at 12 kt</b> — a 10-kt crosswind from the left on runway 36 (PA-28 demonstrated max: 17 kt).</p>`,
      setup: { ground: { n: 15, e: 0, hdg: 360 }, weather: Object.assign({}, FIELD, { windDir: 300, windKt: 12, turbulence: 0.15 }), loading: LOAD_NORMAL, map: {} },
      steps: [
        {
          say: 'Full <b>left aileron</b> (into the wind, hold <kbd>←</kbd>), release the brake (<kbd>B</kbd>), full power. Rudder for the centreline.',
          enter: (c) => (c.vars.startN = c.t.n),
          done: (t) => !t.parkingBrake && t.throttle > 0.9 && t.gs > 15,
          timeout: 60,
        },
        {
          say: 'Ease the aileron as you accelerate, keeping the wings level. Rotate at <b>55 kt</b>.',
          grade: [G.centerline(20, { when: (t) => t.onGround }), { key: 'wings', label: 'Wings level on the roll', unit: '°', get: (t) => t.bank, target: 0, tol: 5, when: (t) => t.onGround }],
          done: (t) => !t.onGround && t.agl > 15,
          timeout: 90,
        },
        {
          say: 'Crab into the wind (a little left of 360°) to track the extended centreline. Climb at Vy to <b>1,100 ft MSL</b>.',
          targets: { ias: 79 },
          grade: [{ key: 'track', label: 'Track over extended centreline', unit: 'ft', get: (t) => t.e * FT, target: 0, tol: 150, grace: 5 }, G.ias(79, 0, { tolLo: 5, tolHi: 10, grace: 6 })],
          done: (t) => t.altInd > 1100,
          timeout: 180,
        },
      ],
    },

    {
      id: 'xwind-landing',
      group: 'Takeoffs & Landings',
      title: 'Crosswind Approach & Landing',
      minutes: 4,
      summary: 'Crab on final, then sideslip (wing-low) to a touchdown with no drift.',
      briefing: `
        <p><b>Two ways to handle crosswind on final:</b></p>
        <ul>
          <li><b>Crab:</b> point the nose into the wind so the airplane's sideways drift is cancelled. Comfortable and coordinated, but the nose isn't aligned with the runway — landing in a crab side-loads the gear.</li>
          <li><b>Sideslip (wing-low):</b> bank into the wind with aileron (to stop the drift) and use <i>opposite</i> rudder to keep the nose straight down the runway. Ball will be off-centre — that's intentional.</li>
        </ul>
        <p><b>Technique:</b> crab on final; by short final (~200 ft) transition to a sideslip; touch down on the <b>upwind main wheel first</b>; keep adding aileron into the wind as you slow on the rollout.</p>
        <p>Today: wind <b>310° at 12 kt</b> — about 9 kt of crosswind from the left. You start on a 1.6-nm final, flaps 25°, 70 kt.</p>
        <p><b>ACS:</b> touch down with no drift and the longitudinal axis aligned with the runway, on the centreline.</p>`,
      setup: { air: { n: -2950, e: 0, altFt: 600 + 520, hdg: 360, ias: 70, flaps: 25, gammaDeg: -3 }, weather: Object.assign({}, FIELD, { windDir: 310, windKt: 12, turbulence: 0.2 }), loading: LOAD_NORMAL, map: {} },
      steps: [
        {
          say: '<b>Crab</b>: turn a few degrees left, into the wind, until you stop drifting and track the centreline. Flaps <b>40°</b> (<kbd>F</kbd>), <b>66 kt</b>.',
          targets: { ias: 66 },
          grade: [G.centerline(60, { grace: 15, label: 'Tracking centreline' }), G.ias(66, 0, { tolLo: 5, tolHi: 10, grace: 10 })],
          done: (t) => t.agl < 220,
          timeout: 200,
        },
        {
          say: 'Switch to a <b>sideslip</b>: lower the left wing (<kbd>←</kbd>) and use right rudder (<kbd>D</kbd>) to line the nose up with the runway. Flare and touch down on the <b>left wheel first</b>.',
          targets: { ias: 66, hdg: 360 },
          grade: [G.centerline(30, { label: 'Short-final alignment', when: (t) => !t.onGround })],
          done: (t, c) => c.events.some((e) => e.type === 'touchdown'),
          timeout: 120,
          exit: (c) => c.ac.touchdown && gradeLanding(c, c.ac.touchdown),
        },
        {
          say: 'Rollout: keep <b>full left aileron</b> as you slow, rudder for the centreline, brake to a stop.',
          done: (t) => t.onGround && t.gs < 3,
          hold: 1,
          timeout: 90,
        },
      ],
    },

    {
      id: 'forward-slip',
      group: 'Takeoffs & Landings',
      title: 'Forward Slip to Landing',
      minutes: 3,
      summary: 'Way too high on final? Slip to lose altitude without gaining speed.',
      briefing: `
        <p><b>A forward slip deliberately flies the airplane sideways through the air.</b> The fuselage presents its whole side to the relative wind, drag shoots up, and you descend steeply <i>without</i> picking up speed. It's the classic tool when you're high on final (especially without flaps, or with an engine failure).</p>
        <p><b>Technique:</b> idle power. Lower one wing with aileron and apply <i>full opposite</i> rudder so the nose swings away from the low wing — your track stays straight down the runway. Lower the nose slightly to hold your approach speed. The ASI reads a few knots low in a slip (the pitot tube isn't pointing into the relative wind).</p>
        <p><b>Watch the dihedral:</b> sideslip makes the airplane want to roll <i>away</i> from the rudder (that's the wing's dihedral at work). In a full-rudder slip you'll need about two-thirds of the opposite aileron. If the bank keeps creeping the wrong way, add aileron or ease off the rudder — a half-hearted slip with full rudder can roll into a spiral.</p>
        <p><b>Recover</b> before the flare: wings level, rudder neutral, smoothly — then land normally.</p>
        <p>You're 1 nm out, <b>~600 ft too high</b>, flaps 40°, idle.</p>`,
      setup: { air: { n: -1850, e: 0, altFt: 600 + 900, hdg: 360, ias: 68, flaps: 40, throttle: 0 }, weather: FIELD, loading: LOAD_NORMAL, map: {} },
      steps: [
        {
          say: 'Way too high! Idle power. <b>Slip</b>: left wing down (<kbd>←</kbd>) and <b>full right rudder</b> (<kbd>D</kbd>). Lower the nose to hold ~68 kt. Watch the VSI.',
          targets: { ias: 68 },
          done: (t) => Math.abs(t.beta) > 7 && t.vs < -850,
          hold: 3,
          timeout: 60,
        },
        {
          say: 'Good — that\'s a steep descent with no speed gain. Keep slipping until you\'re back on the PAPI (2 white / 2 red), then <b>straighten out</b> before 100 ft and land.',
          targets: { ias: 66 },
          done: (t, c) => c.events.some((e) => e.type === 'touchdown'),
          timeout: 120,
          exit: (c) => c.ac.touchdown && gradeLanding(c, c.ac.touchdown, { anywhere: false }),
        },
        { say: 'Brake to a stop.', done: (t) => t.onGround && t.gs < 3, hold: 1, timeout: 90 },
      ],
    },

    // ============================================================ EMERGENCIES
    {
      id: 'engine-failure',
      group: 'Emergencies',
      title: 'Engine Failure & Glide',
      minutes: 5,
      summary: 'The engine quits at 3,000 ft. Best glide, pick the runway, land.',
      briefing: `
        <p><b>When the engine quits, you become a glider.</b> Your only energy source is altitude, and the best exchange rate is at <b>best glide speed: 73 kt</b> — the speed of maximum L/D (≈10:1 here, about 1.6 nm per 1,000 ft).</p>
        <p class="analogy">Analogy: altitude is your remaining capital and there's no more income. Best glide is the trade that maximizes distance per dollar spent. Flying faster <i>or</i> slower than 73 kt burns capital faster per mile.</p>
        <p><b>ABC:</b> <b>A</b>irspeed — pitch for 73 kt immediately and trim (the speed will bleed off fast). <b>B</b>est place to land — the airport is ahead-left. <b>C</b>hecklist — (fuel selector, mixture, mag, carb heat — not modelled, but say them!).</p>
        <p><b>Plan:</b> get over the field high and fly a modified pattern. Too high? S-turns, flaps, or a slip. Too low? You can't stretch a glide by pulling — you'll just stall. Pick a closer spot.</p>
        <p>A dead engine's windmilling propeller adds drag; there's nothing you can do about it in a PA-28.</p>`,
      setup: { air: { n: -4200, e: 1800, altFt: 3600, hdg: 360, ias: 100 }, weather: Object.assign({}, FIELD, { windDir: 360, windKt: 5 }), loading: LOAD_NORMAL, map: { pattern: true } },
      steps: [
        { say: 'Cruising at 3,600 ft, 3 nm south of the airport. Straight and level...', targets: { alt: 3600, ias: 100 }, done: (t, c) => c.stepTime > 6 },
        {
          say: '<b>ENGINE FAILURE!</b> Pitch for <b>73 kt</b> now and trim nose-up (<kbd>E</kbd>). The airport is ahead to the left — turn toward it.',
          targets: { ias: 73 },
          enter: (c) => {
            c.ac.engineFailed = true;
            c.sim && c.sim.toast && c.sim.toast('Engine failure!', 'bad');
          },
          grade: [G.ias(73, 0, { tolLo: 5, tolHi: 10, grace: 8, label: 'Best glide speed' })],
          done: (t) => near(t.ias, 73, 6),
          hold: 5,
          timeout: 40,
        },
        {
          say: 'Glide to the field. Plan to land on runway <b>36</b> (or 18). Arrive high — you can always lose altitude with flaps or a slip, but you can\'t gain it back.',
          targets: { ias: 73 },
          grade: [G.ias(73, 0, { tolLo: 5, tolHi: 10, label: 'Best glide speed', when: (t) => t.agl > 500 && t.flaps < 1 })],
          done: (t, c) => c.events.some((e) => e.type === 'touchdown'),
          timeout: 600,
          exit: (c) => {
            const td = c.ac.touchdown;
            if (!td) return;
            const L = c.world.runway.length;
            const onRwy = td.n >= 0 && td.n <= L && Math.abs(td.e) <= c.world.runway.width / 2;
            const onField = td.n > -400 && td.n < L + 400 && td.e > -260 && td.e < 300;
            c.result('Landing site', onRwy ? 'On the runway' : onField ? 'On the airport (grass)' : 'Off-airport field', onRwy ? 'pass' : onField ? 'marginal' : 'fail', onRwy ? 'Textbook. That\'s the whole game.' : 'Survivable, but plan to arrive higher over the field.');
            c.result('Touchdown sink rate', `${Math.round(td.vsFpm)} fpm`, status(td.vsFpm, 400, 650));
          },
        },
        { say: 'Brake to a stop.', done: (t) => t.onGround && t.gs < 3, hold: 1, timeout: 90 },
      ],
    },

    // ============================================================ PERFORMANCE & ENVIRONMENT
    {
      id: 'density-altitude',
      group: 'Performance & Environment',
      title: 'Hot & High: Density Altitude',
      minutes: 4,
      summary: 'Take off from a 5,500-ft field at 35 °C at gross weight. Feel the difference.',
      briefing: `
        <p><b>Density altitude is the altitude the airplane <i>feels</i>.</b> Hot air and high elevation mean thin air: the wing needs more true airspeed for the same lift, the propeller bites less air, and a normally-aspirated engine makes less power. All three hurt at once.</p>
        <p>Today: field elevation <b>5,500 ft</b>, <b>35 °C</b>, standard pressure — density altitude about <b>9,400 ft</b>. Max gross weight. The runway is 3,500 ft long.</p>
        <p><b>What to expect:</b> your indicated airspeed still reads 55 kt at rotation (the wing doesn't care), but your <i>true</i> airspeed and groundspeed are ~17% higher, so the ground roll is roughly double, and the climb rate is about half. In the real airplane you'd also lean the mixture for best power before takeoff.</p>
        <p class="analogy">Analogy: same strategy, worse market conditions — thinner liquidity means bigger slippage. Your sea-level numbers no longer apply; check the performance charts (the POH) before you trade... er, take off.</p>
        <p>Watch the TAS readout in the airspeed indicator and the ground-roll result at the end.</p>`,
      setup: { ground: { n: 15, e: 0, hdg: 360 }, weather: { fieldElevFt: 5500, qnhInHg: 29.92, tempC: 35, windDir: 360, windKt: 0, gustKt: 0, turbulence: 0 }, loading: LOAD_GROSS },
      steps: [
        {
          say: 'Release the brake (<kbd>B</kbd>), full power, keep the centreline. Note how slowly the airspeed comes alive.',
          enter: (c) => (c.vars.startN = c.t.n),
          done: (t) => !t.parkingBrake && t.throttle > 0.9 && t.gs > 10,
          timeout: 60,
        },
        {
          say: 'Rotate at <b>55 KIAS</b> (indicated is still what the wing feels). Don\'t pull it off early!',
          every: (t, c) => {
            for (const ev of c.events) if (ev.type === 'liftoff') c.vars.liftoff = { n: ev.data.n, ias: ev.data.ias };
          },
          done: (t) => !t.onGround && t.agl > 15,
          timeout: 120,
          exit: (c) => {
            const lo = c.vars.liftoff;
            if (lo) {
              const roll = (lo.n - c.vars.startN) * FT;
              c.result('Ground roll', `${Math.round(roll)} ft`, 'info', `Same airplane at sea level, standard day: about 1,300 ft. Thin air cost you ${Math.round((roll / 1300 - 1) * 100)}%.`);
            }
          },
        },
        {
          say: 'Climb at <b>Vy 79 kt</b>. Watch the VSI: it\'s about half of what you\'d see at sea level. Climb to 500 ft AGL.',
          targets: { ias: 79 },
          enter: (c) => {
            c.vars.t0 = c.lessonTime;
            c.vars.a0 = c.t.altInd;
          },
          grade: [G.ias(79, 0, { tolLo: 5, tolHi: 10, grace: 8 })],
          done: (t) => t.agl > 500,
          timeout: 240,
          exit: (c, t) => {
            const fpm = ((t.altInd - c.vars.a0) / Math.max(1, c.lessonTime - c.vars.t0)) * 60;
            c.result('Average climb rate', `${Math.round(fpm)} fpm`, 'info', 'Sea level: ~700 fpm. Density altitude ate roughly half your climb performance.');
          },
        },
      ],
    },

    {
      id: 'weight-balance',
      group: 'Performance & Environment',
      title: 'Weight & Balance Lab',
      minutes: 5,
      summary: 'Fly the same airplane at an aft CG and a forward CG and feel the difference.',
      briefing: `
        <p><b>Where the weight sits matters as much as how much there is.</b> The centre of gravity (CG) must sit ahead of the airplane's <i>neutral point</i> for it to be stable in pitch: disturb it nose-up, and the tail pushes it back. The distance between CG and neutral point is the <b>static margin</b> — the airplane's "stability budget".</p>
        <ul>
          <li><b>Aft CG:</b> small static margin → light, twitchy pitch control, slow to settle after a disturbance, easier to over-control and to stall. Beyond the aft limit it can become uncontrollable. Slightly faster cruise (less tail download).</li>
          <li><b>Forward CG:</b> large static margin → heavy stick, very stable, needs more elevator to flare (you may run out of up-elevator in the flare), higher stall speed.</li>
        </ul>
        <p class="analogy">Analogy: static margin is like a strategy's margin of safety. Big margin = robust but sluggish to adapt. Small margin = nimble but one bad tick (gust) can run away from you.</p>
        <p>You'll start at an <b>aft CG (~92 in, limit 93)</b>, then switch to a <b>forward CG (~86 in)</b>. Use the <b>Weight &amp; Balance</b> page in the menu to build your own loads.</p>`,
      setup: { air: { n: -9000, e: -3000, altFt: 3500, hdg: 360, ias: 100 }, weather: FIELD, loading: { front: 340, rear: 250, baggage: 120, fuelGal: 30 } },
      steps: [
        {
          say: () => 'AFT CG. Pull back sharply for about one second (<kbd>↓</kbd>), then <b>let go completely</b>. Watch how the pitch and airspeed oscillate and how long they take to settle. Press <kbd>N</kbd> when you\'ve seen it.',
          manual: true,
        },
        {
          say: 'Now the same airplane at a <b>FORWARD CG</b> (re-trimmed for you). Repeat: pull sharply for one second, let go. Notice the heavier response and quicker return. Press <kbd>N</kbd> when done.',
          enter: (c) => {
            c.sim.reloadInAir({ front: 400, rear: 0, baggage: 0, fuelGal: 20 });
          },
          manual: true,
        },
        {
          say: 'Forward CG, slow down: idle power, flaps 40°, and try to hold the nose up as the speed decays. You\'ll find the stall comes at a slightly higher speed, and you need much more aft yoke. Press <kbd>N</kbd> to finish.',
          manual: true,
        },
      ],
    },

    // ============================================================ FREE FLIGHT
    {
      id: 'free-runway',
      group: 'Free Flight',
      title: 'Free Flight — on the runway',
      minutes: 0,
      free: true,
      summary: 'Engine running on runway 36. Uses your Weather and Weight & Balance settings.',
      briefing: '<p>No instructor, no grading. Weather and loading come from the menu settings. Press <kbd>Esc</kbd> for the menu at any time.</p>',
      setup: { ground: { n: 15, e: 0, hdg: 360 }, useSettings: true, map: { pattern: true } },
      steps: [{ say: 'Free flight. Have fun — and fly the airplane first.', manual: true }],
    },
    {
      id: 'free-air',
      group: 'Free Flight',
      title: 'Free Flight — in the air',
      minutes: 0,
      free: true,
      summary: 'Trimmed at 3,500 ft, 100 kt, 5 nm south of the airport.',
      briefing: '<p>No instructor, no grading. Weather and loading come from the menu settings.</p>',
      setup: { air: { n: -9000, e: 0, altFt: 3500, hdg: 360, ias: 100 }, useSettings: true, map: { pattern: true } },
      steps: [{ say: 'Free flight. The airport is straight ahead, 5 nm.', manual: true }],
    },
    {
      id: 'free-pattern',
      group: 'Free Flight',
      title: 'Free Flight — touch-and-goes',
      minutes: 0,
      free: true,
      summary: 'Joining the downwind at pattern altitude. Practice landings over and over.',
      briefing: '<p>Fly the pattern as many times as you like. Each touchdown is scored in a toast message. Press <kbd>R</kbd> to restart on downwind.</p>',
      setup: { air: { n: 700, e: -1350, altFt: TPA, hdg: 180, ias: 90 }, useSettings: true, map: { pattern: true } },
      steps: [{ say: 'Pattern practice: downwind at 1,600 ft MSL, 90 kt. Left traffic, runway 36.', manual: true }],
    },
  ];

  // ------------------------------------------------------------------ the instructor
  class LessonRunner {
    constructor(lesson, ac, world, sim) {
      this.lesson = lesson;
      this.ac = ac;
      this.world = world;
      this.sim = sim;
      this.i = 0;
      this.stats = {};
      this.results = [];
      this.done = false;
      this.failReason = null;
      this.ctx = {
        ac,
        world,
        sim,
        vars: {},
        stepTime: 0,
        lessonTime: 0,
        events: [],
        t: null,
        result: (label, value, st, note) => this.results.push({ label, value, status: st, note: note || '' }),
      };
      this.hold = 0;
      this.manualAck = false;
      this.log = [];
    }

    get step() {
      return this.lesson.steps[this.i];
    }

    text(s) {
      const st = s || this.step;
      if (!st) return '';
      return typeof st.say === 'function' ? st.say(this.ctx) : st.say;
    }

    targets() {
      const st = this.step;
      if (!st || !st.targets) return null;
      return typeof st.targets === 'function' ? st.targets(this.ctx) : st.targets;
    }

    start(t) {
      this.ctx.t = t;
      this.enterStep();
    }

    enterStep() {
      const st = this.step;
      this.ctx.stepTime = 0;
      this.hold = 0;
      this.manualAck = false;
      if (st && st.enter) st.enter(this.ctx);
      if (this.onStep) this.onStep(this.i, st);
    }

    ack() {
      this.manualAck = true;
    }

    skip() {
      this.next(true);
    }

    next(skipped) {
      const st = this.step;
      if (st && st.exit && !skipped) st.exit(this.ctx, this.ctx.t);
      if (skipped) this.results.push({ label: `Step ${this.i + 1} skipped`, value: '', status: 'marginal', note: 'Skipped by pilot' });
      this.i++;
      if (this.i >= this.lesson.steps.length) this.finish();
      else this.enterStep();
    }

    finish(reason) {
      if (this.done) return;
      this.done = true;
      if (reason) this.failReason = reason;
      if (this.onFinish) this.onFinish(this.debrief());
    }

    update(t, dt, events) {
      if (this.done) return;
      const c = this.ctx;
      c.t = t;
      c.events = events || [];
      c.stepTime += dt;
      c.lessonTime += dt;
      for (const ev of c.events) if (ev.type === 'crash') return this.finish(`CRASH — ${ev.reason}`);
      const st = this.step;
      if (!st) return;
      if (st.every) st.every(t, c);
      // grading
      if (st.grade) {
        for (const g of st.grade) {
          if (g.grace && c.stepTime < g.grace) continue;
          if (g.when && !g.when(t, c)) continue;
          const target = typeof g.target === 'function' ? g.target(c) : g.target;
          const v = g.get(t, c);
          const dev = g.wrap ? wrap180(v - target) : v - target;
          const lo = g.tolLo !== undefined ? g.tolLo : g.tol;
          const hi = g.tolHi !== undefined ? g.tolHi : g.tol;
          const inTol = dev >= -lo && dev <= hi;
          const key = g.label;
          const s = (this.stats[key] = this.stats[key] || { label: g.label, unit: g.unit, tolText: lo === hi ? `±${lo}` : `−${lo}/+${hi}`, n: 0, inN: 0, maxDev: 0, run: 0, longest: 0, lastDev: 0, lo, hi });
          s.n += dt;
          if (inTol) {
            s.inN += dt;
            s.run = 0;
          } else {
            s.run += dt;
            s.longest = Math.max(s.longest, s.run);
          }
          if (Math.abs(dev) > Math.abs(s.maxDev)) s.maxDev = dev;
          s.lastDev = dev;
          s.live = { dev, inTol, lo, hi, at: c.lessonTime };
        }
      }
      if (st.fail) {
        const r = st.fail(t, c);
        if (r) {
          this.results.push({ label: 'Lesson ended', value: '', status: 'fail', note: r });
          return this.finish(r);
        }
      }
      let ok;
      if (st.manual) ok = this.manualAck;
      else ok = st.done ? st.done(t, c) : true;
      if (ok) this.hold += dt;
      else this.hold = 0;
      if (ok && this.hold >= (st.hold || 0)) return this.next();
      if (st.timeout && c.stepTime > st.timeout) {
        this.results.push({ label: `Step ${this.i + 1} timed out`, value: '', status: 'fail', note: 'Took too long — the instructor moved you on.' });
        this.next(true);
        this.results.pop();
      }
    }

    /** Live tolerance meters for the sidebar (items graded in the current step). */
    liveMeters() {
      const out = [];
      const st = this.step;
      if (!st || !st.grade) return out;
      for (const g of st.grade) {
        const s = this.stats[g.label];
        if (s && s.live && this.ctx.lessonTime - s.live.at < 0.5) out.push({ label: g.label, unit: g.unit, dev: s.live.dev, lo: s.live.lo, hi: s.live.hi, inTol: s.live.inTol });
        else out.push({ label: g.label, unit: g.unit, dev: null, lo: g.tolLo ?? g.tol, hi: g.tolHi ?? g.tol });
      }
      return out;
    }

    debrief() {
      const items = [];
      for (const k in this.stats) {
        const s = this.stats[k];
        if (s.n < 0.5) continue;
        const pct = (s.inN / s.n) * 100;
        const st = pct >= 85 && s.longest < 2.5 ? 'pass' : pct >= 65 && s.longest < 8 ? 'marginal' : 'fail';
        items.push({
          label: `${s.label} (${s.tolText} ${s.unit})`,
          value: `${pct.toFixed(0)}% in tolerance · worst ${s.maxDev > 0 ? '+' : ''}${Math.round(s.maxDev)} ${s.unit}`,
          status: st,
          note: st === 'pass' ? '' : s.longest >= 2.5 ? `Out of tolerance for ${s.longest.toFixed(1)} s at a stretch.` : '',
        });
      }
      const all = items.concat(this.results);
      let overall = 'pass';
      if (all.some((r) => r.status === 'marginal')) overall = 'marginal';
      if (all.some((r) => r.status === 'fail') || this.failReason) overall = 'fail';
      if (this.lesson.free) overall = 'info';
      return { lesson: this.lesson, items: all, overall, failReason: this.failReason, completed: this.i >= this.lesson.steps.length };
    }
  }

  FS.LESSONS = LESSONS;
  FS.LessonRunner = LessonRunner;
  FS.lessonHelpers = { G, gradeLanding, FIELD, LOAD_NORMAL, LOAD_GROSS, TPA };
})();
