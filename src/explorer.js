// Eröffnungsdatenbank (Meisterpartien 2400+) und Eröffnungsnamen.
// Die Daten liegen als Dateien neben der Seite (db/NN.json, db/names.json) und
// werden bei Bedarf geladen.
import { Chess } from 'chess.js';

const MASK = (1n << 52n) - 1n;
const PRIME = 0x100000001b3n;
const M64 = (1n << 64n) - 1n;
const enc = new TextEncoder();

export function posHash(fen) {
  const [board, turn, castling] = fen.split(' ');
  let h = 0xcbf29ce484222325n;
  for (const b of enc.encode(`${board} ${turn} ${castling || '-'}`)) {
    h ^= BigInt(b);
    h = (h * PRIME) & M64;
  }
  return h & MASK;
}

let meta = null;
const shardCache = new Map();
let namesPromise = null;
let names = null;

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ': ' + r.status);
  return r.json();
}

export async function loadMeta() {
  if (!meta) meta = getJson('db/meta.json').catch((e) => { meta = null; throw e; });
  return meta;
}

function shard(i) {
  if (!shardCache.has(i)) {
    const p = getJson(`db/${String(i).padStart(2, '0')}.json`).catch((e) => { shardCache.delete(i); throw e; });
    shardCache.set(i, p);
  }
  return shardCache.get(i);
}

// Liefert { total, moves: [{ uci, san, from, to, w, d, b, n, share, score }] } oder total 0
export async function lookup(fen) {
  const m = await loadMeta();
  const h = posHash(fen);
  const data = await shard(Number(h % BigInt(m.shards)));
  const raw = data[h.toString(16)] || [];
  const ch = new Chess(fen);
  const moves = [];
  let total = 0;
  for (const [uci, w, d, b] of raw) {
    let mv;
    try { mv = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: 'q' }); } catch (e) { continue; }
    const n = w + d + b;
    total += n;
    const white = fen.split(' ')[1] === 'w';
    const score = (white ? w + d / 2 : b + d / 2) / n; // Erfolgsquote für die Seite am Zug
    moves.push({ uci, san: mv.san, from: mv.from, to: mv.to, w, d, b, n, score });
  }
  void ch;
  for (const mv of moves) mv.share = mv.n / total;
  return { total, moves, games: m.games };
}

export async function loadNames() {
  if (!namesPromise) namesPromise = getJson('db/names.json').then((n) => { names = n; return n; }).catch((e) => { namesPromise = null; throw e; });
  return namesPromise;
}

export function nameOf(fen) {
  if (!names) return null;
  const v = names[posHash(fen).toString(16)];
  return v ? { eco: v[0], name: v[1] } : null;
}

// Name der Stellung oder des nächsten benannten Vorgängers im Zugbaum
export function openingName(node) {
  for (let n = node; n; n = n.parent) { const x = nameOf(n.fen); if (x) return x; }
  return null;
}
