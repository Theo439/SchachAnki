# ♞ Schach-Anki

Schacheröffnungen lernen wie mit Karteikarten. Man legt eigene Repertoires an oder übernimmt Vorlagen und trainiert sie mit Wiederholung in wachsenden Abständen, wie bei Anki.

**Website:** https://theo439.github.io/SchachAnki/

## Funktionen
- **Training ganzer Varianten:**
  - Der Gegner zieht automatisch, du spielst deine Züge auf dem Brett.
  - Fehlerfrei gespielte Varianten kommen in immer größeren Abständen wieder.
  - Varianten mit Fehlern kommen bald noch einmal.
- **Editor:**
  - Zugbaum, Kommentare, Variantennamen und PGN-Import/-Export.
  - Markierungen für wichtige Züge (`!`), Fehler und Fallen (`??`) sowie eine Gewichtung (Pflicht, schwierig, häufig, unwichtig, pausiert).
- **Eröffnungsdatenbank:** rund 1,06 Mio. Meisterpartien (beide Spieler ≥ 2400) bis zum 11. Zug, mit Häufigkeiten und Ergebnissen.
- **Varianten-Assistent:** schlägt anhand der Datenbank neue Varianten vor.
- **Stockfish 19** läuft direkt im Browser, für die Analyse und als Analysebrett.
- **Sparring:**
  - 15 Züge gegen Stockfish.
  - Danach eine Auswertung: Abweichungen vom Repertoire, Fehler, Genauigkeit und eine eigene Wertung.
- **Installierbar** als App (PWA) und offline nutzbar.
- **Daten:**
  - Alles bleibt lokal im Browser.
  - Ein Backup (Export/Import) gibt es unter ⚙ Einstellungen.

## Entwickeln
```bash
npm install
npm run build             # → dist/ (Website)
npm run build:artifact    # → dist-artifact/ (Version für claude.ai)
npx serve dist            # lokal ansehen
```
Jeder Push auf `main` baut die Seite und veröffentlicht sie über GitHub Actions auf GitHub Pages (`.github/workflows/pages.yml`).

### Aufbau
| Datei | Inhalt |
|---|---|
| `src/core.js` | Zugbaum, PGN, Karteikarten/Varianten, Wiederholungsplanung (SM-2) |
| `src/app.js` | Oberfläche: Übersicht, Training, Editor, Sparring, Assistent |
| `src/engine.js` | Stockfish als Web Worker (UCI) |
| `src/explorer.js` | Eröffnungsdatenbank und Eröffnungsnamen |
| `src/presets.js` | Vorlagen-Repertoires |
| `src/sw.js` | Service Worker (offline, installierbar) |
| `public/db/` | Datenbank (64 Shards) und Eröffnungsnamen |
| `scripts/` | Skripte zum Erzeugen der Datenbank, der Namen und der Symbole |

### Datenbank neu erzeugen
- **Quellen:**
  - Meisterpartien: [rozim/ChessData](https://github.com/rozim/ChessData), `mega2400_part_01–33.pgn`
  - Eröffnungsnamen: [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0)
- **Vorgehen:**
  1. Die PGN-Dateien nach `raw/` legen.
  2. Die TSV-Dateien der Eröffnungsnamen als `eco_a.tsv` bis `eco_e.tsv` ablegen.
  3. Diese Befehle ausführen:
     ```bash
     pip install chess
     python scripts/build_db.py     # → shards/
     python scripts/build_names.py  # → names.json
     ```

## Lizenz
GPL-3.0-or-later, siehe `LICENSE`.
- Verwendete Bibliotheken: [chessground](https://github.com/lichess-org/chessground) (GPL-3.0), [Stockfish](https://stockfishchess.org/) (GPL-3.0) und [chess.js](https://github.com/jhlywa/chess.js) (BSD-2).
