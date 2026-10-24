/* worker.js - runs the music engine off the main thread and streams rendered bars back. */
importScripts("data.js", "engine.js");

let piece = null, gen = 0;

function describe() {
  const p = piece;
  return {
    style: p.style, seed: p.seed, bpm: p.bpm, key: p.pc, params: JSON.parse(JSON.stringify(p.p)), prog: p.prog.slice(), progKind: p.progKind,
    steps: p.steps, drumPat: p.drum_pat, customDrums: !!p.customDrums, info: p.info, scaleNotes: p.sc, leadMode: p.lead_mode,
    bassPat: p.p.bassPat || (MG_DATA.BASS[p.p.bass] || ""),
  };
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "init") { MG.setSampleRate(m.sr); self.postMessage({ type: "ready" }); }
    else if (m.type === "new") {
      const prev = piece; gen = m.gen;
      piece = new MG.Piece(m.style, m.seed, { overrides: m.overrides });
      if (m.adopt && prev) piece.adopt(prev);
      self.postMessage({ type: "piece", gen, desc: describe(), irs: piece.buildIRs() });
    } else if (m.type === "update" && piece) {
      const fx = piece.update(m.overrides);
      self.postMessage({ type: "piece", gen, desc: describe(), irs: fx || m.forceIR ? piece.buildIRs() : null, updated: true });
    } else if (m.type === "next" && piece) {
      const bar = piece.renderBar(), transfer = [];
      for (const b in bar.buses) for (const ch of bar.buses[b]) transfer.push(ch.buffer);
      if (bar.tex) for (const ch of bar.tex) transfer.push(ch.buffer);
      self.postMessage({ type: "bar", gen, epoch: m.epoch, req: m.req, bar, sectionDone: piece.section_done }, transfer);
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.stack || err) });
  }
};
