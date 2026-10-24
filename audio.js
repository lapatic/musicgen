/* audio.js - Web Audio graph shared by live playback and offline (WAV) rendering, plus a WAV encoder. */
(function (G) {
  "use strict";
  const BUS_NAMES = ["drums", "bass", "harm", "lead", "arp", "tex"];

  function buildGraph(ctx, live) {
    const g = { ctx, bus: {}, conv: {} };
    g.sum = ctx.createGain();
    g.lp = ctx.createBiquadFilter(); g.lp.type = "lowpass"; g.lp.frequency.value = 20000; g.lp.Q.value = .7;
    g.comp = ctx.createDynamicsCompressor();
    g.comp.threshold.value = -16; g.comp.knee.value = 14; g.comp.ratio.value = 3.5; g.comp.attack.value = .01; g.comp.release.value = .3;
    g.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(2049); for (let i = 0; i < curve.length; i++) { const x = i / 1024 - 1; curve[i] = Math.tanh(1.5 * x) / Math.tanh(1.5); }
    g.shaper.curve = curve; g.shaper.oversample = "2x";
    g.vol = ctx.createGain(); g.vol.gain.value = .85;
    g.duck = ctx.createGain();
    g.sum.connect(g.lp); g.lp.connect(g.comp); g.comp.connect(g.shaper); g.shaper.connect(g.vol); g.vol.connect(g.duck);
    if (live) {
      g.analyser = ctx.createAnalyser(); g.analyser.fftSize = 2048; g.analyser.smoothingTimeConstant = .8;
      g.duck.connect(g.analyser); g.analyser.connect(ctx.destination);
      g.rec = ctx.createMediaStreamDestination(); g.analyser.connect(g.rec);
    } else g.duck.connect(ctx.destination);
    for (const n of BUS_NAMES) { g.bus[n] = ctx.createGain(); }
    for (const n of ["drums", "harm", "lead"]) { g.conv[n] = ctx.createConvolver(); g.conv[n].normalize = false; }
    g.leadIn = ctx.createGain(); g.bus.lead.connect(g.leadIn); g.bus.arp.connect(g.leadIn);
    // dry paths
    g.bus.drums.connect(g.sum); g.bus.bass.connect(g.sum); g.bus.harm.connect(g.sum); g.leadIn.connect(g.sum); g.bus.tex.connect(g.sum);
    // wet paths
    g.bus.drums.connect(g.conv.drums); g.bus.harm.connect(g.conv.harm); g.leadIn.connect(g.conv.lead);
    for (const n of ["drums", "harm", "lead"]) g.conv[n].connect(g.sum);
    g.setIR = (name, chans) => {
      const c = g.conv[name]; if (!c) return;
      if (!chans) { c.buffer = null; return; }
      const b = ctx.createBuffer(2, chans[0].length, ctx.sampleRate); b.copyToChannel(chans[0], 0); b.copyToChannel(chans[1], 1); c.buffer = b;
    };
    g.setIRs = (irs) => { if (irs) for (const n of ["drums", "harm", "lead"]) g.setIR(n, irs[n]); };
    g.schedule = (bar, when) => {
      const made = [];
      const put = (name, pair) => {
        const buf = ctx.createBuffer(2, bar.n, ctx.sampleRate); buf.copyToChannel(pair[0], 0); buf.copyToChannel(pair[1], 1);
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(g.bus[name]); src.start(when); made.push({ node: src, when });
      };
      for (const n of Object.keys(bar.buses)) put(n, bar.buses[n]);
      if (bar.tex) put("tex", bar.tex);
      return made;
    };
    return g;
  }

  function encodeWav(buf) { // AudioBuffer -> 16-bit PCM WAV Blob
    const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate, data = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); data.setUint32(4, 36 + n * ch * 2, true); w(8, "WAVE"); w(12, "fmt "); data.setUint32(16, 16, true); data.setUint16(20, 1, true);
    data.setUint16(22, ch, true); data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
    w(36, "data"); data.setUint32(40, n * ch * 2, true);
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); data.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2; }
    return new Blob([data], { type: "audio/wav" });
  }

  G.AudioKit = { BUS_NAMES, buildGraph, encodeWav };
})(window);
