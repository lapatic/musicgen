/* app.js - UI, scheduling and export for musicgen. The music itself is made in worker.js / engine.js. */
(function () {
  "use strict";
  const D = window.MG_DATA;
  const $ = (s, root) => (root || document).querySelector(s);
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(kid));
    return e;
  }
  const rand = () => 1 + Math.floor(Math.random() * 999999998);
  const pretty = (s) => String(s).replace(/_/g, " ");

  // ------------------------------------------------------------------ option lists
  const STYLE_GROUPS = [
    ["Beats & electronic", ["lofi", "jazzhop", "boombap", "vaporwave", "citypop", "synthwave", "synthpop", "house", "deephouse", "techno", "dubtechno", "trance", "dnb", "breaks", "trap", "reggae", "funk", "disco", "tropical"]],
    ["Acoustic & classical", ["jazz", "bossa", "folk", "celtic", "eastern", "waltz", "canon", "piano", "musicbox", "epic", "rainy_piano"]],
    ["Ambient & atmospheric", ["ambient", "darkambient", "drone", "space", "horror", "zen", "gamelan"]],
    ["Generative & odd", ["minimal", "euclid", "cellular", "fractal", "odd7", "odd5", "chiptune", "8bit_battle"]],
  ];
  const OFFABLE = (list) => ["off"].concat(list);
  const LISTS = {
    scale: Object.keys(D.SCALES), prog: ["pop", "minor", "jazz", "vamp", "func", "drift", "static", "canon"], chord: Object.keys(D.CHORDS),
    form: ["edm", "song", "jam", "ambient", "loop"], lead: ["motif", "markov", "euclid", "phase", "automaton", "lsystem", "canon", "sparse"],
    inst: D.INST_NAMES, kit: Object.keys(D.KITS), drums: Object.keys(D.DRUMS), bass: OFFABLE(Object.keys(D.BASS)), arp: OFFABLE(Object.keys(D.ARPS)),
    harm: ["sustain", "stab", "off"], tex: ["off", "vinyl", "tape", "rain", "wind"], keys: D.KEYS,
  };
  const LANES = [["k", "Kick"], ["s", "Snare"], ["c", "Clap"], ["h", "Hi-hat"], ["o", "Open hat"], ["r", "Rim"], ["t", "Tom"], ["tl", "Low tom"], ["d", "Ride"], ["sh", "Shaker"], ["cb", "Cowbell"], ["cg", "Conga"]];
  const LAYERS = [["drums", "Drums"], ["bass", "Bass"], ["harm", "Harmony"], ["lead", "Lead"], ["arp", "Arp"], ["tex", "Texture"]];
  const ALL_STYLES = Object.keys(D.STYLES);

  // ------------------------------------------------------------------ state
  const S = {
    ctx: null, g: null, worker: null, sr: 44100, gen: 0, epoch: 0, req: 0, pending: -1, inflight: false, ready: false,
    playing: false, nextTime: 0, bars: [], sources: [], desc: null, overrides: {}, style: "lofi", seed: rand(),
    ui: { vol: {}, mute: {}, master: .85, cutoff: 20000 }, controls: {}, curBar: null, lastSectionDone: false,
    rot: { on: false, minutes: 4, styles: new Set(ALL_STYLES), last: 0, chaos: false }, pendingUpdate: {}, updTimer: 0, rec: null,
  };
  const setStatus = (t) => { $("#status").textContent = t || ""; };

  // ------------------------------------------------------------------ worker
  function startWorker() {
    S.worker = new Worker("worker.js");
    S.worker.onmessage = onWorker;
    S.worker.onerror = (e) => setStatus("Worker error: " + (e.message || "failed to load worker.js (open this page from a web server, not file://)"));
    S.worker.postMessage({ type: "init", sr: S.sr });
  }
  function onWorker(e) {
    const m = e.data;
    if (m.type === "piece") {
      if (m.gen !== S.gen) return;
      S.desc = m.desc; if (m.irs && S.g) S.g.setIRs(m.irs); else if (m.irs) S.pendingIRs = m.irs;
      syncUI(); applyMix();
    } else if (m.type === "bar") {
      if (m.req === S.pending) { S.inflight = false; S.pending = -1; }
      if (m.gen !== S.gen || m.epoch !== S.epoch || !S.g) return;
      scheduleBar(m.bar); S.lastSectionDone = m.sectionDone;
    } else if (m.type === "error") setStatus("Engine error: " + m.message.split("\n")[0]);
  }
  function newPiece(o) {
    o = o || {};
    S.gen++; S.style = o.style || S.style; S.seed = o.seed || S.seed; if (o.overrides !== undefined) S.overrides = o.overrides;
    S.worker.postMessage({ type: "new", gen: S.gen, style: S.style, seed: S.seed, overrides: S.overrides, adopt: !!o.adopt });
    if (!o.adopt && S.g) cutAudio();
    S.inflight = false; S.pending = -1; if (!o.adopt) S.epoch++;
    $("#seedInput").value = S.seed;
    for (const c of document.querySelectorAll(".chip[data-style]")) c.classList.toggle("on", c.dataset.style === S.style);
    if (o.adopt) S.rot.last = performance.now();
  }
  function sendUpdate(obj) {
    Object.assign(S.overrides, obj); Object.assign(S.pendingUpdate, obj);
    clearTimeout(S.updTimer);
    S.updTimer = setTimeout(() => {
      const u = S.pendingUpdate; S.pendingUpdate = {};
      S.worker.postMessage({ type: "update", overrides: u });
      if (S.g && $("#instant").checked && S.playing) flushFuture();
    }, 90);
  }

  // ------------------------------------------------------------------ audio + scheduling
  async function ensureAudio() {
    if (S.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    try { S.ctx = new AC({ sampleRate: 44100, latencyHint: "playback" }); } catch (e) { S.ctx = new AC({ latencyHint: "playback" }); }
    S.g = AudioKit.buildGraph(S.ctx, true);
    if (S.ctx.sampleRate !== S.sr) { S.sr = S.ctx.sampleRate; S.worker.postMessage({ type: "init", sr: S.sr }); newPiece({ overrides: S.overrides }); }
    else if (S.pendingIRs) { S.g.setIRs(S.pendingIRs); S.pendingIRs = null; }
    applyMix();
    drawLoop();
  }
  async function play() {
    await ensureAudio(); await S.ctx.resume();
    if (!S.playing) { S.playing = true; if (S.nextTime < S.ctx.currentTime + .1) S.nextTime = S.ctx.currentTime + .15; if (!S.rot.last) S.rot.last = performance.now(); }
    updatePlayBtn();
  }
  async function pause() { if (!S.ctx) return; S.playing = false; await S.ctx.suspend(); updatePlayBtn(); }
  function togglePlay() { (S.playing ? pause : play)(); }
  function updatePlayBtn() { $("#playIcon").textContent = S.playing ? "❚❚" : "▶"; $("#playText").textContent = S.playing ? "Pause" : "Play"; }

  function scheduleBar(bar) {
    const now = S.ctx.currentTime; if (S.nextTime < now + .04) S.nextTime = now + .1;
    const when = S.nextTime, dur = bar.n / S.ctx.sampleRate;
    for (const s of S.g.schedule(bar, when)) S.sources.push(s);
    S.bars.push({ start: when, end: when + dur, info: bar.info });
    S.nextTime += dur;
    S.sources = S.sources.filter((s) => s.when + 12 > now); S.bars = S.bars.filter((b) => b.end + 4 > now);
  }
  function flushFuture() { // drop everything queued after the bar that's playing now
    if (!S.ctx) return; const now = S.ctx.currentTime, cur = S.bars.find((b) => b.start <= now && now < b.end), cutoff = cur ? cur.end : now + .06;
    for (const s of S.sources) if (s.when >= cutoff - 1e-6) { try { s.node.stop(); } catch (e) { /* not started */ } }
    S.sources = S.sources.filter((s) => s.when < cutoff - 1e-6); S.bars = S.bars.filter((b) => b.start < cutoff - 1e-6);
    S.nextTime = cutoff; S.epoch++; S.inflight = false; S.pending = -1;
  }
  function cutAudio() { // hard cut with a tiny fade (new style chosen)
    if (!S.ctx) return; const t = S.ctx.currentTime, d = S.g.duck.gain;
    d.cancelScheduledValues(t); d.setValueAtTime(d.value, t); d.linearRampToValueAtTime(0, t + .05);
    const old = S.sources.slice(); S.sources = []; S.bars = [];
    setTimeout(() => { for (const s of old) { try { s.node.stop(); } catch (e) { /* done */ } } const t2 = S.ctx.currentTime; d.cancelScheduledValues(t2); d.setValueAtTime(0, t2); d.linearRampToValueAtTime(1, t2 + .08); }, 70);
    S.nextTime = t + .13; S.epoch++;
  }
  function pump() {
    if (!S.playing || !S.ctx || S.inflight || !S.desc) return;
    const ahead = S.nextTime - S.ctx.currentTime, barDur = S.desc.steps * 60 / S.desc.bpm / 4, need = Math.max(3.2, barDur * 1.35);
    if (ahead > need) return;
    // auto-evolve: move to a new style at the end of a section
    const r = S.rot;
    if (r.on && S.lastSectionDone && performance.now() - r.last > r.minutes * 60000 && r.styles.size) {
      S.lastSectionDone = false;
      const pool = Array.from(r.styles).filter((s) => s !== S.style), choice = r.chaos ? "chaos" : (pool.length ? pool[Math.floor(Math.random() * pool.length)] : S.style);
      newPiece({ style: choice, seed: rand(), overrides: {}, adopt: true }); return;
    }
    S.inflight = true; S.pending = ++S.req;
    S.worker.postMessage({ type: "next", gen: S.gen, epoch: S.epoch, req: S.pending });
  }

  // ------------------------------------------------------------------ mix (main-thread only parameters)
  function applyMix() {
    if (!S.g) return; const t = S.ctx.currentTime, g = S.g;
    for (const [n] of LAYERS) { const v = S.ui.mute[n] ? 0 : (S.ui.vol[n] === undefined ? 1 : S.ui.vol[n]); g.bus[n].gain.setTargetAtTime(v, t, .02); }
    g.vol.gain.setTargetAtTime(S.ui.master, t, .02);
    const lofi = S.desc && S.desc.params.lofi; g.lp.frequency.setTargetAtTime(Math.min(S.ui.cutoff, lofi ? 3200 : 20000), t, .03);
  }

  // ------------------------------------------------------------------ UI: controls
  function regControl(key, setter) { S.controls[key] = setter; }
  function field(label, node, valueEl, cls) {
    return h("div", { class: "ctl" + (cls ? " " + cls : "") }, h("span", { class: "lab" }, label, valueEl || ""), node);
  }
  function mkSelect(key, label, options, o) {
    o = o || {}; const sel = h("select", { "aria-label": label });
    for (const op of options) sel.append(h("option", { value: String(op), text: o.names ? o.names[op] : pretty(op) }));
    sel.addEventListener("change", () => { let v = sel.value; if (o.num) v = Number(v); if (v === "off") v = null; (o.onChange || ((x) => sendUpdate({ [key]: x })))(v); });
    regControl(key, (v) => { sel.value = v === null || v === undefined ? "off" : String(v); });
    return field(label, sel);
  }
  function mkRange(key, label, min, max, step, o) {
    o = o || {}; const val = h("b", { text: "" }), inp = h("input", { type: "range", min, max, step, "aria-label": label });
    const show = () => { val.textContent = (o.fmt ? o.fmt(Number(inp.value)) : inp.value); };
    inp.addEventListener("input", () => { show(); (o.onChange || ((x) => sendUpdate({ [key]: x })))(Number(inp.value)); });
    regControl(key, (v) => { if (document.activeElement !== inp) { inp.value = v; show(); } });
    return field(label, inp, val);
  }
  function mkToggle(key, label, o) {
    o = o || {}; const inp = h("input", { type: "checkbox", "aria-label": label });
    inp.addEventListener("change", () => (o.onChange || ((x) => sendUpdate({ [key]: x })))(inp.checked));
    regControl(key, (v) => { inp.checked = !!v; });
    return h("label", { class: "ctl inline" }, inp, label);
  }
  function mkText(key, label, o) {
    const inp = h("input", { type: "text", spellcheck: "false", "aria-label": label, size: o.size || 24 });
    inp.addEventListener("change", () => o.onChange(inp.value.trim()));
    regControl(key, (v) => { if (document.activeElement !== inp) inp.value = v; });
    return field(label, inp, null, o.cls);
  }
  const sep = (t) => h("div", { class: "sep", text: t });

  // step sequencers (drums / bass / stab)
  function cycle(list, cur) { const i = list.indexOf(cur); return list[(i + 1) % list.length]; }
  function tile(str, n) { let o = ""; if (!str) return ".".repeat(n); for (let i = 0; i < n; i++) o += str[i % str.length]; return o; }
  function renderSeqs() {
    const d = S.desc; if (!d) return; const n = d.steps, wrap = $("#seqWrap"); wrap.textContent = "";
    const rowOf = (name, str, kind, onEdit) => {
      const row = h("div", { class: "seqrow" }, h("span", { class: "nm", text: name }));
      for (let i = 0; i < n; i++) {
        const ch = str[i], c = h("button", { class: "cell " + (ch === "." ? (i % 4 === 0 ? "beat" : "") : ch === "5" || ch === "3" || ch === "C" || ch === "O" ? "L5" : ch), "data-i": i, "aria-label": `${name} step ${i + 1}`, text: ch === "." ? "" : ch });
        c.addEventListener("click", () => { const cur = str[i], list = kind === "drum" ? [".", "o", "x", "X"] : kind === "bass" ? [".", "R", "5", "3", "O", "C"] : [".", "x", "X"]; onEdit(str.slice(0, i) + cycle(list, cur) + str.slice(i + 1)); });
        row.append(c);
      }
      return row;
    };
    wrap.append(h("div", { class: "legend", text: "Drums: click a step to cycle  –  o ghost, x normal, X accent." }));
    const grid = h("div", { class: "seq" }), pats = {};
    for (const [lane] of LANES) pats[lane] = tile((d.drumPat || {})[lane], n);
    for (const [lane, name] of LANES) grid.append(rowOf(name, pats[lane], "drum", (np) => {
      pats[lane] = np; const out = {}; for (const [l] of LANES) if (/[oxX]/.test(pats[l])) out[l] = pats[l];
      sendUpdate({ drumPat: out }); d.drumPat = out; renderSeqs();
    }));
    wrap.append(grid);
    wrap.append(h("div", { class: "legend", text: "Bass line: R root, 5 fifth, 3 third, O octave, C random chord tone." }));
    const bp = tile(d.bassPat, n), bg = h("div", { class: "seq" });
    bg.append(rowOf("Bass", bp, "bass", (np) => { sendUpdate({ bassPat: np, bass: d.params.bass || "root8" }); d.bassPat = np; d.params.bassPat = np; renderSeqs(); }));
    wrap.append(bg);
    wrap.append(h("div", { class: "legend", text: "Chord hits (used when Harmony is set to stab):" }));
    const sg = h("div", { class: "seq" }); sg.append(rowOf("Chord hits", tile(d.params.stab, n), "stab", (np) => { sendUpdate({ stab: np }); d.params.stab = np; renderSeqs(); }));
    wrap.append(sg);
  }

  function buildTabs() {
    const tabs = [
      ["Mix", () => {
        const g = h("div", { class: "grid" });
        g.append(sep("Layer volumes"));
        for (const [n, label] of LAYERS) {
          const inp = h("input", { type: "range", min: 0, max: 1.5, step: .01, value: 1, "aria-label": label + " volume" });
          const mute = h("button", { class: "mute", text: "M", title: "Mute " + label, "aria-label": "Mute " + label });
          inp.addEventListener("input", () => { S.ui.vol[n] = Number(inp.value); applyMix(); });
          mute.addEventListener("click", () => { S.ui.mute[n] = !S.ui.mute[n]; mute.classList.toggle("on", S.ui.mute[n]); applyMix(); refreshPills(); });
          g.append(h("div", { class: "ctl wide" }, h("div", { class: "mixrow" }, h("span", { class: "lab", text: label }), inp, mute)));
        }
        g.append(sep("Space & colour"));
        g.append(mkRange("rev", "Reverb amount", 0, 1.2, .01, { fmt: (v) => v.toFixed(2) }), mkRange("rev_len", "Reverb length", .3, 4, .1, { fmt: (v) => v.toFixed(1) + " s" }),
          mkRange("delay", "Echo amount", 0, .9, .01, { fmt: (v) => v.toFixed(2) }), mkRange("delay_steps", "Echo time", 1, 8, 1, { fmt: (v) => v + " steps" }),
          mkToggle("lofi", "Lo-fi (warm low-pass)", { onChange: (v) => { sendUpdate({ lofi: v }); if (S.desc) S.desc.params.lofi = v; applyMix(); } }),
          mkRange("cutoff", "Master filter", 200, 20000, 1, { fmt: (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : v + " Hz"), onChange: (v) => { S.ui.cutoff = v; applyMix(); } }),
          mkRange("sidechain", "Sidechain pump", 0, .9, .01, { fmt: (v) => v.toFixed(2) }), mkRange("crush", "Bit crush (0 = off)", 0, 12, 1, { fmt: (v) => (v ? v + " bit" : "off") }),
          mkRange("srr", "Sample-rate crush", 1, 8, 1, { fmt: (v) => (v === 1 ? "off" : "/" + v) }), mkRange("swing", "Swing", 0, .5, .01, { fmt: (v) => v.toFixed(2) }),
          mkRange("human", "Humanize", 0, 1, .01, { fmt: (v) => v.toFixed(2) }));
        return g;
      }],
      ["Music", () => {
        const g = h("div", { class: "grid" });
        g.append(mkRange("bpm", "Tempo", 40, 220, 1, { fmt: (v) => v + " BPM" }), mkSelect("key", "Key", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], { num: true, names: D.KEYS }),
          mkSelect("scale", "Scale", LISTS.scale), mkSelect("chord", "Chord type", LISTS.chord), mkSelect("form", "Song form", LISTS.form),
          mkSelect("hr", "Chord changes per bar", [0.25, 0.5, 1, 2], { num: true, names: { 0.25: "1 per 4 bars", 0.5: "1 per 2 bars", 1: "1 per bar", 2: "2 per bar" } }),
          mkSelect("steps", "Meter", [12, 14, 16, 20], { num: true, names: { 12: "3/4 (12 steps)", 14: "7/8 (14 steps)", 16: "4/4 (16 steps)", 20: "5/4 (20 steps)" } }));
        g.append(sep("Chord progression"));
        g.append(mkSelect("prog", "Progression type", LISTS.prog, { onChange: (v) => sendUpdate({ prog: v }) }),
          mkText("progCustom", "Or type your own (scale degrees, 0 = tonic)", { size: 18, onChange: (t) => { const a = t.split(/[\s,]+/).filter(Boolean).map(Number).filter((x) => Number.isFinite(x)); if (a.length) sendUpdate({ progCustom: a }); } }));
        g.append(sep("Melody"));
        g.append(mkSelect("lead", "Melody mode", LISTS.lead), mkRange("density", "Melody density", .1, 1, .01, { fmt: (v) => v.toFixed(2) }), mkRange("lead_oct", "Melody octave", 0, 2, 1, { fmt: (v) => "+" + v }),
          mkSelect("arp", "Arpeggio pattern", LISTS.arp), mkSelect("arp_rate", "Arpeggio speed", [1, 2, 4], { num: true, names: { 1: "16ths", 2: "8ths", 4: "quarters" } }),
          mkRange("arp_oct", "Arpeggio octave", 0, 2, 1, { fmt: (v) => "+" + v }), mkRange("arp_prob", "Arpeggio note chance", .1, 1, .01, { fmt: (v) => v.toFixed(2) }));
        return g;
      }],
      ["Instruments", () => {
        const g = h("div", { class: "grid" });
        g.append(mkSelect("lead_inst", "Lead", LISTS.inst), mkSelect("arp_inst", "Arpeggio", LISTS.inst), mkSelect("harm_inst", "Harmony", LISTS.inst), mkSelect("bass_inst", "Bass", LISTS.inst),
          mkSelect("kit", "Drum kit", LISTS.kit), mkSelect("harm", "Harmony style", LISTS.harm), mkSelect("tex", "Background texture", LISTS.tex),
          mkRange("stab_len", "Chord-hit length", 1, 8, 1, { fmt: (v) => v + " steps" }), mkRange("strum", "Strum", 0, 60, 1, { fmt: (v) => v + " ms" }),
          mkToggle("hat_roll", "Trap-style hat rolls"));
        return g;
      }],
      ["Rhythm", () => {
        const g = h("div", {});
        const top = h("div", { class: "grid" }, mkSelect("drums", "Drum groove", LISTS.drums, { onChange: (v) => sendUpdate({ drumPat: null, drums: v || "none" }) }),
          mkSelect("bass", "Bass pattern", LISTS.bass, { onChange: (v) => sendUpdate({ bassPat: null, bass: v }) }));
        g.append(top, h("div", { id: "seqWrap", class: "ctl wide", style: "margin-top:14px" }));
        return g;
      }],
      ["Auto-evolve", () => {
        const g = h("div", {});
        const on = h("input", { type: "checkbox", id: "rotOn" }), mins = h("input", { type: "range", min: .5, max: 15, step: .5, value: 4 }), minLab = h("b", { text: "4 min" });
        on.addEventListener("change", () => { S.rot.on = on.checked; S.rot.last = performance.now(); });
        mins.addEventListener("input", () => { S.rot.minutes = Number(mins.value); minLab.textContent = mins.value + " min"; });
        const chaos = h("input", { type: "checkbox" }); chaos.addEventListener("change", () => { S.rot.chaos = chaos.checked; });
        g.append(h("p", { text: "Turn this on and the music wanders forever: at the end of a section after the time below, it glides into a different style (reverb tails carry over so it flows). Choose which styles it may use." }),
          h("div", { class: "row" }, h("label", { class: "inline" }, on, "Keep changing style"), h("label", { class: "inline" }, chaos, "Use random hybrids (chaos) instead")),
          h("div", { class: "ctl", style: "max-width:360px;margin-top:10px" }, h("span", { class: "lab" }, "Change every", minLab), mins));
        const box = h("div", { class: "chkgrid", style: "margin-top:12px" });
        for (const s of ALL_STYLES) {
          const b = h("button", { class: "chip on", text: pretty(s) });
          b.addEventListener("click", () => { if (S.rot.styles.has(s)) S.rot.styles.delete(s); else S.rot.styles.add(s); b.classList.toggle("on", S.rot.styles.has(s)); });
          box.append(b);
        }
        const all = h("button", { class: "btn small", text: "All" }), none = h("button", { class: "btn small", text: "None" });
        all.addEventListener("click", () => { S.rot.styles = new Set(ALL_STYLES); for (const b of box.children) b.classList.add("on"); });
        none.addEventListener("click", () => { S.rot.styles.clear(); for (const b of box.children) b.classList.remove("on"); });
        g.append(h("div", { class: "row", style: "margin-top:10px" }, all, none), box);
        return g;
      }],
      ["Export", () => {
        const g = h("div", {}), secs = h("input", { type: "number", min: 5, max: 600, value: 60, style: "width:90px" }), bar = h("div", { class: "progress", hidden: true }, h("i")), msg = h("span", { class: "legend" });
        const btn = h("button", { class: "btn primary", text: "Render WAV" }), rec = h("button", { class: "btn", text: "⏺ Record live" });
        btn.addEventListener("click", async () => {
          btn.disabled = true; bar.hidden = false;
          try { await exportWav(Math.max(5, Math.min(600, Number(secs.value) || 60)), (f, t) => { bar.firstChild.style.width = (f * 100).toFixed(0) + "%"; msg.textContent = t || ""; }); msg.textContent = "Done - check your downloads."; }
          catch (e) { msg.textContent = "Export failed: " + e.message; }
          btn.disabled = false; setTimeout(() => { bar.hidden = true; }, 1500);
        });
        rec.addEventListener("click", () => toggleRecord(rec, msg));
        g.append(h("p", { text: "Render a track of the current piece (with your tweaks) to a 16-bit stereo WAV, faster than real time. It starts from the beginning of the piece, like the shared link does, and fades out at the end." }),
          h("div", { class: "row" }, h("label", { class: "inline" }, "Length (seconds)", secs), btn), bar, msg,
          h("p", { style: "margin-top:16px", text: "Or record whatever you are hearing right now (including live tweaks) as a compressed audio file." }), h("div", { class: "row" }, rec));
        return g;
      }],
    ];
    const bar = $("#tabBar"), panels = $("#tabPanels");
    tabs.forEach(([name, build], i) => {
      const id = "tab" + i, b = h("button", { class: "tab" + (i === 0 ? " on" : ""), role: "tab", id, text: name, "aria-controls": id + "p" });
      const p = h("div", { class: "panel" + (i === 0 ? " on" : ""), id: id + "p", role: "tabpanel" }, build());
      b.addEventListener("click", () => { for (const x of bar.children) x.classList.remove("on"); for (const x of panels.children) x.classList.remove("on"); b.classList.add("on"); p.classList.add("on"); });
      bar.append(b); panels.append(p);
    });
  }

  function buildStyles() {
    const grid = $("#styleGrid");
    for (const [title, names] of STYLE_GROUPS) {
      const row = h("div", { class: "sg-row" });
      for (const n of names) row.append(h("button", { class: "chip", "data-style": n, text: pretty(n), onclick: () => pickStyle(n) }));
      grid.append(h("div", { class: "sg-title", text: title }), row);
    }
    grid.append(h("div", { class: "sg-title", text: "Surprise me" }), h("div", { class: "sg-row" },
      h("button", { class: "chip chaos", "data-style": "chaos", text: "chaos (random hybrid)", onclick: () => pickStyle("chaos") })));
  }
  function pickStyle(n) { newPiece({ style: n, seed: rand(), overrides: {} }); if (!S.playing) play(); }

  // ------------------------------------------------------------------ UI sync
  function valueFor(key, d) {
    if (key === "bpm") return d.bpm; if (key === "key") return d.key; if (key === "prog") return d.progKind; if (key === "progCustom") return d.prog.join(" ");
    if (key === "bass") return d.params.bassPat && !d.params.bass ? "off" : d.params.bass;
    return d.params[key];
  }
  function syncUI() {
    const d = S.desc; if (!d) return;
    for (const key of Object.keys(S.controls)) { if (key === "cutoff") continue; const v = valueFor(key, d); if (v !== undefined) S.controls[key](v); }
    S.controls.cutoff && S.controls.cutoff(S.ui.cutoff);
    const lofi = $("#npSub");
    lofi.textContent = `${D.KEYS[d.key]} ${pretty(d.params.scale)} · ${d.bpm} BPM · ${d.steps === 16 ? "4/4" : d.steps === 12 ? "3/4" : d.steps === 14 ? "7/8" : "5/4"} · ${pretty(d.leadMode)} melody`;
    $("#npStyle").textContent = pretty(d.style);
    $("#seedInput").value = d.seed;
    for (const c of document.querySelectorAll(".chip[data-style]")) c.classList.toggle("on", c.dataset.style === d.style);
    buildChords(); buildStepDots(); renderSeqs(); refreshPills();
  }
  function buildChords() {
    const d = S.desc, sc = D.SCALES[d.params.scale], strip = $("#chordStrip"); strip.textContent = "";
    d.prog.forEach((deg, i) => { const L = sc.length, o = Math.floor(deg / L), idx = deg - o * L; strip.append(h("div", { class: "chord", "data-i": i, text: D.KEYS[(d.key + sc[idx]) % 12] })); });
  }
  function buildStepDots() {
    const n = S.desc.steps, el = $("#stepDots"); if (el.children.length === n) return; el.textContent = "";
    for (let i = 0; i < n; i++) el.append(h("i", { class: i % 4 === 0 ? "q" : "" }));
  }
  function refreshPills() {
    const box = $("#layerPills"), info = S.curBar && S.curBar.info, d = S.desc;
    if (!box.children.length) for (const [n, label] of LAYERS) box.append(h("span", { class: "pill", "data-n": n, text: label }));
    for (const p of box.children) {
      const n = p.dataset.n; let on = false;
      if (info) on = n === "tex" ? !!(d && d.params.tex) : info.layers.includes(n);
      p.classList.toggle("on", on && S.playing); p.classList.toggle("muted", !!S.ui.mute[n]);
    }
  }

  // ------------------------------------------------------------------ live display (visualizer, playhead)
  let lastBarKey = null;
  function drawLoop() {
    const cv = $("#viz"), c = cv.getContext("2d"), data = new Uint8Array(S.g.analyser.frequencyBinCount), wave = new Uint8Array(S.g.analyser.fftSize);
    const fr = () => {
      requestAnimationFrame(fr);
      const W = cv.width, H = cv.height; c.clearRect(0, 0, W, H);
      S.g.analyser.getByteFrequencyData(data); S.g.analyser.getByteTimeDomainData(wave);
      const n = 84, bw = W / n;
      c.fillStyle = "#16a34a"; let bass = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.pow(i / n, 2.1) * (data.length * .75), b = Math.pow((i + 1) / n, 2.1) * (data.length * .75); let m = 0;
        for (let k = Math.floor(a); k <= Math.max(Math.floor(a), Math.floor(b)); k++) m = Math.max(m, data[k]);
        const v = m / 255, hgt = Math.max(2, v * v * H * .95); if (i < 5) bass = Math.max(bass, v);
        c.globalAlpha = .35 + v * .65; c.fillRect(i * bw + 1, H - hgt, bw - 2, hgt);
      }
      c.globalAlpha = .9; c.strokeStyle = "#ca8a04"; c.lineWidth = 2; c.beginPath();
      for (let i = 0; i < wave.length; i += 4) { const x = i / wave.length * W, y = H * .5 + (wave[i] - 128) / 128 * H * .32; i ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.stroke(); c.globalAlpha = 1;
      // now playing
      if (!S.ctx) return; const t = S.ctx.currentTime, cur = S.bars.find((b) => b.start <= t && t < b.end);
      if (cur && S.playing) {
        const key = cur.info.bar + ":" + cur.start;
        if (key !== lastBarKey) { lastBarKey = key; S.curBar = cur; showBar(cur.info); }
        const step = Math.floor((t - cur.start) / (cur.end - cur.start) * cur.info.steps);
        const dots = $("#stepDots").children; for (let i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i === step);
        const cells = document.querySelectorAll(".cell"); if (cells.length && step !== S.lastStep) { for (const x of cells) x.classList.toggle("play", Number(x.dataset.i) === step); S.lastStep = step; }
        const ci = cur.info.chordStarts.length > 1 ? cur.info.chordStarts.filter((s) => s <= step).length - 1 + cur.info.progIndex : cur.info.progIndex;
        const chips = $("#chordStrip").children; for (let i = 0; i < chips.length; i++) chips[i].classList.toggle("on", i === ci % Math.max(1, chips.length));
      } else if (!S.playing) { for (const x of document.querySelectorAll(".cell.play")) x.classList.remove("play"); for (const x of $("#stepDots").children) x.classList.remove("on"); }
    };
    fr();
  }
  function showBar(info) {
    $("#npSection").textContent = info.section;
    $("#npBar").textContent = `bar ${info.secBar + 1} of ${info.secBars} · total ${info.bar + 1}`;
    refreshPills();
  }

  // ------------------------------------------------------------------ share / export / record
  function shareState() {
    const o = { s: S.style, d: S.seed, o: S.overrides, u: { v: S.ui.vol, m: S.ui.mute, mv: S.ui.master, c: S.ui.cutoff } };
    return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function loadShare(hash) {
    try {
      const b = hash.replace(/^#/, "").replace(/-/g, "+").replace(/_/g, "/"), o = JSON.parse(decodeURIComponent(escape(atob(b))));
      if (!o || (!D.STYLES[o.s] && o.s !== "chaos")) return false;
      S.style = o.s; S.seed = o.d || rand(); S.overrides = o.o || {};
      if (o.u) { S.ui.vol = o.u.v || {}; S.ui.mute = o.u.m || {}; S.ui.master = o.u.mv === undefined ? .85 : o.u.mv; S.ui.cutoff = o.u.c || 20000; }
      return true;
    } catch (e) { return false; }
  }
  function download(blob, name) { const a = h("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }

  async function exportWav(seconds, progress) {
    const sr = S.sr, d = S.desc; if (!d) throw new Error("nothing to render yet");
    const w = new Worker("worker.js"), bars = []; let irs = null, params = null, total = 0;
    await new Promise((resolve, reject) => {
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") w.postMessage({ type: "new", gen: 1, style: d.style, seed: d.seed, overrides: S.overrides });
        else if (m.type === "piece") { irs = m.irs; params = m.desc.params; w.postMessage({ type: "next", gen: 1, epoch: 0, req: 0 }); }
        else if (m.type === "bar") { bars.push(m.bar); total += m.bar.n; progress(Math.min(.6, total / (seconds * sr) * .6), "Composing…"); if (total >= (seconds + 1) * sr) resolve(); else w.postMessage({ type: "next", gen: 1, epoch: 0, req: 0 }); }
        else if (m.type === "error") reject(new Error(m.message));
      };
      w.onerror = (e) => reject(new Error(e.message || "worker failed"));
      w.postMessage({ type: "init", sr });
    });
    w.terminate();
    progress(.65, "Mixing…");
    const len = Math.ceil((seconds + 2) * sr), off = new OfflineAudioContext(2, len, sr), g = AudioKit.buildGraph(off, false);
    for (const [n] of LAYERS) g.bus[n].gain.value = S.ui.mute[n] ? 0 : (S.ui.vol[n] === undefined ? 1 : S.ui.vol[n]);
    g.vol.gain.value = S.ui.master; g.lp.frequency.value = Math.min(S.ui.cutoff, params.lofi ? 3200 : 20000); g.setIRs(irs);
    let t = 0; for (const b of bars) { if (t > seconds + 1) break; g.schedule(b, t); t += b.n / sr; }
    g.duck.gain.setValueAtTime(1, Math.max(0, seconds - 2)); g.duck.gain.linearRampToValueAtTime(0, seconds + 1.5);
    const buf = await off.startRendering(); progress(.95, "Encoding…");
    download(AudioKit.encodeWav(buf), `musicgen-${d.style}-${d.seed}.wav`); progress(1);
  }
  function toggleRecord(btn, msg) {
    if (S.rec) { S.rec.stop(); return; }
    if (!S.g || !window.MediaRecorder) { msg.textContent = "Press play first (and use a browser with MediaRecorder)."; return; }
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const chunks = [], r = new MediaRecorder(S.g.rec.stream, type ? { mimeType: type } : undefined);
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = () => { S.rec = null; btn.textContent = "⏺ Record live"; const ext = (r.mimeType || "audio/webm").includes("mp4") ? "m4a" : (r.mimeType || "").includes("ogg") ? "ogg" : "webm"; download(new Blob(chunks, { type: r.mimeType }), `musicgen-recording.${ext}`); msg.textContent = "Saved."; };
    r.start(); S.rec = r; btn.textContent = "⏹ Stop & save"; msg.textContent = "Recording…";
  }

  // ------------------------------------------------------------------ boot
  function init() {
    buildStyles(); buildTabs();
    $("#playBtn").addEventListener("click", togglePlay);
    $("#newBtn").addEventListener("click", () => { newPiece({ seed: rand(), overrides: {} }); if (!S.playing) play(); });
    $("#nextBtn").addEventListener("click", () => { const pool = ALL_STYLES.filter((s) => s !== S.style); pickStyle(pool[Math.floor(Math.random() * pool.length)]); });
    $("#seedInput").addEventListener("change", (e) => { const v = parseInt(e.target.value, 10); if (v > 0) newPiece({ seed: v }); });
    $("#masterVol").addEventListener("input", (e) => { S.ui.master = Number(e.target.value); applyMix(); });
    $("#resetBtn").addEventListener("click", () => newPiece({ overrides: {} }));
    $("#shareBtn").addEventListener("click", async () => {
      const url = location.origin + location.pathname + "#" + shareState(); history.replaceState(null, "", "#" + shareState());
      try { await navigator.clipboard.writeText(url); setStatus("Link copied - it recreates this exact piece."); } catch (e) { setStatus("Link is in the address bar: copy it from there."); }
      setTimeout(() => setStatus(""), 3500);
    });
    $("#howLink").addEventListener("click", (e) => { e.preventDefault(); $("#how").scrollIntoView({ behavior: "smooth" }); });
    document.addEventListener("keydown", (e) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space") { if (e.target.tagName === "BUTTON") return; e.preventDefault(); togglePlay(); } else if (e.key === "n" || e.key === "N") $("#newBtn").click(); else if (e.key === "s" || e.key === "S") $("#nextBtn").click();
    });
    const fromLink = location.hash.length > 4 && loadShare(location.hash);
    if (!fromLink) S.style = ALL_STYLES[Math.floor(Math.random() * ALL_STYLES.length)];
    $("#masterVol").value = S.ui.master;
    startWorker(); newPiece({ style: S.style, seed: S.seed, overrides: S.overrides });
    setInterval(pump, 120);
    $("#engineInfo").textContent = `${ALL_STYLES.length} styles · ${D.INST_NAMES.length} instruments · ${Object.keys(D.SCALES).length} scales`;
    setStatus(fromLink ? "Shared piece loaded - press play." : "");
    updatePlayBtn();
  }
  init();
})();
