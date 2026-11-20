// Kernlogik: Zugbaum, PGN-Import/-Export, Karten und Wiederholungsplanung.
// Bewusst ohne DOM, damit sie in Node getestet werden kann.
import { Chess } from 'chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

let idCounter = 0;
const newNodeId = () => 'n' + (++idCounter).toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- Zugbaum ----------

export function makeRoot() {
  return { id: 'root', san: null, fen: START_FEN, parent: null, children: [], comment: '' };
}

export function pathOf(node) {
  const out = [];
  for (let n = node; n && n.parent; n = n.parent) out.push(n.san);
  return out.reverse();
}

export const keyOf = (node) => pathOf(node).join(' ');

export function plyOf(node) {
  let d = 0;
  for (let n = node; n && n.parent; n = n.parent) d++;
  return d;
}

export const turnOf = (fen) => fen.split(' ')[1];

const GERMAN_TO_EN = { D: 'Q', T: 'R', L: 'B', S: 'N', K: 'K' };

function normalizeInput(san) {
  let s = san.replace(/[!?]+$/g, '').replace(/[+#]+$/g, '').replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O');
  return s;
}

function germanToEnglish(san) {
  let s = san;
  if (GERMAN_TO_EN[s[0]]) s = GERMAN_TO_EN[s[0]] + s.slice(1);
  s = s.replace(/=([DTLS])/, (_, p) => '=' + GERMAN_TO_EN[p]);
  return s;
}

// Versucht einen Zug auszuführen (englische oder deutsche Notation, SAN oder Feld-zu-Feld).
export function tryMove(fen, move) {
  const chess = new Chess(fen);
  const attempts = typeof move === 'string' ? [normalizeInput(move), germanToEnglish(normalizeInput(move))] : [move];
  for (const m of attempts) {
    try {
      const res = chess.move(m);
      if (res) return { san: res.san, fen: chess.fen(), from: res.from, to: res.to };
    } catch (e) { /* nächster Versuch */ }
  }
  return null;
}

// Fügt einen Zug als Kind hinzu (oder gibt das vorhandene Kind zurück).
export function addChild(node, move) {
  const r = tryMove(node.fen, move);
  if (!r) return null;
  let child = node.children.find((c) => c.san === r.san);
  if (child) return { node: child, created: false };
  child = { id: newNodeId(), san: r.san, fen: r.fen, parent: node, children: [], comment: '' };
  node.children.push(child);
  return { node: child, created: true };
}

export function removeNode(node) {
  if (!node.parent) return;
  node.parent.children = node.parent.children.filter((c) => c !== node);
}

export function walk(node, fn) {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

export function findByKey(root, key) {
  if (!key) return root;
  let n = root;
  for (const san of key.split(' ')) {
    n = n.children.find((c) => c.san === san);
    if (!n) return null;
  }
  return n;
}

export function moveInfo(fromFen, san) {
  const r = tryMove(fromFen, san);
  return r ? { from: r.from, to: r.to } : null;
}

// ---------- Serialisierung (flach, damit keine tiefe Verschachtelung entsteht) ----------

export function serializeTree(root) {
  const nodes = [];
  const index = new Map();
  index.set(root, -1);
  walk(root, (n) => {
    if (!n.parent) return;
    index.set(n, nodes.length);
    const meta = {};
    if (n.important) meta.i = 1;
    if (n.name) meta.n = n.name;
    if (n.weight) meta.w = n.weight;
    const hasMeta = Object.keys(meta).length > 0;
    const e = [index.get(n.parent), n.san];
    if (n.comment || n.bad || hasMeta) e.push(n.comment || '');
    if (n.bad || hasMeta) e.push(n.bad ? 1 : 0);
    if (hasMeta) e.push(meta);
    nodes.push(e);
  });
  return { rootComment: root.comment || '', nodes };
}

export function deserializeTree(data) {
  const root = makeRoot();
  root.comment = data?.rootComment || '';
  const list = [];
  for (const entry of data?.nodes || []) {
    const [p, san, comment, bad, meta] = entry;
    const parent = p === -1 ? root : list[p];
    if (!parent) { list.push(null); continue; }
    const r = addChild(parent, san);
    if (!r) { list.push(null); continue; }
    if (comment) r.node.comment = comment;
    if (bad) r.node.bad = true;
    if (meta) { if (meta.i) r.node.important = true; if (meta.n) r.node.name = meta.n; if (meta.w) r.node.weight = meta.w; }
    list.push(r.node);
  }
  return root;
}

// ---------- PGN ----------

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const s = text.replace(/\r/g, '');
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '[') { const j = s.indexOf(']', i); i = j === -1 ? s.length : j + 1; tokens.push({ t: 'header' }); continue; }
    if (ch === '{') { const j = s.indexOf('}', i); tokens.push({ t: 'comment', v: s.slice(i + 1, j === -1 ? s.length : j).trim() }); i = j === -1 ? s.length : j + 1; continue; }
    if (ch === ';') { const j = s.indexOf('\n', i); tokens.push({ t: 'comment', v: s.slice(i + 1, j === -1 ? s.length : j).trim() }); i = j === -1 ? s.length : j + 1; continue; }
    if (ch === '(') { tokens.push({ t: 'open' }); i++; continue; }
    if (ch === ')') { tokens.push({ t: 'close' }); i++; continue; }
    let j = i;
    while (j < s.length && !/[\s(){};\[]/.test(s[j])) j++;
    let word = s.slice(i, j);
    i = j;
    if (/^(1-0|0-1|1\/2-1\/2|\*|½-½)$/.test(word)) { tokens.push({ t: 'result' }); continue; }
    if (/^\$\d+$/.test(word)) { if (word === '$2' || word === '$4') tokens.push({ t: 'bad' }); if (word === '$1' || word === '$3') tokens.push({ t: 'good' }); continue; }
    const num = word.match(/^(\d+)(\.+)(.*)$/);
    if (num) {
      tokens.push({ t: 'num', n: +num[1], dots: num[2].length });
      word = num[3];
      if (!word) continue;
    }
    const ann = (word.match(/[!?]+$/) || [''])[0];
    word = word.replace(/[!?]+$/, '');
    if (word) tokens.push({ t: 'move', v: word, bad: ann === '?' || ann === '??', important: ann === '!' || ann === '!!' });
  }
  return tokens;
}

// Importiert PGN-Text (auch mehrere Partien, Varianten in Klammern, Kommentare,
// deutsche Figurenbuchstaben) in den Baum. Gibt Statistik und Fehler zurück.
export function importPgn(root, text) {
  const tokens = tokenize(text);
  let cur = root;
  let prev = null;
  const stack = [];
  let added = 0;
  const errors = [];
  let skipUntilReset = false;
  for (const tok of tokens) {
    if (tok.t === 'header' || tok.t === 'result') {
      if (stack.length === 0) { cur = root; prev = null; skipUntilReset = false; }
      continue;
    }
    if (tok.t === 'num') {
      if (tok.n === 1 && tok.dots === 1 && stack.length === 0 && cur !== root) { cur = root; prev = null; skipUntilReset = false; }
      continue;
    }
    if (tok.t === 'open') { stack.push({ cur, prev, skip: skipUntilReset }); cur = prev || cur; prev = cur.parent; continue; }
    if (tok.t === 'close') { const st = stack.pop(); if (st) { cur = st.cur; prev = st.prev; skipUntilReset = st.skip; } continue; }
    if (tok.t === 'good') { if (cur && cur !== root && !skipUntilReset) cur.important = true; continue; }
    if (tok.t === 'bad') { if (cur && cur !== root && !skipUntilReset) cur.bad = true; continue; }
    if (tok.t === 'comment') {
      if (cur && cur !== root && !skipUntilReset && tok.v) {
        let txt = tok.v;
        txt = txt.replace(/\[%name ([^\]]*)\]/, (_, n) => { cur.name = n.trim(); return ''; });
        txt = txt.replace(/\[%prio (\w+)\]/, (_, w) => { if (WEIGHTS[w]) cur.weight = w; return ''; });
        txt = txt.trim();
        if (txt) cur.comment = txt;
      }
      continue;
    }
    if (tok.t === 'move') {
      if (skipUntilReset) continue;
      const r = addChild(cur, tok.v);
      if (!r) {
        errors.push(`Ungültiger Zug „${tok.v}“ nach ${pathOf(cur).join(' ') || 'Startstellung'}`);
        skipUntilReset = true;
        continue;
      }
      if (r.created) added++;
      if (tok.bad) r.node.bad = true;
      if (tok.important) r.node.important = true;
      prev = cur;
      cur = r.node;
    }
  }
  return { added, errors };
}

