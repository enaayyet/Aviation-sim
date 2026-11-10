/*
 * debrief.js — post-flight analysis: landing scores, the approach profile, and the overall score.
 *
 * The idea is the same as reviewing a trade journal: the number at touchdown is the outcome, but the
 * approach trace is the process that produced it. A good landing is almost always a good approach
 * (on path, on speed, on centreline) that simply continues to the ground.
 */
(function () {
  'use strict';
  const FS = (globalThis.FS = globalThis.FS || {});
  const { M } = FS;
  const { clamp, wrap180 } = M;
  const FT = 3.28084;
  const NM = 1852;

  /** 100 inside [-good, +good], falling linearly to 0 at `bad`. */
  const band = (v, good, bad) => clamp(100 * (1 - (Math.abs(v) - good) / (bad - good)), 0, 100);

  /** Which runway end a landing used and where it touched, in runway terms. */
  function landingFrame(td, world, hdg) {
    const rw = world.runway;
    const south = hdg !== undefined ? Math.abs(wrap180(hdg - 180)) < 90 : false;
    const along = south ? rw.length - td.n : td.n; // metres past the landing threshold
    const lat = south ? -td.e : td.e;
    return { south, along, lat, onRunway: along >= -5 && along <= rw.length && Math.abs(lat) <= rw.width / 2 };
  }

  /**
   * Score one touchdown 0–100 from five things an examiner watches. Returns the parts too, so the
   * debrief can show where the points went.
   */
  function landingScore(td, world, hdg) {
    const f = landingFrame(td, world, hdg);
    const aimFt = world.runway.aimN * FT;
    const alongFt = f.along * FT;
    const mid = aimFt + 200; // centre of the 400-ft touchdown box that starts at the aiming point
    const parts = {
      sink: band(Math.max(0, td.vsFpm) - 100, 100, 600), // <=200 fpm full marks, 700 none
      point: f.onRunway ? band(alongFt - mid, 200, 1100) : 0,
      centreline: f.onRunway ? band(f.lat * FT, 5, 37) : 0,
      alignment: Math.min(band(td.crabDeg, 3, 12), band(td.driftKt, 1.5, 7)),
      attitude: td.firstGear === 'mains' ? (td.pitchDeg > 0.5 ? 100 : 60) : 0,
    };
    const score = Math.round(0.3 * parts.sink + 0.2 * parts.point + 0.2 * parts.centreline + 0.15 * parts.alignment + 0.15 * parts.attitude);
    return { score: f.onRunway ? score : Math.min(score, 30), parts, alongFt, latFt: f.lat * FT, onRunway: f.onRunway, south: f.south };
  }

  /**
   * Turn recorder samples into an approach profile for one landing: distance to the threshold (m),
   * height (ft), airspeed and lateral offset (m), for the last couple of minutes before touchdown.
   */
  function approachTrace(samples, td, world, hdg) {
    const rw = world.runway;
    const south = Math.abs(wrap180(hdg - 180)) < 90;
    const out = [];
    for (const s of samples) {
      if (s.t > td.time + 0.3 || s.t < td.time - 150) continue;
      const dist = south ? s.n - rw.length : -s.n;
      if (dist > 2.2 * NM) continue;
      out.push({ dist, agl: s.agl, ias: s.ias, lat: south ? -s.e : s.e, t: s.t });
    }
    // keep only the final continuous run toward the runway (drop a previous circuit's samples)
    let start = 0;
    for (let i = out.length - 1; i > 0; i--) {
      if (out[i - 1].dist < out[i].dist - 40) {
        start = i;
        break;
      }
    }
    return out.slice(start);
  }

  /** Height and speed crossing the threshold, interpolated from a trace. */
  function thresholdCrossing(trace) {
    for (let i = 1; i < trace.length; i++) {
      const a = trace[i - 1], b = trace[i];
      if (a.dist > 0 && b.dist <= 0) {
        const k = a.dist / (a.dist - b.dist || 1);
        return { agl: a.agl + (b.agl - a.agl) * k, ias: a.ias + (b.ias - a.ias) * k, lat: a.lat + (b.lat - a.lat) * k };
      }
    }
    return null;
  }

  /** How stable the last half-mile was: RMS deviation from a 3° path, and airspeed spread. */
  function stability(trace, world) {
    const seg = trace.filter((p) => p.dist > 60 && p.dist < 0.6 * NM);
    if (seg.length < 4) return null;
    let sq = 0, lo = Infinity, hi = -Infinity, latSq = 0;
    for (const p of seg) {
      const ideal = Math.tan((3 * Math.PI) / 180) * (p.dist + world.runway.aimN) * FT;
      sq += (p.agl - ideal) ** 2;
      latSq += (p.lat * FT) ** 2;
      lo = Math.min(lo, p.ias);
      hi = Math.max(hi, p.ias);
    }
    return { pathRmsFt: Math.sqrt(sq / seg.length), latRmsFt: Math.sqrt(latSq / seg.length), iasLo: lo, iasHi: hi };
  }

  /** Overall 0–100 for a graded lesson from its pass / marginal / fail items. */
  function lessonScore(items, failed) {
    const pts = { pass: 100, marginal: 60, fail: 0 };
    const graded = items.filter((i) => i.status in pts);
    if (!graded.length) return null;
    let s = graded.reduce((a, i) => a + pts[i.status], 0) / graded.length;
    if (failed) s = Math.min(s, 49);
    return Math.round(s);
  }

  /** Draw the approach profile: flown path against the 3° glide path, coloured by airspeed. */
  function drawApproach(cv, landing, world) {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const r = cv.getBoundingClientRect();
    cv.width = r.width * dpr;
    cv.height = r.height * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height;
    ctx.clearRect(0, 0, W, H);
    const tr = landing.trace;
    if (!tr || tr.length < 3) return;
    const aim = world.runway.aimN;
    const tdAlong = landing.score.alongFt / FT;
    const xMax = clamp(Math.max(...tr.map((p) => p.dist)), 700, 2.2 * NM); // far end (m before threshold)
    const xMin = -Math.max(500, tdAlong + 120); // past the threshold
    const yMax = Math.max(250, Math.max(...tr.map((p) => p.agl)) * 1.12, Math.tan((3.6 * Math.PI) / 180) * (xMax + aim) * FT);
    const pl = 40, pr = 12, pt = 24, pb = 26;
    const X = (d) => pl + ((xMax - d) / (xMax - xMin)) * (W - pl - pr);
    const Y = (h) => pt + (1 - h / yMax) * (H - pt - pb);
    const pathH = (d, deg) => Math.tan((deg * Math.PI) / 180) * Math.max(0, d + aim) * FT;

    // glide-path corridor 2.5°–3.5° and the 3° line
    ctx.fillStyle = 'rgba(62,207,122,0.10)';
    ctx.beginPath();
    ctx.moveTo(X(-aim), Y(0));
    ctx.lineTo(X(xMax), Y(pathH(xMax, 3.5)));
    ctx.lineTo(X(xMax), Y(pathH(xMax, 2.5)));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(62,207,122,0.7)';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(X(-aim), Y(0));
    ctx.lineTo(X(xMax), Y(pathH(xMax, 3)));
    ctx.stroke();
    ctx.setLineDash([]);

    // axes
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    const yStep = yMax > 700 ? 200 : 100;
    for (let h = 0; h <= yMax; h += yStep) {
      ctx.beginPath();
      ctx.moveTo(pl, Y(h));
      ctx.lineTo(W - pr, Y(h));
      ctx.stroke();
      ctx.fillText(String(h), 6, Y(h) + 4);
    }
    for (let d = 0; d <= xMax; d += NM / 4) {
      const x = X(d);
      ctx.beginPath();
      ctx.moveTo(x, Y(0));
      ctx.lineTo(x, Y(0) + 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.stroke();
      if (d > 0) ctx.fillText(`${(d / NM).toFixed(2).replace(/0$/, '')} nm`, x - 16, H - 6);
    }
    // runway
    ctx.fillStyle = '#5b616b';
    ctx.fillRect(X(0), Y(0) - 1, X(xMin) - X(0), 5);
    ctx.fillStyle = '#fff';
    ctx.fillRect(X(-aim) - 5, Y(0) - 1, 10, 5);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('threshold', X(0) - 24, H - 6);

    // flown path, coloured by airspeed
    const col = (ias) => (ias < 60 ? '#ff5a4e' : ias > 75 ? '#f3c33b' : '#5fb4ff');
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    for (let i = 1; i < tr.length; i++) {
      ctx.strokeStyle = col(tr[i].ias);
      ctx.beginPath();
      ctx.moveTo(X(tr[i - 1].dist), Y(tr[i - 1].agl));
      ctx.lineTo(X(tr[i].dist), Y(tr[i].agl));
      ctx.stroke();
    }
    // touchdown marker
    ctx.fillStyle = '#ffb547';
    ctx.beginPath();
    ctx.arc(X(-tdAlong), Y(0), 4.5, 0, 6.3);
    ctx.fill();

    // legend
    ctx.font = '600 11px system-ui, sans-serif';
    let lx = pl;
    const leg = (c, label) => {
      ctx.fillStyle = c;
      ctx.fillRect(lx, 8, 14, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(label, lx + 19, 13);
      lx += 26 + ctx.measureText(label).width;
    };
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText('Height AGL (ft) on final', lx, 13);
    lx += ctx.measureText('Height AGL (ft) on final').width + 16;
    leg('#5fb4ff', '60–75 kt');
    leg('#f3c33b', 'fast');
    leg('#ff5a4e', 'slow');
    leg('rgba(62,207,122,0.8)', '3° path');
  }

  FS.Debrief = { landingScore, landingFrame, approachTrace, thresholdCrossing, stability, lessonScore, drawApproach };
})();
