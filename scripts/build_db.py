"""Baut aus Meisterpartien (2400+) eine kompakte Eröffnungsdatenbank.

Ausgabe: shards/NN.json mit {positionsHash: [[uci, weiß, remis, schwarz], ...]}
Positionsschlüssel = FNV-1a (52 Bit) über "Brett Zugrecht Rochaderechte" (ohne e.p.),
damit Zugumstellungen zusammenfallen. Dieselbe Funktion gibt es in JavaScript.
"""
import glob, json, os, re, sys, time
from multiprocessing import Pool
import chess

MAX_PLY = int(os.environ.get('MAX_PLY', 22))
MIN_GAMES = int(os.environ.get('MIN_GAMES', 8))
SHARDS = 64
MASK = (1 << 52) - 1

def fnv(s):
    h = 0xcbf29ce484222325
    for c in s.encode():
        h ^= c
        h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return h & MASK

def key(board):
    return fnv(board.board_fen() + (' w ' if board.turn else ' b ') + (board.castling_xfen() if board.castling_rights else '-'))

RES = {'1-0': 0, '1/2-1/2': 1, '0-1': 2}
TOK = re.compile(r'\{[^}]*\}|\([^)]*\)|\$\d+|\d+\.(?:\.\.)?|[^\s]+')

def process(path):
    counts = {}
    games = 0
    text = open(path, encoding='latin-1').read()
    for block in text.split('\n\n[Event ')[0:]:
        m = re.search(r'\[Result "([^"]+)"\]', block)
        if not m or m.group(1) not in RES:
            continue
        if '[FEN ' in block or '[SetUp "1"]' in block:
            continue
        res = RES[m.group(1)]
        idx = block.rfind(']\n')
        movetext = block[idx + 2:] if idx >= 0 else ''
        board = chess.Board()
        ply = 0
        for tok in TOK.findall(movetext):
            if ply >= MAX_PLY:
                break
            if tok[0] in '{($' or tok[0].isdigit() or tok in ('*',):
                continue
            try:
                mv = board.parse_san(tok)
            except Exception:
                break
            k = key(board)
            ck = (k << 12) | (mv.from_square << 6) | mv.to_square
            arr = counts.get(ck)
            if arr is None:
                arr = [0, 0, 0]
                counts[ck] = arr
            arr[res] += 1
            board.push(mv)
            ply += 1
        games += 1
    return path, games, counts

if __name__ == '__main__':
    files = sorted(glob.glob('raw/part_*.pgn'))
    if len(sys.argv) > 1:
        files = files[:int(sys.argv[1])]
    total = {}
    ngames = 0
    t0 = time.time()
    with Pool(2) as pool:
        for path, g, c in pool.imap_unordered(process, files):
            ngames += g
            for k, v in c.items():
                a = total.get(k)
                if a is None:
                    total[k] = v
                else:
                    a[0] += v[0]; a[1] += v[1]; a[2] += v[2]
            print(f'{path}: {g} Partien, {len(total)} Einträge, {time.time()-t0:.0f}s', flush=True)
    # nach Position gruppieren
    pos = {}
    for ck, v in total.items():
        k = ck >> 12
        pos.setdefault(k, []).append((ck & 4095, v))
    shards = [dict() for _ in range(SHARDS)]
    kept = 0
    for k, moves in pos.items():
        n = sum(sum(v) for _, v in moves)
        if n < MIN_GAMES:
            continue
        moves.sort(key=lambda x: -sum(x[1]))
        out = []
        for i, (m, v) in enumerate(moves):
            c = sum(v)
            if i >= 12 or (c < 2 and i >= 3):
                break
            uci = chess.square_name(m >> 6) + chess.square_name(m & 63)
            out.append([uci, v[0], v[1], v[2]])
        shards[k % SHARDS][format(k, 'x')] = out
        kept += 1
    os.makedirs('shards', exist_ok=True)
    size = 0
    for i, s in enumerate(shards):
        data = json.dumps(s, separators=(',', ':'))
        size += len(data)
        open(f'shards/{i:02d}.json', 'w').write(data)
    json.dump({'games': ngames, 'positions': kept, 'maxPly': MAX_PLY, 'minGames': MIN_GAMES, 'shards': SHARDS},
              open('shards/meta.json', 'w'))
    print(f'Fertig: {ngames} Partien, {kept} Stellungen, {size/1e6:.1f} MB, {time.time()-t0:.0f}s')
