import csv, json, glob, re, chess
from build_db import key
FAM = {
 "Sicilian Defense":"Sizilianische Verteidigung","French Defense":"Französische Verteidigung","Caro-Kann Defense":"Caro-Kann-Verteidigung",
 "Italian Game":"Italienische Partie","Ruy Lopez":"Spanische Partie","Queen's Gambit Declined":"Abgelehntes Damengambit",
 "Queen's Gambit Accepted":"Angenommenes Damengambit","Queen's Gambit":"Damengambit","King's Indian Defense":"Königsindische Verteidigung",
 "King's Indian Attack":"Königsindischer Angriff","Scandinavian Defense":"Skandinavische Verteidigung","English Opening":"Englische Eröffnung",
 "London System":"Londoner System","Nimzo-Indian Defense":"Nimzowitsch-Indische Verteidigung","Queen's Indian Defense":"Damenindische Verteidigung",
 "Grünfeld Defense":"Grünfeld-Indische Verteidigung","Slav Defense":"Slawische Verteidigung","Semi-Slav Defense":"Halbslawische Verteidigung",
 "Pirc Defense":"Pirc-Verteidigung","Dutch Defense":"Holländische Verteidigung","Scotch Game":"Schottische Partie","Petrov's Defense":"Russische Verteidigung",
 "Russian Game":"Russische Verteidigung","Two Knights Defense":"Zweispringerspiel im Nachzuge","King's Gambit Accepted":"Angenommenes Königsgambit",
 "King's Gambit Declined":"Abgelehntes Königsgambit","King's Gambit":"Königsgambit","Vienna Game":"Wiener Partie","Philidor Defense":"Philidor-Verteidigung",
 "Alekhine Defense":"Aljechin-Verteidigung","Modern Defense":"Moderne Verteidigung","Benoni Defense":"Benoni-Verteidigung","Modern Benoni":"Moderne Benoni",
 "Catalan Opening":"Katalanische Eröffnung","Réti Opening":"Réti-Eröffnung","Zukertort Opening":"Zukertort-Eröffnung","Bird Opening":"Bird-Eröffnung",
 "Four Knights Game":"Vierspringerspiel","Three Knights Opening":"Dreispringerspiel","Bishop's Opening":"Läuferspiel","Center Game":"Mittelgambit",
 "Benko Gambit":"Wolga-Gambit","Budapest Defense":"Budapester Gambit","Bogo-Indian Defense":"Bogoljubow-Indische Verteidigung",
 "Old Indian Defense":"Altindische Verteidigung","Owen Defense":"Owen-Verteidigung","Nimzowitsch Defense":"Nimzowitsch-Verteidigung",
 "Indian Defense":"Indische Verteidigung","Queen's Pawn Game":"Damenbauernspiel","King's Pawn Game":"Königsbauernspiel","Trompowsky Attack":"Trompowsky-Angriff",
 "Torre Attack":"Torre-Angriff","Colle System":"Colle-System","Ponziani Opening":"Ponziani-Eröffnung","Elephant Gambit":"Elefantengambit",
 "Latvian Gambit":"Lettisches Gambit","Danish Gambit":"Nordisches Gambit","Englund Gambit":"Englund-Gambit","Blackmar-Diemer Gambit":"Blackmar-Diemer-Gambit",
 "Polish Opening":"Polnische Eröffnung","Nimzo-Larsen Attack":"Nimzowitsch-Larsen-Angriff","Hungarian Opening":"Ungarische Eröffnung",
 "Rat Defense":"Ratten-Verteidigung","Robatsch Defense":"Robatsch-Verteidigung","Tarrasch Defense":"Tarrasch-Verteidigung","Ponziani":"Ponziani",
}
SUB = [("Exchange Variation","Abtauschvariante"),("Advance Variation","Vorstoßvariante"),("Main Line","Hauptvariante"),
 ("Classical Variation","Klassische Variante"),("Closed Variation","Geschlossene Variante"),("Open Variation","Offene Variante"),
 ("Accelerated Dragon","Beschleunigter Drache"),("Dragon Variation","Drachenvariante"),("Variation","Variante"),("Defense","Verteidigung"),
 ("Attack","Angriff"),("Accepted","angenommen"),("Declined","abgelehnt"),("Countergambit","Gegengambit"),("System","System"),("Line","Linie")]
def tr(name):
    fam, _, rest = name.partition(': ')
    fam_de = FAM.get(fam, fam)
    if not rest: return fam_de
    for a,b in SUB: rest = rest.replace(a, b)
    return fam_de + ': ' + rest
names = {}
for f in sorted(glob.glob('eco_*.tsv')):
    for row in csv.DictReader(open(f), delimiter='\t'):
        b = chess.Board()
        for tok in row['pgn'].split():
            if re.match(r'^\d+\.', tok): continue
            b.push_san(tok)
        k = format(key(b), 'x')
        if k not in names: names[k] = [row['eco'], tr(row['name'])]
json.dump(names, open('names.json','w'), ensure_ascii=False, separators=(',',':'))
print(len(names), list(names.items())[:3])