export function importLines(root, lines) {
  let added = 0; const errors = [];
  for (const l of lines) { const r = importPgn(root, l); added += r.added; errors.push(...r.errors); }
  return { added, errors };
}

export function exportPgn(root, { german = false } = {}) {
  const fmt0 = (san) => (german ? toGerman(san) : san);
  let fmt = fmt0;
  const out = [];
  const moveNo = (node, forceBlack) => {
    const ply = plyOf(node); // ply des Zuges selbst (1 = erster weißer Zug)
    const n = Math.ceil(ply / 2);
    return ply % 2 === 1 ? `${n}.` : forceBlack ? `${n}...` : '';
  };
  const cm = (n) => {
    const parts = [];
    if (n.name) parts.push(`[%name ${n.name.replace(/[{}\]]/g, '')}]`);
    if (n.weight) parts.push(`[%prio ${n.weight}]`);
    if (n.comment) parts.push(n.comment.replace(/[{}]/g, ''));
    return parts.length ? ` {${parts.join(' ')}}` : '';
  };
  const ann = (n) => (n.bad ? '??' : n.important ? '!' : '');
  function line(node, forceNum) {
    // node: Elternknoten, dessen Kinder ausgegeben werden
    let n = node;
    let force = forceNum;
    while (n.children.length) {
      const [main, ...alts] = n.children;
      const num = moveNo(main, force);
      out.push(num + fmt(main.san) + ann(main) + cm(main));
      force = !!cm(main);
      for (const a of alts) {
        out.push('(');
        out.push(moveNo(a, true) + fmt(a.san) + ann(a) + cm(a));
        line(a, !!cm(a));
        out.push(')');
        force = true;
      }
      n = main;
    }
  }
  line(root, false);
  return out.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
}

