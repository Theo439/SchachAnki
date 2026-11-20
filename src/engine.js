// Stockfish im Browser (Web Worker, UCI-Protokoll).
import { Chess } from 'chess.js';

const FILES = ['engine/stockfish-19-lite-single.js', 'engine/stockfish-19-asm.js'];

export class Engine {
  constructor(multiPv = 3) {
    this.worker = null;
    this.ready = null;
    this.searching = false;
    this.pending = null;
    this.current = null;
    this.listener = null;
    this.multiPv = multiPv;
    this.resolver = null;
    this.lines = [];
    this.failed = false;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = this._boot(0);
    return this.ready;
  }

  _boot(i) {
    return new Promise((resolve, reject) => {
      if (i >= FILES.length) { this.failed = true; reject(new Error('Engine konnte nicht geladen werden')); return; }
      let w;
      const fail = () => { try { w && w.terminate(); } catch (e) { /* egal */ } this._boot(i + 1).then(resolve, reject); };
      try { w = new Worker(FILES[i]); } catch (e) { fail(); return; }
      const t = setTimeout(fail, 20000);
      w.onerror = () => { clearTimeout(t); fail(); };
      w.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : '';
        if (line === 'uciok') { w.postMessage('setoption name MultiPV value ' + this.multiPv); w.postMessage('isready'); }
        else if (line === 'readyok' && !this.worker) {
          clearTimeout(t);
          this.worker = w;
          w.onerror = null;
          w.onmessage = (ev) => this._onLine(String(ev.data));
          resolve();
        }
      };
      w.postMessage('uci');
    });
  }

  async analyse(fen, listener) {
    this.listener = listener;
    await this.start();
    if (this.searching) { this.pending = fen; this.worker.postMessage('stop'); return; }
    this._go(fen);
  }

  stop() {
    this.listener = null;
    this.pending = null;
    if (this.worker && this.searching) this.worker.postMessage('stop');
  }

  _go(fen) {
    this.current = fen;
    this.lines = [];
    this.searching = true;
    this.worker.postMessage('position fen ' + fen);
    this.worker.postMessage('go depth 24');
  }

  // Einmalige Suche, die mit dem besten Zug endet (für Sparring und Auswertung)
  async run(fen, goCmd, opts = {}) {
    await this.start();
    if (this.searching) { this.pending = null; this.listener = null; this.worker.postMessage('stop'); }
    while (this.searching) await new Promise((r) => setTimeout(r, 15));
    return new Promise((resolve) => {
      this.listener = null;
      this.resolver = resolve;
      // Sicherheitsnetz: nach opts.timeout ms die Suche abbrechen (liefert dann das bisher Beste)
      if (opts.timeout) setTimeout(() => { if (this.resolver === resolve) this.worker.postMessage('stop'); }, opts.timeout);
      if (opts.skill != null) this.worker.postMessage('setoption name Skill Level value ' + opts.skill);
      this.current = fen;
      this.lines = [];
      this.searching = true;
      this.worker.postMessage('position fen ' + fen);
      this.worker.postMessage(goCmd);
    });
  }

  _onLine(line) {
    if (line.startsWith('bestmove') && this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      this.searching = false;
      r({ best: line.split(' ')[1], lines: this.lines.filter(Boolean) });
      return;
    }
    if (line.startsWith('bestmove')) {
      this.searching = false;
      if (this.pending) { const f = this.pending; this.pending = null; this._go(f); }
      else if (this.listener) this.listener({ fen: this.current, lines: this.lines, done: true });
      return;
    }
    if (this.pending || !line.startsWith('info') || !line.includes(' pv ')) return;
    const get = (k) => { const m = line.match(new RegExp(' ' + k + ' (\\S+)')); return m ? m[1] : null; };
    const depth = +get('depth');
    const mpv = +(get('multipv') || 1);
    const scoreM = line.match(/ score (cp|mate) (-?\d+)/);
    if (!scoreM) return;
    const pv = line.split(' pv ')[1].trim().split(' ');
    const white = this.current.split(' ')[1] === 'w';
    let cp = null, mate = null;
    if (scoreM[1] === 'cp') cp = (+scoreM[2]) * (white ? 1 : -1);
    else mate = (+scoreM[2]) * (white ? 1 : -1);
    // SAN nur berechnen, wenn jemand live zuschaut (spart viel Rechenzeit bei der Auswertung)
    this.lines[mpv - 1] = { depth, cp, mate, pv, san: this.listener ? uciToSan(this.current, pv) : null };
    if (this.listener) this.listener({ fen: this.current, lines: this.lines.filter(Boolean), depth, done: false });
  }
}

export function uciToSan(fen, pv, max = 10) {
  const ch = new Chess(fen);
  const out = [];
  for (const u of pv.slice(0, max)) {
    try {
      const m = ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(m.san);
    } catch (e) { break; }
  }
  return out;
}

export function formatEval(l) {
  if (!l) return '…';
  if (l.mate != null) return (l.mate > 0 ? '#' : '#-') + Math.abs(l.mate);
  const v = l.cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(2);
}

// Anteil für den Bewertungsbalken (0 = Schwarz gewinnt, 1 = Weiß gewinnt)
export function evalShare(l) {
  if (!l) return 0.5;
  if (l.mate != null) return l.mate > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-0.004 * l.cp));
}
