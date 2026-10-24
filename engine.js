/* engine.js - generative music engine (JavaScript port of the Python musicgen.py).
 *
 * Runs in a Web Worker. A Piece composes and renders music one bar at a time into separate
 * dry stereo "buses" (drums, bass, harm, lead, arp) plus a texture layer; the page routes them
 * through Web Audio reverb/delay/filters. Everything is synthesized from math - no samples.
 *
 *   const p = new MG.Piece("lofi", 1234, { overrides: { bpm: 90 } });
 *   const bar = p.renderBar();   // { n, buses: {drums:[L,R],...}, tex, info }
 */
(function (G) {
  "use strict";
  const D = G.MG_DATA;
  const TAU = Math.PI * 2;
  let SR = 44100;

  // ------------------------------------------------------------------ rng (mulberry32)
  function RNG(seed) {
    let a = (seed >>> 0) || 0x9e3779b9, spare = null;
    const self = {
      random() {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      int(lo, hi) { if (hi === undefined) { hi = lo; lo = 0; } return lo + Math.floor(self.random() * (hi - lo)); },
      choice(arr) { return arr[self.int(arr.length)]; },
      uniform(x, y) { return x + (y - x) * self.random(); },
      normal(m, s) {
        m = m || 0; s = s === undefined ? 1 : s;
        if (spare !== null) { const v = spare; spare = null; return m + s * v; }
        let u = 0; while (u === 0) u = self.random();
        const v = self.random(), r = Math.sqrt(-2 * Math.log(u));
        spare = r * Math.sin(TAU * v); return m + s * r * Math.cos(TAU * v);
      },
      poisson(l) {
        if (l < 30) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= self.random(); } while (p > L); return k - 1; }
        return Math.max(0, Math.round(self.normal(l, Math.sqrt(l))));
      },
      shuffle(arr) { const x = arr.slice(); for (let i = x.length - 1; i > 0; i--) { const j = self.int(i + 1); const t = x[i]; x[i] = x[j]; x[j] = t; } return x; },
    };
    for (let i = 0; i < 4; i++) self.random();
    return self;
  }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // ------------------------------------------------------------------ dsp basics
  const TBL_N = 4096, TBL = new Float32Array(TBL_N + 1);
  for (let i = 0; i <= TBL_N; i++) TBL[i] = Math.sin(TAU * i / TBL_N);
  function sinc(x) { // x in cycles
    x -= Math.floor(x); const p = x * TBL_N, i = p | 0, f = p - i;
    return TBL[i] + (TBL[i + 1] - TBL[i]) * f;
  }
  const pow2 = (n) => Math.pow(2, n);
  function degMidi(base, sc, d) {
    const L = sc.length, o = Math.floor(d / L), i = d - o * L; return base + sc[i] + 12 * o;
  }
  const mtof = (m) => 440 * pow2((m - 69) / 12);

  function adsr(dur, a, d, s, r) {
    const nd = Math.max(1, Math.floor(dur * SR)), nr = Math.floor(r * SR);
    const out = new Float32Array(nd + nr);
    const na = Math.min(Math.max(1, Math.floor(a * SR)), nd), nde = Math.floor(d * SR);
    for (let i = 0; i < na; i++) out[i] = i / na;
    if (nde > 0 && nd > na) {
      const end = Math.min(nd, na + nde), span = Math.max(1, end - na - 1);
      for (let i = na; i < end; i++) out[i] = 1 + (s - 1) * (i - na) / span;
      for (let i = end; i < nd; i++) out[i] = s;
    } else for (let i = na; i < nd; i++) out[i] = 1;
    const last = out[nd - 1];
    for (let i = 0; i < nr; i++) out[nd + i] = last * (1 - i / nr);
    return out;
  }
  function expEnv(n, k) { const o = new Float32Array(n), d = Math.exp(-k / SR); let v = 1; for (let i = 0; i < n; i++) { o[i] = v; v *= d; } return o; }
  function vibPhase(f, n, depth, rate, delay) { // phase in cycles
    const o = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR, d = depth * Math.min(1, Math.max(0, (t - delay) / 0.4));
      o[i] = f * t - f * d * Math.cos(TAU * rate * t) / (TAU * rate);
    }
    return o;
  }
  // additive band-limited oscillator; bright = scalar or per-sample Float32Array
  function osc(f, n, shape, bright, nh, ph, duty) {
    const out = new Float32Array(n), hmax = Math.min(nh, Math.floor((SR * 0.42) / Math.max(f, 1)));
    const arr = bright instanceof Float32Array, bp = arr ? new Float32Array(n).fill(1) : null;
    let bs = 1;
    for (let h = 1; h <= hmax; h++) {
      let a;
      if (shape === "saw") a = 1 / h;
      else if (shape === "square") { if (h % 2 === 0) { if (!arr) bs *= bright; else for (let i = 0; i < n; i++) bp[i] *= bright[i]; continue; } a = 1 / h; }
      else if (shape === "tri") { if (h % 2 === 0) { if (!arr) bs *= bright; else for (let i = 0; i < n; i++) bp[i] *= bright[i]; continue; } a = (h % 4 === 1 ? 1 : -1) / (h * h); }
      else a = Math.sin(Math.PI * h * (duty || .5)) / h;
      if (!arr) {
        const w = a * bs; bs *= bright;
        if (Math.abs(w) < 1e-4) continue;
        if (ph) for (let i = 0; i < n; i++) out[i] += w * sinc(h * ph[i]);
        else { const k = h * f / SR; for (let i = 0; i < n; i++) out[i] += w * sinc(k * i); }
      } else {
        const k = h * f / SR;
        for (let i = 0; i < n; i++) { out[i] += a * bp[i] * sinc(ph ? h * ph[i] : k * i); bp[i] *= bright[i]; }
      }
    }
    return out;
  }
  const arr = (n, fn) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = fn(i / SR, i); return o; };
  const hp = (x) => { const y = new Float32Array(x.length); y[0] = x[0]; for (let i = 1; i < x.length; i++) y[i] = x[i] - x[i - 1]; return y; };
  const noise = (rng, n, s) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = rng.normal(0, s === undefined ? 1 : s); return o; };

  // ------------------------------------------------------------------ instruments
  // (freq, dur, vel, det_cents, rng) -> Float32Array incl. release. Peak-normalised on first use.
  const INST = {};
  INST.pad = (f, dur, vel, det) => {
    f *= pow2(det / 1200); const e = adsr(dur, .8, 0, 1, 1.6), n = e.length;
    const br = arr(n, (t) => .45 + .15 * Math.sin(TAU * .11 * t));
    const a = osc(f, n, "saw", br, 9), b = osc(f * 1.004, n, "saw", br, 9);
    for (let i = 0; i < n; i++) a[i] = e[i] * (a[i] + .6 * b[i]); return a;
  };
  INST.strings = (f, dur, vel, det) => {
    f *= pow2(det / 1200); const e = adsr(dur, .35, 0, 1, .6), n = e.length;
    const a = osc(f, n, "saw", .5, 10, vibPhase(f, n, .003, 5.3, .3)), b = osc(f * 1.006, n, "saw", .5, 10, vibPhase(f * 1.006, n, .003, 4.9, .4));
    for (let i = 0; i < n; i++) a[i] = e[i] * (a[i] + .6 * b[i]); return a;
  };
  INST.supersaw = (f, dur, vel, det) => {
    const e = adsr(dur, .02, .2, .8, .3), n = e.length, y = new Float32Array(n);
    for (const c of [-13, -6, 0, 6, 13]) { const o = osc(f * pow2((c + det) / 1200), n, "saw", .6, 8); for (let i = 0; i < n; i++) y[i] += o[i]; }
    for (let i = 0; i < n; i++) y[i] *= e[i]; return y;
  };
  INST.choir = (f, dur, vel, det, rng) => {
    f *= pow2(det / 1200); const e = adsr(dur, .5, 0, 1, .9), n = e.length;
    const [f1, f2] = rng.choice([[730, 1090], [270, 2290], [300, 870], [530, 1840]]);
    const ph = vibPhase(f, n, .005, 5.0, .3), y = new Float32Array(n);
    for (let h = 1; h <= Math.min(30, Math.floor(SR * .4 / f)); h++) {
      const a = (Math.exp(-.5 * Math.pow((h * f - f1) / 110, 2)) + .6 * Math.exp(-.5 * Math.pow((h * f - f2) / 180, 2)) + .04) / h;
      for (let i = 0; i < n; i++) y[i] += a * sinc(h * ph[i]);
    }
    for (let i = 0; i < n; i++) y[i] *= e[i]; return y;
  };
  INST.organ = (f, dur) => {
    const e = adsr(dur, .008, 0, 1, .06), n = e.length, y = new Float32Array(n);
    for (const [h, a] of [[1, 1], [2, .8], [3, .6], [4, .5], [6, .3], [8, .2]]) {
      if (f * h < SR * .4) { const k = f * h / SR; for (let i = 0; i < n; i++) y[i] += a * sinc(k * i); }
    }
    for (let i = 0; i < n; i++) y[i] *= e[i] * (1 + .12 * Math.sin(TAU * 6 * i / SR)); return y;
  };
  INST.epiano = (f, dur, vel) => {
    const n = Math.floor(Math.min(dur + .6, 4) * SR), y = new Float32Array(n), tine = f * 7 < SR * .4;
    for (let i = 0; i < n; i++) {
      const t = i / SR, ph = TAU * f * t;
      y[i] = Math.sin(ph + 2.2 * vel * Math.exp(-t * 3.5) * Math.sin(ph)) * Math.exp(-t * 1.1)
        + (tine ? .12 * Math.sin(TAU * f * 7 * t) * Math.exp(-t * 14) : 0);
    }
    return y;
  };
  INST.piano = (f, dur) => {
    const n = Math.floor(Math.min(dur + 1.0, 4.5) * SR), y = new Float32Array(n);
    for (let h = 1; h <= 10; h++) {
      if (f * h > SR * .4) break;
      const k = f * h * (1 + .0004 * h * h) / SR, amp = Math.pow(h, -1.2), d = Math.exp(-(1.5 + .5 * h) / SR);
      let env = 1;
      for (let i = 0; i < n; i++) { y[i] += sinc(k * i) * amp * env; env *= d; }
    }
    for (let i = 0; i < n; i++) { const t = i / SR; y[i] *= Math.exp(-t * .6) * Math.min(1, t / .002); }
    return y;
  };
  const bellFn = (ratio, idx, dec, extra, maxd, maxn) => (f, dur) => {
    const n = Math.floor(Math.min(dur + extra, maxn) * SR), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR, ph = TAU * f * t; y[i] = Math.sin(ph + idx * Math.exp(-t * 2.2) * Math.sin(ratio * ph)) * Math.exp(-t * dec); }
    return y;
  };
  INST.bell = bellFn(3.5, 5.0, 1.4, 2.5, 0, 5);
  INST.glass = (f, dur) => {
    const n = Math.floor(Math.min(dur + 3, 6) * SR), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR, ph = TAU * f * t; y[i] = Math.sin(ph + 1.8 * Math.exp(-t * .5) * Math.sin(2 * ph)) * Math.exp(-t * .55) * Math.min(1, t / .25); }
    return y;
  };
  INST.marimba = (f, dur) => {
    const n = Math.floor(Math.min(dur + .5, 1.6) * SR), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR, ph = TAU * f * t; y[i] = Math.sin(ph) * Math.exp(-t * 5) + .5 * Math.sin(4 * ph) * Math.exp(-t * 20); }
    return y;
  };
  INST.musicbox = (f, dur) => {
    const n = Math.floor(Math.min(dur + 1.5, 3) * SR), y = new Float32Array(n);
    for (const [r, a, k] of [[1, 1, 3.5], [2.76, .35, 6], [5.4, .12, 9]]) {
      if (f * r < SR * .4) for (let i = 0; i < n; i++) { const t = i / SR; y[i] += a * Math.sin(TAU * f * r * t) * Math.exp(-t * k); }
    }
    return y;
  };
  INST.pluck = (f, dur) => {
    const n = Math.floor(Math.min(dur + .4, 2.5) * SR), br = arr(n, (t) => .85 * Math.exp(-t * 7)), y = osc(f, n, "saw", br, 14), e = expEnv(n, 3.2);
    for (let i = 0; i < n; i++) y[i] *= e[i]; return y;
  };
  INST.harp = (f, dur) => {
    const n = Math.floor(Math.min(dur + 1, 3) * SR), br = arr(n, (t) => .6 * Math.exp(-t * 4)), y = osc(f, n, "saw", br, 10), e = expEnv(n, 1.8);
    for (let i = 0; i < n; i++) y[i] = (y[i] + Math.sin(TAU * f * i / SR)) * e[i]; return y;
  };
  INST.guitar = (f, dur, vel, det, rng) => {
    const n = Math.floor(Math.min(dur + .5, 2.5) * SR), br = arr(n, (t) => .05 + .75 * Math.exp(-t * 5)), y = osc(f, n, "saw", br, 14), e = expEnv(n, 2.5);
    for (let i = 0; i < n; i++) y[i] *= e[i];
    const k = Math.floor(.015 * SR); for (let i = 0; i < k && i < n; i++) y[i] += rng.normal(0, .25) * (1 - i / k);
    return y;
  };
  INST.koto = (f, dur) => {
    const n = Math.floor(Math.min(dur + .5, 2.5) * SR), ph = new Float64Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR; ph[i] = f * (t + .03 * (1 - Math.exp(-t * 25)) / 25); }
    const br = arr(n, (t) => .7 * Math.exp(-t * 6)), y = osc(f, n, "saw", br, 12, ph), e = expEnv(n, 3);
    for (let i = 0; i < n; i++) y[i] *= e[i]; return y;
  };
  INST.saw_lead = (f, dur) => {
    const e = adsr(dur, .012, .12, .75, .18), n = e.length;
    const a = osc(f, n, "saw", .7, 14, vibPhase(f, n, .004, 5.5, .15)), b = osc(f * 1.004, n, "saw", .7, 14);
    for (let i = 0; i < n; i++) a[i] = e[i] * (a[i] + .7 * b[i]); return a;
  };
  const pulseFn = (duty) => (f, dur) => { const e = adsr(dur, .003, .04, .8, .04), y = osc(f, e.length, "pulse", 1.0, 20, null, duty); for (let i = 0; i < y.length; i++) y[i] *= e[i]; return y; };
  INST.pulse = pulseFn(.5); INST.pulse25 = pulseFn(.25); INST.pulse125 = pulseFn(.125);
  INST.brass = (f, dur) => {
    const e = adsr(dur, .07, .1, .85, .12), n = e.length, br = arr(n, (t) => .35 + .4 * (1 - Math.exp(-t * 14)));
    const y = osc(f, n, "saw", br, 12, vibPhase(f, n, .004, 5.2, .25)); for (let i = 0; i < n; i++) y[i] *= e[i]; return y;
  };
  INST.flute = (f, dur, vel, det, rng) => {
    const e = adsr(dur, .07, .1, .8, .2), n = e.length, ph = vibPhase(f, n, .006, 5.0, .2), nz = noise(rng, n + 6, 1), y = new Float32Array(n);
    let run = 0; for (let i = 0; i < 6; i++) run += nz[i];
    for (let i = 0; i < n; i++) { run += nz[i + 6] - nz[i]; y[i] = e[i] * (sinc(ph[i]) + .25 * sinc(2 * ph[i]) + .08 * sinc(3 * ph[i]) + (run / 6) * .06); }
    return y;
  };
  INST.sub = (f, dur) => { const e = adsr(dur, .004, 0, 1, .08), n = e.length, y = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; y[i] = e[i] * (Math.sin(TAU * f * t) + .2 * Math.sin(TAU * 2 * f * t)); } return y; };
  INST["808"] = (f, dur) => {
    const n = Math.floor(Math.min(dur + .5, 1.6) * SR), y = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / SR; ph += f * (1 + .7 * Math.exp(-t * 30)) / SR; y[i] = Math.tanh(1.6 * Math.sin(TAU * ph)) * Math.exp(-t * 1.8); }
    return y;
  };
  INST.acid = (f, dur) => { const e = adsr(dur, .003, .1, .6, .04), n = e.length, y = osc(f, n, "saw", arr(n, (t) => .8 * Math.exp(-t * 9) + .12), 16); for (let i = 0; i < n; i++) y[i] *= e[i]; return y; };
  INST.pluckbass = (f, dur) => {
    const e = adsr(dur, .003, .12, .55, .07), n = e.length, y = osc(f, n, "saw", arr(n, (t) => .55 * Math.exp(-t * 12) + .05), 10);
    for (let i = 0; i < n; i++) y[i] = e[i] * (y[i] + .6 * Math.sin(TAU * f * i / SR)); return y;
  };
  INST.upright = (f, dur) => {
    const e = adsr(dur, .004, .3, .35, .12), n = e.length, y = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR; y[i] = e[i] * (Math.sin(TAU * f * t) + .5 * Math.sin(TAU * 2 * f * t) * Math.exp(-t * 3) + .2 * Math.sin(TAU * 3 * f * t) * Math.exp(-t * 6)); }
    return y;
  };
  INST.fmbass = (f, dur) => { const e = adsr(dur, .003, .1, .7, .08), n = e.length, y = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR, ph = TAU * f * t; y[i] = e[i] * Math.sin(ph + 2.2 * Math.exp(-t * 7) * Math.sin(ph)); } return y; };
  INST.reese = (f, dur) => { const e = adsr(dur, .01, 0, 1, .1), n = e.length, a = osc(f * 1.007, n, "saw", .35, 10), b = osc(f / 1.007, n, "saw", .35, 10); for (let i = 0; i < n; i++) a[i] = e[i] * (a[i] + b[i]); return a; };
  INST.tri = (f, dur) => { const e = adsr(dur, .002, 0, 1, .02), y = osc(f, e.length, "tri", 1.0, 12); for (let i = 0; i < y.length; i++) y[i] *= e[i]; return y; };
  INST.wobble = (f, dur) => { const e = adsr(dur, .005, 0, 1, .06), n = e.length, y = osc(f, n, "saw", arr(n, (t) => .45 + .4 * Math.sin(TAU * 2.5 * t)), 14); for (let i = 0; i < n; i++) y[i] *= e[i]; return y; };
  INST.wind = (f, dur, vel, det, rng) => { // noise through a resonant band-pass
    const e = adsr(dur, 1.2, 0, 1, 1.5), n = e.length, w0 = TAU * Math.min(f, SR * .4) / SR, Q = 9, al = Math.sin(w0) / (2 * Q);
    const b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * Math.cos(w0), a2 = 1 - al, y = new Float32Array(n);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const x = rng.normal(0, 1), o = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x; y2 = y1; y1 = o; y[i] = o; s2 += o * o; }
    const sc = 1 / (Math.sqrt(s2 / n) + 1e-9); for (let i = 0; i < n; i++) y[i] *= sc * e[i]; return y;
  };
  const GAIN = {};
  function play(name, f, dur, vel, det, rng) {
    if (!(name in GAIN)) {
      const y = INST[name](220, 1.0, .8, 0, RNG(1)); let pk = 1e-9; for (let i = 0; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]));
      GAIN[name] = .35 / pk;
    }
    const y = INST[name](f, dur, vel, det, rng), g = GAIN[name] * vel; for (let i = 0; i < y.length; i++) y[i] *= g; return y;
  }

  // ------------------------------------------------------------------ drums
  const DR = {};
  function drum(kit, lane) {
    const key = kit + "/" + lane; if (DR[key]) return DR[key];
    const K = D.KITS[kit], r = RNG(hashStr(key)); let y;
    const sweep = (a, b, pk, n) => { const o = new Float64Array(n); let acc = 0; for (let i = 0; i < n; i++) { acc += (b + (a - b) * Math.exp(-i / SR * pk)) / SR; o[i] = acc; } return o; };
    if (lane === "k") {
      const [f0, f1, pk, dec, ln] = K.k, n = Math.floor(ln * SR), ph = sweep(f0, f1, pk, n); y = new Float32Array(n);
      for (let i = 0; i < n; i++) y[i] = sinc(ph[i]) * Math.exp(-i / SR * dec);
      for (let i = 0; i < 60; i++) y[i] += r.normal(0, .3);
      for (let i = 0; i < n; i++) y[i] = Math.tanh(1.8 * y[i]);
    } else if (lane === "s") {
      const [tone, td, nd] = K.s, n = Math.floor(.22 * SR), h = hp(noise(r, n)); y = new Float32Array(n);
      for (let i = 0; i < n; i++) { const t = i / SR; y[i] = .55 * Math.sin(TAU * tone * t) * Math.exp(-t * td) + h[i] * .6 * Math.exp(-t * nd); }
    } else if (lane === "c") {
      const n = Math.floor(.3 * SR); y = new Float32Array(n);
      for (const off of [0, .009, .018, .027]) { const m = Math.floor(off * SR), h = hp(noise(r, n - m)); for (let j = 0; j < n - m; j++) y[m + j] += h[j] * Math.exp(-j / SR * 70); }
      const h = hp(noise(r, n)); for (let i = 0; i < n; i++) y[i] += h[i] * Math.exp(-i / SR * 16) * .5;
    } else if (lane === "h" || lane === "o") {
      const n = Math.floor((lane === "h" ? .07 : .35) * SR), h = hp(hp(noise(r, n))), dec = lane === "h" ? K.h : 12; y = new Float32Array(n);
      for (let i = 0; i < n; i++) y[i] = h[i] * Math.exp(-i / SR * dec);
    } else if (lane === "d") {
      const n = Math.floor(.9 * SR), h = hp(noise(r, n)); y = new Float32Array(n);
      for (let i = 0; i < n; i++) { const t = i / SR; let s = 0; for (const f of [3100, 4300, 5700, 7200]) s += Math.sin(TAU * f * t); y[i] = s * .12 * Math.exp(-t * 6) + h[i] * .3 * Math.exp(-t * 9); }
    } else if (lane === "r") {
      const n = Math.floor(.09 * SR); y = new Float32Array(n);
      for (let i = 0; i < n; i++) { const t = i / SR; y[i] = Math.sin(TAU * 1750 * t) * Math.exp(-t * 80) + r.normal(0, .4) * Math.exp(-t * 120); }
    } else if (lane === "t" || lane === "tl") {
      const [f0, f1] = lane === "t" ? [210, 120] : [130, 75], n = Math.floor(.45 * SR), ph = sweep(f0, f1, 14, n); y = new Float32Array(n);
      for (let i = 0; i < n; i++) y[i] = sinc(ph[i]) * Math.exp(-i / SR * 6.5);
    } else if (lane === "sh") {
      const n = Math.floor(.09 * SR), h = hp(noise(r, n)); y = new Float32Array(n);
      for (let i = 0; i < n; i++) { const t = i / SR; y[i] = h[i] * Math.exp(-t * 38) * Math.min(1, t / .006); }
    } else if (lane === "cb") {
      const n = Math.floor(.25 * SR); y = new Float32Array(n);
      for (let i = 0; i < n; i++) { const t = i / SR; y[i] = (Math.sign(Math.sin(TAU * 540 * t)) + Math.sign(Math.sin(TAU * 810 * t))) * .4 * Math.exp(-t * 14); }
    } else { // cg
      const n = Math.floor(.28 * SR), ph = sweep(340, 290, 30, n); y = new Float32Array(n);
      for (let i = 0; i < n; i++) { const t = i / SR; y[i] = sinc(ph[i]) * Math.exp(-t * 15) + r.normal(0, .15) * Math.exp(-t * 80); }
    }
    let pk = 1e-9; for (let i = 0; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]));
    for (let i = 0; i < y.length; i++) y[i] /= pk;
    return (DR[key] = y);
  }

  // ------------------------------------------------------------------ patterns / progressions
  function euclid(k, n, rot) {
    const pat = []; for (let i = 0; i < n; i++) pat.push((i * k) % n < k);
    const r = ((rot || 0) % n + n) % n; return pat.slice(r).concat(pat.slice(0, r));
  }
  function euclidDrums(r, steps) {
    const S = (pat, ch) => pat.map((b) => (b ? ch : ".")).join("");
    return {
      k: S(euclid(r.int(3, 6), steps), "X"), s: S(euclid(r.int(2, 4), steps, Math.floor(steps / 4) + r.int(0, 2)), "x"),
      h: S(euclid(r.int(5, 11), steps, r.int(0, 3)), "x"), r: S(euclid(r.int(3, 8), steps, r.int(0, steps)), "o"),
    };
  }
  function makeProg(r, kind) {
    if (kind === "canon") return [0, 4, 5, 2, 3, 0, 3, 4];
    if (kind === "static") return [0];
    if (kind === "vamp") return r.choice([[0, 0, 0, 0], [0, 6], [0, 5], [0, 3], [0, 0, 6, 6], [0, 2]]).slice();
    if (kind === "func") { let d = 0; const out = [0]; for (let i = 0; i < 3; i++) { d = r.choice(D.FUNC[String(d)]); out.push(d); } return out; }
    if (kind === "drift") { let d = 0; const out = [0], n = r.int(3, 6); for (let i = 0; i < n; i++) { d = ((d + r.choice([-2, -1, 1, 2, 3])) % 7 + 7) % 7; out.push(d); } return out; }
    const table = {
      pop: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4], [0, 3, 5, 4]], minor: [[0, 5, 2, 6], [0, 6, 5, 6], [0, 3, 6, 2], [0, 5, 6, 4]],
      jazz: [[1, 4, 0, 0], [2, 5, 1, 4], [0, 5, 1, 4], [3, 6, 2, 5]],
    }[kind] || [[0, 4, 5, 3]];
    return r.choice(table).slice();
  }
  const PROG_KINDS = ["pop", "minor", "jazz", "vamp", "func", "drift", "static", "canon"];
  const LEAD_MODES = ["motif", "markov", "euclid", "phase", "automaton", "lsystem", "canon", "sparse"];
  const INST_LEAD = ["saw_lead", "pulse", "flute", "bell", "epiano", "marimba", "pluck", "brass", "musicbox", "guitar", "koto", "piano", "glass"];

  function mashup(r) {
    const ch = (L) => L[r.int(L.length)];
    const steps = ch([16, 16, 16, 12, 14, 20]);
    const drumPool = Object.keys(D.DRUMS).filter((k) => !["none", "waltz", "jig", "odd7", "odd5"].includes(k)).concat(["none"]);
    const bassPool = Object.keys(D.BASS).filter((k) => !["waltz", "oompah", "odd7", "odd5"].includes(k)).concat([null]);
    return {
      bpm: [r.int(60, 100), r.int(100, 170)], steps, swing: ch([0, 0, .15, .3]), scales: [ch(Object.keys(D.SCALES))],
      prog: ch(["pop", "minor", "jazz", "vamp", "func", "drift", "static"]), chord: ch(Object.keys(D.CHORDS)), hr: ch([.5, 1, 1, 2]),
      form: ch(["edm", "song", "jam", "ambient", "loop"]), drums: ch(drumPool), kit: ch(Object.keys(D.KITS)), bass: ch(bassPool),
      bass_inst: ch(["sub", "pluckbass", "acid", "fmbass", "808", "upright", "reese", "tri", "wobble"]),
      harm: ch(["sustain", "stab", null]), harm_inst: ch(["pad", "strings", "choir", "organ", "epiano", "piano", "supersaw", "glass", "guitar"]),
      stab: ch(["x..x..x...x..x..", "..x...x...x...x.", "x...............", "x.x..x.x.x..x..x"]), stab_len: ch([1, 2, 3]),
      lead: ch(LEAD_MODES), lead_inst: ch(INST_LEAD), density: r.uniform(.25, .75),
      arp: ch(Object.keys(D.ARPS).concat([null, null])), arp_inst: ch(["pluck", "bell", "marimba", "musicbox", "pulse25", "harp", "epiano", "guitar", "piano"]),
      arp_rate: ch([1, 2, 2, 4]), arp_prob: r.uniform(.5, 1), tex: ch([null, null, "vinyl", "rain", "wind", "tape"]), rev: r.uniform(.1, .8),
      rev_len: r.uniform(.8, 3.2), delay: ch([0, 0, .25, .5]), delay_steps: ch([2, 3, 4, 6]), lofi: r.random() < .25,
      sidechain: ch([0, 0, .3, .6]), crush: ch([0, 0, 0, 6, 8, 12]), srr: ch([1, 1, 1, 2, 3]), human: r.uniform(0, .6), hat_roll: r.random() < .2,
    };
  }
  const pick = (r, v) => (Array.isArray(v) ? v[r.int(v.length)] : v);
  const BUSES = ["drums", "bass", "harm", "lead", "arp"];

  // ------------------------------------------------------------------ a piece
  class Piece {
    constructor(style, seed, opts) {
      opts = opts || {};
      const r = this.rng = RNG(seed);
      style = D.ALIASES[style] || style;
      if (style === "random") style = Object.keys(D.STYLES)[r.int(Object.keys(D.STYLES).length)];
      if (style !== "chaos" && !D.STYLES[style]) throw new Error("unknown style " + style);
      const base = Object.assign({}, D.DEFAULT, style === "chaos" ? mashup(r) : D.STYLES[style]);
      this.style = style; this.seed = seed;
      const bpmR = base.bpm; delete base.bpm;
      const p = this.p = {}; for (const k of Object.keys(base)) p[k] = pick(r, base[k]);
      p.scale = p.scales; delete p.scales;
      this.bpm = r.int(bpmR[0], bpmR[1] + 1); this.pc = r.int(12);
      this.progKind = typeof p.prog === "string" ? p.prog : "pop";
      this.prog = makeProg(r, this.progKind);
      this.gbar = 0; this.sec = null; this.sec_bar = 0; this.section_done = false;
      this.motifs = {}; this.var = null; this.drum_pat = {}; this.customDrums = null;
      this.mk = { pos: 2, gs: 0 }; this.ca = Array.from({ length: 8 }, () => r.int(2));
      this.ls_ptr = 0; this.ls_pos = 2; this.ls_gs = 0; this.eu_i = 0; this.eu_rot = 0; this.eu_k = 4; this.eu_seq = [0, 2, 4]; this.phs = null;
      this.ls = "A"; for (let i = 0; i < 5; i++) this.ls = this.ls.replace(/[AB]/g, (c) => (c === "A" ? "A+B-A" : "BB+A"));
      this.gain = null; this.windCoef = null; this.windState = [[0, 0, 0, 0], [0, 0, 0, 0]]; this.windScale = null;
      this.bus = null; this.tail = 0;
      this._derive();
      this.plan = this._plan();
      if (opts.overrides) this.update(opts.overrides);
    }

    get info() {
      const p = this.p;
      return `${this.style} | ${D.KEYS[this.pc]} ${p.scale} | ${this.bpm} bpm | ${this.steps}/16 | lead: ${this.lead_mode}/${p.lead_inst} | harm: ${p.harm_inst} | drums: ${p.drums} | bass: ${p.bass_inst}`;
    }

    _derive() {
      const p = this.p;
      this.steps = p.steps; this.sc = D.SCALES[p.scale]; this.stepdur = 60 / this.bpm / 4; this.step_f = this.stepdur * SR;
      this.bar_n = Math.round(this.steps * this.step_f); this.slot = Math.max(1, Math.round(this.steps / p.hr));
      this.chord_off = D.CHORDS[p.chord]; this.lead_mode = p.lead; this.t60 = 60 + (this.pc <= 6 ? this.pc : this.pc - 12);
      const tail = Math.floor((Math.max(this.slot * this.stepdur, 2) + 4) * SR), len = this.bar_n + tail;
      if (!this.bus || this.bus.drums.L.length !== len) {
        const old = this.bus, nb = {};
        for (const b of BUSES) {
          nb[b] = { L: new Float32Array(len), R: new Float32Array(len) };
          if (old) { const m = Math.min(len, old[b].L.length); nb[b].L.set(old[b].L.subarray(0, m)); nb[b].R.set(old[b].R.subarray(0, m)); }
        }
        this.bus = nb;
      }
      this.tail = tail;
    }

    /** Apply user overrides to a running piece (takes effect from the next bar). Returns true if the fx IRs need rebuilding. */
    update(o) {
      const p = this.p, r = this.rng; let fx = false, struct = false;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (k === "bpm") { this.bpm = Math.max(30, Math.min(260, Math.round(v))); fx = true; struct = true; }
        else if (k === "key") { this.pc = ((Math.round(v) % 12) + 12) % 12; struct = true; }
        else if (k === "prog") { p.prog = v; this.progKind = v; this.prog = makeProg(r, v); }
        else if (k === "progCustom") { if (Array.isArray(v) && v.length) this.prog = v.map((x) => Math.round(x)); }
        else if (k === "drumPat") { this.customDrums = v; this.drum_pat = v || this._namedDrums(); }
        else if (k === "drums") { p.drums = v; if (!this.customDrums) this.drum_pat = this._namedDrums(); }
        else if (k === "form") { p.form = v; this.plan = this._plan(); this.sec = null; }
        else if (k === "steps") { p.steps = v; this.mk.gs = this.ls_gs = this.gbar * v; this.sec = null; struct = true; }
        else { p[k] = v; if (["rev", "rev_len", "delay", "delay_steps"].includes(k)) fx = true; if (["scale", "hr", "chord", "lead"].includes(k)) struct = true; }
      }
      if (struct || fx) this._derive();
      return fx;
    }

    _namedDrums() {
      const d = this.p.drums;
      if (d === "euclid") return euclidDrums(this.rng, this.steps);
      return D.DRUMS[d] || {};
    }

    /** Wet-only impulse responses for the Web Audio convolvers (stereo, decorrelated). */
    buildIRs() {
      const p = this.p, out = {};
      const specs = [["harm", p.rev, p.rev_len, 0], ["lead", p.rev, p.rev_len, p.delay], ["drums", p.rev * .35, .45, 0]];
      for (const [bus, rev, ln, dly] of specs) {
        if (rev < .01 && dly < .01) { out[bus] = null; continue; }
        const chans = [];
        for (let ch = 0; ch < 2; ch++) {
          const r = RNG(100 + ch + bus.length), n = Math.floor(ln * SR), ir = new Float32Array(Math.max(n, 16)), k = Math.log(1000) / ln;
          const a = 1 - Math.exp(-TAU * 5000 / SR); let y = 0;
          for (let i = 0; i < n; i++) { y += a * (r.normal(0, 1) * Math.exp(-i / SR * k) - y); ir[i] = i < Math.floor(.012 * SR) ? 0 : y; }
          let e = 0; for (let i = 0; i < n; i++) e += ir[i] * ir[i]; const sc = rev / Math.sqrt(e + 1e-12);
          for (let i = 0; i < n; i++) ir[i] *= sc;
          if (dly) {
            const d = Math.floor(p.delay_steps * this.step_f);
            for (let t = 1; t < 6; t++) { const pos = d * t + (ch ? Math.floor(d / 2) : 0); if (pos < ir.length) ir[pos] += dly * Math.pow(.7, t - 1); }
          }
          chans.push(ir);
        }
        out[bus] = chans;
      }
      return out;
    }

    // ---- helpers
    when(step, human) {
      const g = this.p.grid; let s = step * this.step_f;
      if (Math.floor(Math.floor(step) / g) % 2 === 1) s += this.p.swing * g * this.step_f;
      if (human && this.p.human) s += this.rng.normal(0, this.p.human * .004 * SR);
      return Math.max(0, Math.floor(s));
    }
    cdeg(gs) { return this.prog[Math.floor(gs / this.slot) % this.prog.length]; }
    leadMidi(d, extra) {
      let m = degMidi(this.t60 + 12 * this.p.lead_oct + (extra || 0), this.sc, d);
      while (m > 96) m -= 12; while (m < 50) m += 12; return m;
    }
    voicing(deg, lo) {
      lo = lo === undefined ? this.p.pad_lo : lo; const out = new Set();
      for (const o of this.chord_off) { let m = degMidi(this.t60, this.sc, deg + o); while (m >= lo + 14) m -= 12; while (m < lo) m += 12; out.add(m); }
      return Array.from(out).sort((a, b) => a - b);
    }
    chordName(deg) { const L = this.sc.length, o = Math.floor(deg / L), i = deg - o * L; return D.KEYS[(this.pc + this.sc[i]) % 12]; }

    // ---- form
    *_plan() {
      const r = this.rng, p = this.p; let n = 0;
      const ALL = ["drums", "bass", "harm", "lead", "arp", "tex"];
      const S = (name, bars, L, m) => ({ name, bars, layers: new Set(L), motif: m || 0 });
      for (;;) {
        const form = this.p.form;
        if (form === "edm") {
          const b = r.choice([4, 8]);
          yield S("intro", b, ["harm", "arp"]); yield S("build", b, ["harm", "drums", "bass"]); yield S("drop", 2 * b, ALL, 0);
          yield S("break", b, ["harm", "lead", "arp"], 1); yield S("drop 2", 2 * b, ALL, 1); yield S("outro", b, ["harm", "drums"]);
        } else if (form === "song") {
          yield S("intro", 4, ["harm", "arp"]); yield S("verse", 8, ["drums", "bass", "harm"], 0); yield S("chorus", 8, ALL, 1);
          yield S("verse", 8, ["drums", "bass", "harm", "arp"], 0); yield S("chorus", 8, ALL, 1); yield S("bridge", 4, ["harm", "lead", "arp"], 2);
          yield S("chorus", 8, ALL, 1); yield S("outro", 4, ["harm", "arp"], 0);
        } else if (form === "loop") { yield S("loop", 8, ALL, n % 2); n++; }
        else if (form === "ambient") {
          let L = [["harm", .92], ["lead", .6], ["arp", .5], ["bass", .35], ["drums", .3]].filter(([, pr]) => r.random() < pr).map((x) => x[0]);
          if (!L.length) L = ["harm"]; yield S("drift", r.choice([8, 12, 16]), L, r.int(3));
        } else {
          let L = [["drums", .75], ["bass", .75], ["harm", .85], ["lead", .6], ["arp", .5]].filter(([, pr]) => r.random() < pr).map((x) => x[0]);
          if (!L.length) L = ["harm", "bass"]; yield S("jam", r.choice([4, 4, 8]), L, r.int(3));
        }
      }
    }
    _has(k) {
      const p = this.p;
      if (k === "drums") return !!this.customDrums || (!!p.drums && p.drums !== "none");
      if (k === "bass") return !!(p.bass || p.bassPat);
      return !!p[k];
    }
    _advance() {
      if (this.sec === null || this.sec_bar >= this.sec.bars) {
        this.sec = this.plan.next().value; this.sec_bar = 0;
        const m = this.sec.motif; if (!(m in this.motifs)) this.motifs[m] = this.makeMotif();
        this.var = null; const r = this.rng;
        this.eu_rot = r.int(0, this.steps); this.eu_k = r.int(3, 8); this.eu_seq = r.shuffle([0, 1, 2, 4, 5, 7]).slice(0, 5);
        this.drum_pat = this.customDrums || this._namedDrums();
      }
    }
    makeMotif() {
      const r = this.rng, st = this.steps, L = 2 * st, dens = this.p.density;
      const w = (i) => (i % 4 === 0 ? .85 : i % 2 === 0 ? .45 : .2) * dens * 1.7;
      let on = []; for (let i = 0; i < L; i++) if (r.random() < Math.min(.95, w(i % st))) on.push(i);
      if (!on.includes(0) && r.random() < .9) on.unshift(0);
      while (on.length < 3) { const x = r.int(L); if (!on.includes(x)) on.push(x); on.sort((a, b) => a - b); }
      const CT = [-5, -3, 0, 2, 4, 7], near = (v) => CT.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
      let rel = r.choice([0, 2, 4]); const notes = [];
      on.forEach((i, j) => {
        const ln = Math.min(8, (j + 1 < on.length ? on[j + 1] : L) - i);
        if (i % 4 === 0) rel = near(rel + r.int(-2, 3)); else rel = Math.max(-3, Math.min(7, rel + r.choice([-2, -1, -1, 0, 1, 1, 2])));
        notes.push([i, rel, ln]);
      });
      notes[notes.length - 1][1] = near(notes[notes.length - 1][1]); return notes;
    }
    varied(notes) { const v = notes.map((n) => n.slice()); for (let i = 0; i < 2; i++) { const k = this.rng.int(v.length); v[k][1] += this.rng.choice([-1, 1]); } return v; }

    melody(gb0) {
      const st = this.steps, mode = this.lead_mode, r = this.rng, ev = [], sb = this.sec_bar;
      if (mode === "motif" || mode === "canon") {
        let m = this.motifs[this.sec.motif];
        if (sb % 4 === 3) { if (!this.var) this.var = this.varied(m); m = this.var; }
        const voices = [[0, 0, 0]]; if (mode === "canon") voices.push([2, 12, .35], [4, 0, -.35]);
        for (const [delay, extra, pan] of voices) {
          if (sb - delay < 0) continue; const par = (sb - delay) % 2;
          for (const [i, rel, ln] of m) if (par * st <= i && i < (par + 1) * st) { const s = i - par * st; ev.push([s, this.leadMidi(this.cdeg(gb0 + s) + rel, extra), ln, i % 4 === 0 ? .75 : .6, pan]); }
        }
      } else if (mode === "markov") {
        let guard = 0;
        while (this.mk.gs < gb0 + st && guard++ < 5000) {
          const s = this.mk.gs - gb0;
          if (s >= 0 && r.random() > .15) {
            const mv = r.choice([-3, -2, -1, -1, 0, 1, 1, 2, 3]); let pos = this.mk.pos + mv;
            if (pos < -3 || pos > 9) pos = this.mk.pos - mv;
            if (s % 4 === 0) { const cd = this.cdeg(this.mk.gs), c = []; for (const o of [0, 2, 4]) for (const k of [-1, 0, 1]) c.push(cd + o + 7 * k); pos = c.reduce((a, b) => (Math.abs(b - pos) < Math.abs(a - pos) ? b : a)); }
            this.mk.pos = pos; const dur = r.choice(this.p.density > .5 ? [1, 2, 2, 3, 4] : [2, 3, 4, 6, 8]);
            ev.push([s, this.leadMidi(pos), dur, .7, 0]); this.mk.gs += dur;
          } else this.mk.gs += r.choice([1, 2, 3, 4]);
        }
      } else if (mode === "sparse") {
        for (let i = r.choice([0, 1, 1, 2]); i > 0; i--) { const s = r.int(0, st), cd = this.cdeg(gb0 + s); ev.push([s, this.leadMidi(cd + r.choice([0, 2, 4, 7, 9])), r.int(4, Math.max(5, st)), .55, r.uniform(-.6, .6)]); }
      } else if (mode === "euclid") {
        const pat = euclid(this.eu_k, st, this.eu_rot);
        for (let s = 0; s < st; s++) if (pat[s]) { const d = this.eu_seq[this.eu_i % this.eu_seq.length]; this.eu_i++; ev.push([s, this.leadMidi(this.cdeg(gb0 + s) + d), st >= 14 ? 1 : 2, .7, 0]); }
      } else if (mode === "phase") {
        if (!this.phs) {
          const L = r.choice([8, 12]), pent = [0, 1, 2, 4, 5, 7], pat = {}, idx = r.shuffle(Array.from({ length: L }, (_, i) => i)).slice(0, Math.floor(L * .65));
          for (const i of idx) pat[i] = r.choice(pent); this.phs = [L, pat];
        }
        const [L, pat] = this.phs;
        for (let s = 0; s < st; s++) {
          const gs = gb0 + s;
          if ((gs % L) in pat) ev.push([s, this.leadMidi(pat[gs % L]), 1, .6, -.5]);
          if ((gs % (L + 1)) in pat && gs % (L + 1) < L) ev.push([s, this.leadMidi(pat[gs % (L + 1)], 12), 1, .5, .5]);
        }
      } else if (mode === "automaton") {
        for (let s = 0; s < st; s += 2) {
          const c = this.ca, nx = []; for (let i = 0; i < 8; i++) nx.push((30 >> (c[(i + 7) % 8] * 4 + c[i] * 2 + c[(i + 1) % 8])) & 1);
          this.ca = nx.some((x) => x) ? nx : Array.from({ length: 8 }, () => r.int(2));
          if (this.ca.reduce((a, b) => a + b, 0) % 2) { let hi = 0; this.ca.forEach((v, i) => { if (v) hi = i; }); ev.push([s, this.leadMidi(this.cdeg(gb0 + s) + hi - 2), 2, .65, 0]); }
        }
      } else if (mode === "lsystem") {
        let guard = 0;
        while (this.ls_gs < gb0 + st && guard++ < 5000) {
          const sym = this.ls[this.ls_ptr % this.ls.length]; this.ls_ptr++;
          if (sym === "+") this.ls_pos = Math.min(9, this.ls_pos + 1);
          else if (sym === "-") this.ls_pos = Math.max(-3, this.ls_pos - 1);
          else { const ln = sym === "A" ? 2 : 1; if (this.ls_gs >= gb0) ev.push([this.ls_gs - gb0, this.leadMidi(this.ls_pos), ln, .65, 0]); this.ls_gs += ln; }
        }
      }
      return ev;
    }

    // ---- the bar
    renderBar() {
      const p = this.p, r = this.rng, st = this.steps, bar_n = this.bar_n, tail = this.tail, len = bar_n + tail;
      this._advance();
      const gb0 = this.gbar * st, bus = this.bus, kicks = [];
      const L = new Set([...this.sec.layers].filter((k) => k !== "tex" && this._has(k)));
      if (!L.size) { const f = ["harm", "lead", "arp", "bass", "drums"].find((k) => this._has(k)); if (f) L.add(f); }

      const add = (b, start, sig, pan, gain) => {
        if (start >= len) return; const nn = Math.min(sig.length, len - start), a = Math.min(sig.length, 40), z = Math.min(sig.length, 350);
        const gl = Math.cos((pan + 1) * Math.PI / 4) * gain, gr = Math.sin((pan + 1) * Math.PI / 4) * gain, BL = bus[b].L, BR = bus[b].R;
        for (let i = 0; i < nn; i++) {
          let e = 1; if (i < a) e = i / a; const j = sig.length - i; if (j <= z) e *= j / z;
          const v = sig[i] * e; BL[start + i] += v * gl; BR[start + i] += v * gr;
        }
      };
      const nm = (m) => mtof(m);

      // drums
      if (L.has("drums") && Object.keys(this.drum_pat).length) {
        const fill = p.drums !== "none" && this.sec_bar === this.sec.bars - 1 && r.random() < .6;
        for (const lane of Object.keys(this.drum_pat)) {
          const pat = this.drum_pat[lane];
          for (let s = 0; s < st; s++) {
            const ch = pat[s % pat.length]; if (ch === ".") continue;
            if (fill && s >= st - 4 && (lane === "s" || lane === "k" || lane === "c")) continue;
            const v = (D.VEL[ch] || .7) * (1 + (p.human > 0 ? r.uniform(-.08, .08) : 0));
            add("drums", this.when(s, true), drum(p.kit, lane), 0, (D.LANE_GAIN[lane] || .3) * v * p.g_drums);
            if (lane === "k") kicks.push(this.when(s));
            if (lane === "h" && p.hat_roll && r.random() < .18) add("drums", this.when(s + .5), drum(p.kit, "h"), 0, D.LANE_GAIN.h * .5 * p.g_drums);
          }
        }
        if (fill) for (let s = st - 4; s < st; s++) {
          add("drums", this.when(s), drum(p.kit, "s"), 0, D.LANE_GAIN.s * (.5 + .12 * (s - st + 4)) * p.g_drums);
          add("drums", this.when(s), drum(p.kit, s % 2 ? "t" : "tl"), ((s % 3) - 1) * .3, .4 * p.g_drums);
        }
      }
      // bass
      if (L.has("bass") && p.bass && D.BASS[p.bass] !== undefined || (L.has("bass") && p.bass && p.bassPat)) {
        const pat = p.bassPat || D.BASS[p.bass], ons = []; for (let i = 0; i < pat.length; i++) if (pat[i] !== ".") ons.push(i);
        if (ons.length) for (let s = 0; s < st; s++) {
          const ch = pat[s % pat.length]; if (ch === ".") continue;
          const gs = gb0 + s, d = this.cdeg(gs); let root = degMidi(this.t60 - 24, this.sc, d);
          while (root >= 47) root -= 12; while (root < 31) root += 12;
          const base = degMidi(0, this.sc, d); let iv;
          if (ch === "R") iv = 0; else if (ch === "O") iv = 12; else if (ch === "5") iv = degMidi(0, this.sc, d + 4) - base; else if (ch === "3") iv = degMidi(0, this.sc, d + 2) - base;
          else iv = degMidi(0, this.sc, d + r.choice([0, 2, 4])) - base;
          if ("53C".includes(ch)) iv = ((iv % 12) + 12) % 12;
          const pos = s % pat.length; let nxt = ons.find((o) => o > pos); if (nxt === undefined) nxt = pat.length + ons[0];
          const ln = Math.min(p.bass_hold, nxt - pos);
          add("bass", this.when(s), play(p.bass_inst, nm(root + iv), ln * this.stepdur * .92, .8, 0, r), 0, p.g_bass);
        }
      }
      // harmony
      if (L.has("harm") && p.harm) {
        if (p.harm === "sustain") {
          for (let s = 0; s < st; s++) {
            const gs = gb0 + s, first = this.sec_bar === 0 && s === 0;
            if (gs % this.slot === 0 || first) {
              const left = this.slot - gs % this.slot, deg = this.cdeg(gs);
              for (const m of this.voicing(deg)) for (const [det, pan] of [[-7, -.55], [7, .55]])
                add("harm", this.when(s), play(p.harm_inst, nm(m), left * this.stepdur, .8, det, r), pan, p.g_harm * .6);
            }
          }
        } else {
          const pat = p.stab;
          for (let s = 0; s < st; s++) {
            const ch = pat[s % pat.length]; if (ch === ".") continue; const v = D.VEL[ch] || .7;
            this.voicing(this.cdeg(gb0 + s), 50).forEach((m, i) => add("harm", this.when(s, true) + Math.floor(i * p.strum * .001 * SR),
              play(p.harm_inst, nm(m), p.stab_len * this.stepdur, v, 0, r), r.uniform(-.2, .2), p.g_harm * v));
          }
        }
      }
      // lead + arp
      if (L.has("lead") && p.lead) for (const [s, m, ln, v, pan] of this.melody(gb0))
        add("lead", this.when(s, true), play(p.lead_inst, nm(m), ln * this.stepdur * .95, v, 0, r), pan, p.g_lead * v);
      if (L.has("arp") && p.arp) {
        const seq = D.ARPS[p.arp], rate = p.arp_rate;
        for (let s = 0; s < st; s += rate) {
          if (r.random() > p.arp_prob) continue;
          const gs = gb0 + s, d = this.cdeg(gs), tones = [d, d + 2, d + 4, d + 7], k = seq ? seq[Math.floor(gs / rate) % seq.length] : r.int(4);
          let m = degMidi(this.t60 + 12 * p.arp_oct, this.sc, tones[k % 4] + 7 * Math.floor(k / 4)); while (m > 90) m -= 12;
          add("arp", this.when(s, true), play(p.arp_inst, nm(m), rate * this.stepdur * .9, .6, 0, r), Math.sin(gs * .7) * .5, p.g_arp);
        }
      }
      // sidechain pump on the non-drum buses
      if (p.sidechain && kicks.length) {
        const g = new Float32Array(bar_n).fill(1);
        for (const k0 of kicks) { const m = Math.min(Math.floor(.4 * SR), bar_n - k0); for (let i = 0; i < m; i++) g[k0 + i] = Math.min(g[k0 + i], 1 - p.sidechain * Math.exp(-i / (.11 * SR))); }
        for (const b of ["bass", "harm", "lead", "arp"]) for (let i = 0; i < bar_n; i++) { bus[b].L[i] *= g[i]; bus[b].R[i] *= g[i]; }
      }
      // emit this bar (copy), then shift the spill-over tails to the front
      const out = {}; let sq = 0;
      for (const b of BUSES) { out[b] = [bus[b].L.slice(0, bar_n), bus[b].R.slice(0, bar_n)]; }
      for (let i = 0; i < bar_n; i++) { let l = 0, rr = 0; for (const b of BUSES) { l += out[b][0][i]; rr += out[b][1][i]; } sq += l * l + rr * rr; }
      for (const b of BUSES) for (const c of ["L", "R"]) { bus[b][c].copyWithin(0, bar_n); bus[b][c].fill(0, tail); }
      // gain riding (AGC on the dry mix), crush / sample-rate reduction
      const rms = Math.sqrt(sq / (2 * bar_n)), tgt = rms > 1e-4 ? Math.max(.2, Math.min(4, .1 / (rms + 1e-5))) : (this.gain || 1);
      const g0 = this.gain === null ? tgt : this.gain; this.gain = this.gain === null ? tgt : g0 * .6 + tgt * .4;
      const q = p.crush ? Math.pow(2, p.crush) : 0, srr = p.srr > 1 ? p.srr : 0;
      for (const b of BUSES) for (const ch of out[b]) {
        for (let i = 0; i < bar_n; i++) ch[i] *= g0 + (this.gain - g0) * i / bar_n;
        if (srr) for (let i = 0; i < bar_n; i++) if (i % srr) ch[i] = ch[i - (i % srr)];
        if (q) for (let i = 0; i < bar_n; i++) ch[i] = Math.round(ch[i] * q) / q;
      }
      const tex = p.tex ? this._texture(bar_n) : null;
      const info = this._barInfo(gb0, L);
      this.gbar++; this.sec_bar++; this.section_done = this.sec_bar >= this.sec.bars;
      return { n: bar_n, buses: out, tex, info };
    }

    _barInfo(gb0, L) {
      const chords = [], starts = [];
      for (let s = 0; s < this.steps; s += this.slot) { const d = this.cdeg(gb0 + s); chords.push({ deg: d, name: this.chordName(d) }); starts.push(s); }
      if (!chords.length) { const d = this.cdeg(gb0); chords.push({ deg: d, name: this.chordName(d) }); starts.push(0); }
      return {
        bar: this.gbar, section: this.sec.name, secBar: this.sec_bar, secBars: this.sec.bars, layers: Array.from(L), chords, chordStarts: starts,
        steps: this.steps, bpm: this.bpm, dur: this.bar_n / SR, progIndex: Math.floor(gb0 / this.slot) % this.prog.length, progLen: this.prog.length,
      };
    }

    _texture(n) {
      const r = this.rng, kind = this.p.tex, x = [new Float32Array(n), new Float32Array(n)];
      if (kind === "vinyl") {
        for (const c of x) for (let i = 0; i < n; i++) c[i] = r.normal(0, .0025);
        for (let k = r.poisson(14 * n / SR); k > 0; k--) { const i = r.int(n), v = r.normal(0, .06); x[0][i] += v; x[1][i] += v; }
      } else if (kind === "tape") { for (const c of x) for (let i = 0; i < n; i++) c[i] = r.normal(0, .002); }
      else if (kind === "rain") {
        for (const c of x) { const z = noise(r, n + 3, .02); for (let i = 0; i < n; i++) c[i] = (z[i] + z[i + 1] + z[i + 2] + z[i + 3]) / 4; }
        for (let k = r.poisson(40 * n / SR); k > 0; k--) { const i = r.int(n), v = r.normal(0, .05); x[0][i] += v; x[1][i] += v; }
      } else { // wind: continuous resonant band-pass noise at ~500 Hz, kept very quiet
        const w0 = TAU * 500 / SR, Q = 1.7, al = Math.sin(w0) / (2 * Q), b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * Math.cos(w0), a2 = 1 - al;
        let s2 = 0;
        x.forEach((c, ch) => {
          const st = this.windState[ch];
          for (let i = 0; i < n; i++) { const v = r.normal(0, 1), o = (b0 * v + b2 * st[1] - a1 * st[2] - a2 * st[3]) / a0; st[1] = st[0]; st[0] = v; st[3] = st[2]; st[2] = o; c[i] = o; s2 += o * o; }
        });
        if (this.windScale === null) this.windScale = .011 / (Math.sqrt(s2 / (2 * n)) + 1e-9);
        for (const c of x) for (let i = 0; i < n; i++) c[i] *= this.windScale;
      }
      return x;
    }

    adopt(prev) {
      for (const b of BUSES) { const m = Math.min(this.bus[b].L.length, prev.bus[b].L.length); this.bus[b].L.set(prev.bus[b].L.subarray(0, m)); this.bus[b].R.set(prev.bus[b].R.subarray(0, m)); }
      this.gain = prev.gain;
    }
  }

  G.MG = {
    Piece, RNG, setSampleRate(sr) { SR = sr; for (const k of Object.keys(DR)) delete DR[k]; for (const k of Object.keys(GAIN)) delete GAIN[k]; },
    get SR() { return SR; }, INST_NAMES: Object.keys(INST), LEAD_MODES, PROG_KINDS,
    STYLE_NAMES: Object.keys(D.STYLES),
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