export function toGerman(san) {
  if (!san) return san;
  const map = { Q: 'D', R: 'T', B: 'L', N: 'S', K: 'K' };
  let s = san;
  if (map[s[0]]) s = map[s[0]] + s.slice(1);
  return s.replace(/=([QRBN])/, (_, p) => '=' + map[p]);
}

// ---------- Karten ----------

// Eine Karte = eine Stellung, in der der Lernende am Zug ist und das Repertoire
// mindestens einen eigenen Zug vorsieht.
// Züge, die als Fehler (??) markiert sind, zählen nie als richtige Antwort.
// Unterhalb eines eigenen Fehlers entstehen keine Karten (diese Linien zeigen nur,
// warum der Zug schlecht ist). Nach einem gegnerischen Fehler entsteht eine
// „Bestrafe den Fehler“-Karte.
export const isOwnMove = (node, color) => !!node.parent && turnOf(node.parent.fen) === color;
export const goodChildren = (node) => node.children.filter((c) => !c.bad);
export const badChildren = (node) => node.children.filter((c) => c.bad);

export function collectCards(root, color) {
  const cards = [];
  let order = 0;
  const visit = (n) => {
    if (n.bad && isOwnMove(n, color)) return;
    if (turnOf(n.fen) === color && goodChildren(n).length) {
      const good = goodChildren(n);
      const childW = good.find((c) => c.weight)?.weight;
      const weight = childW || inheritedWeight(n);
      const important = !!(n.important && n.parent) || good.some((c) => c.important);
      cards.push({ key: keyOf(n), node: n, order: order++, punish: !!(n.bad && n.parent), weight, important });
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return cards;
}

// ---------- Gewichtung ----------
// factor: Multiplikator auf die Wiederholungsintervalle; prio: Reihenfolge neuer Karten (0 = zuerst)
export const WEIGHTS = {
  must: { label: 'Unbedingt lernen', short: 'Pflicht', icon: '★', factor: 0.7, prio: 0 },
  hard: { label: 'Hab Probleme damit', short: 'Schwierig', icon: '⚠', factor: 0.5, prio: 1 },
  often: { label: 'Kommt oft vor', short: 'Häufig', icon: '↻', factor: 0.8, prio: 1 },
  low: { label: 'Nicht so wichtig', short: 'Unwichtig', icon: '↓', factor: 1.6, prio: 3 },
  pause: { label: 'Pausieren (nicht abfragen)', short: 'Pausiert', icon: '⏸', factor: 1, prio: 9 },
};

export function inheritedWeight(node) {
  for (let n = node; n; n = n.parent) if (n.weight) return n.weight;
  return null;
}

export function cardFactor(card) {
  let f = card.weight && WEIGHTS[card.weight] ? WEIGHTS[card.weight].factor : 1;
  if (card.important) f = Math.min(f, 0.75);
  return f;
}
export function cardPrio(card) {
  let p = card.weight && WEIGHTS[card.weight] ? WEIGHTS[card.weight].prio : 2;
  if (card.important) p = Math.min(p, 0);
  return p;
}

// Name der Variante: nächster benannter Vorfahre (inkl. Knoten selbst)
export function variationName(node) {
  const names = [];
  for (let n = node; n; n = n.parent) if (n.name) names.unshift(n.name);
  return names;
}

// ---------- Wiederholungsplanung (vereinfachtes SM-2, wie Anki) ----------

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
export const LEARN_STEPS = [1 * MIN, 10 * MIN];

export function newSrs() {
  return { state: 'new', step: 0, due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0 };
}

// grade: 'again' | 'good' | 'easy'
export function schedule(srs, grade, now = Date.now(), factor = 1) {
  const s = { ...(srs || newSrs()) };
  s.reps++;
  s.last = now;
  if (s.state === 'new' || s.state === 'learning' || s.state === 'relearning') {
    if (grade === 'again') { s.step = 0; s.state = s.state === 'new' ? 'learning' : s.state; s.due = now + LEARN_STEPS[0]; return s; }
    if (s.state === 'new') { s.state = 'learning'; s.step = 0; }
    if (grade === 'easy') { s.state = 'review'; s.interval = Math.max(4, s.interval); s.due = now + s.interval * DAY; return s; }
    s.step++;
    if (s.step >= LEARN_STEPS.length) {
      s.interval = s.state === 'relearning' ? Math.max(1, Math.round(s.interval)) : Math.max(1, Math.round(1 * factor));
      s.state = 'review';
      s.due = now + s.interval * DAY;
    } else {
      s.due = now + LEARN_STEPS[s.step];
    }
    return s;
  }
  // review
  if (grade === 'again') {
    s.lapses++;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.interval = Math.max(1, s.interval * 0.5);
    s.state = 'relearning';
    s.step = 0;
    s.due = now + LEARN_STEPS[0];
    return s;
  }
  const overdueDays = Math.max(0, (now - s.due) / DAY);
  let ivl = (s.interval + overdueDays / 2) * s.ease;
  if (grade === 'easy') { ivl *= 1.3; s.ease += 0.15; }
  s.interval = Math.max(s.interval + 1, Math.round(ivl * factor));
  s.due = now + s.interval * DAY;
  return s;
}

export function formatInterval(ms) {
  if (ms < 60 * MIN) { const m = Math.max(1, Math.round(ms / MIN)); return m === 1 ? '1 Minute' : `${m} Minuten`; }
  if (ms < DAY) { const hh = Math.round(ms / (60 * MIN)); return hh === 1 ? '1 Stunde' : `${hh} Stunden`; }
  const d = Math.round(ms / DAY);
  if (d < 31) return d === 1 ? 'einem Tag' : `${d} Tagen`;
  const m = Math.round(d / 30);
  return m === 1 ? 'einem Monat' : `${m} Monaten`;
}

export function todayKey(now = Date.now()) {
  const d = new Date(now - 4 * 60 * MIN); // Tageswechsel um 4 Uhr, wie bei Anki
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function repStats(root, color, srsMap, now = Date.now()) {
  const all = collectCards(root, color);
  const cards = all.filter((c) => c.weight !== 'pause');
  let fresh = 0, learning = 0, due = 0, mature = 0;
  for (const c of cards) {
    const s = srsMap[c.key];
    if (!s || s.state === 'new') { fresh++; continue; }
    if (s.state !== 'review') learning++;
    if (s.due <= now) due++;
    if (s.state === 'review' && s.interval >= 21) mature++;
  }
  return { total: cards.length, fresh, learning, due, mature, seen: cards.length - fresh, paused: all.length - cards.length };
}

// ======================================================================
// Varianten als Lerneinheit (seit v0.5)
// Eine Variante = Weg von der Startstellung bis zu einem Blatt des Baums.
// An eigenen Stellungen verzweigt jeder gute eigene Zug in eine eigene Variante,
// eigene Fehlerzüge (??) und alles darunter gehören zu keiner Variante.
// ======================================================================
export function collectLines(root, color) {
  const lines = [];
  let order = 0;
  const path = [];
  const visit = (n) => {
    if (n.parent) path.push(n);
    const mineToMove = turnOf(n.fen) === color;
    const kids = mineToMove ? goodChildren(n) : n.children;
    if (!kids.length) {
      const own = path.filter((x) => isOwnMove(x, color));
      if (own.length) {
        const weight = inheritedWeight(n);
        const important = path.some((x) => x.important);
        const factor = Math.min(weight && WEIGHTS[weight] ? WEIGHTS[weight].factor : 1, important ? 0.75 : 1);
        const prio = Math.min(weight && WEIGHTS[weight] ? WEIGHTS[weight].prio : 2, important ? 0 : 9);
        lines.push({ key: keyOf(n), leaf: n, nodes: [...path], ownCount: own.length, weight, important, factor, prio, order: order++ });
      }
    } else {
      for (const c of kids) visit(c);
    }
    if (n.parent) path.pop();
  };
  visit(root);
  return lines;
}

// Lerndaten einer Variante. Wurde eine Variante verlängert, gilt der Stand der
// bisherigen (kürzeren) Variante weiter, ist aber sofort fällig.
export function lineSrs(linesMap, line, currentKeys) {
  if (linesMap[line.key]) return linesMap[line.key];
  for (let i = line.nodes.length - 2; i >= 0; i--) {
    const k = keyOf(line.nodes[i]);
    const s = linesMap[k];
    if (s && !currentKeys.has(k)) return { ...s, due: Math.min(s.due, Date.now()), inherited: k };
  }
  return null;
}

export function lineStats(rep, now = Date.now()) {
  const all = collectLines(rep.root, rep.color);
  const keys = new Set(all.map((l) => l.key));
  const lines = all.filter((l) => l.weight !== 'pause');
  let fresh = 0, learning = 0, due = 0, nextDue = Infinity;
  for (const l of lines) {
    const s = lineSrs(rep.lines || {}, l, keys);
    if (!s || s.state === 'new') { fresh++; continue; }
    if (s.state !== 'review') learning++;
    if (s.due <= now) due++; else nextDue = Math.min(nextDue, s.due);
  }
  return { total: lines.length, fresh, learning, due, seen: lines.length - fresh, paused: all.length - lines.length, nextDue };
}

// Stellungen (Schlüssel), die schon in einer gelernten Variante vorkamen
export function learnedPositions(rep) {
  const all = collectLines(rep.root, rep.color);
  const keys = new Set(all.map((l) => l.key));
  const set = new Set();
  for (const l of all) {
    const s = lineSrs(rep.lines || {}, l, keys);
    if (!s || s.state === 'new') continue;
    for (const n of l.nodes) if (isOwnMove(n, rep.color)) set.add(keyOf(n.parent));
  }
  return set;
}

// Gewinnwahrscheinlichkeit (Lichess-Formel) aus Centipawns für Weiß
export function winPct(cp) {
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}
export function evalToCp(l) {
  if (!l) return 0;
  if (l.mate != null) return l.mate > 0 ? 1500 : -1500;
  return l.cp;
}
