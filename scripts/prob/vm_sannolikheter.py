#!/usr/bin/env python3
"""
VM 2026 - sannolikhetsmotor for slutspelstradet
=================================================
En Monte Carlo-simulering av hela turneringen. For varje slot/nod i tradet
raknar den ut sannolikheten att ett visst lag hamnar dar - baserat pa odds.

KOR EN GANG, SKRIV bracket_probs.json. Lagg i ett schemalagt jobb (cron /
GitHub Action) sa uppdateras siffrorna under turneringens gang. Allt kant
fixeras, allt okant simuleras - betingat pa det kanda.

  python3 vm_sannolikheter.py

Indata (om filerna saknas anvands SYNTETISK data sa du kan kora direkt):
  - group_fixtures.json : gruppmatcher med 1X2-odds och ev. resultat
  - vinnarodds.json     : outright-vinnarodds (kalibreringsankare) - fran ditt
                          tidigare script
Utdata:
  - bracket_probs.json  : det frontend laser vid klick

VIKTIGT - tva saker MASTE ersattas med FIFA:s officiella uppgifter innan
siffrorna ar pa riktigt (sok pa "bracket" / "ILLUSTRATIV" i koden):
  1) R32-strukturen (vilken grupplats matar vilken match, t.ex. M84 = 1H vs 2J)
  2) Basta trean-tilldelningen (vilken slot var trea hamnar i)
Motorn ar matematiskt korrekt for VILKEN struktur du an stoppar in - det ar
bara sjalva kartan som ar platshallare har.
"""

import json
import math
import os
import random
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ---------- Konfiguration ----------
N_SIMS = int(os.environ.get("VM_N_SIMS", "20000"))  # hoj for jamnare siffror (50-100k pa riktigt)
K_KNOCKOUT = 0.6                  # styrkeskala i slutspelet - DIN KALIBRERINGSKNAPP
SCRIPT_DIR = Path(__file__).resolve().parent
BRACKET_MAP_FILE = SCRIPT_DIR / "bracket_map.json"  # FIFA-karta (genererad ur data.js + annexc.js)
OUTPUT_FILE = Path(os.environ.get("VM_BRACKET_OUTPUT", "bracket_probs.json"))
LETTERS = "ABCDEFGHIJKL"          # 12 grupper
ROUND_ORDER = ["r32", "r16", "qf", "sf", "final"]
ROUND_TEAMS = {"r32": 32, "r16": 16, "qf": 8, "sf": 4, "final": 2}


# ========== Oddshantering ==========
def devig(odds):
    """Decimalodds -> normaliserade sannolikheter (marknadens vig borttaget)."""
    inv = [1.0 / o for o in odds]
    s = sum(inv)
    return [x / s for x in inv]


def strengths_from_outrights(outrights):
    """
    outrights: dict lag -> decimalodds for att vinna VM.
    Returnerar en styrke-rating per lag = log(vinstsannolikhet).
    Skillnaden i rating mellan tva lag avgor matchsannolikheten i slutspelet.
    """
    inv = {t: 1.0 / o for t, o in outrights.items()}
    z = sum(inv.values())
    p = {t: inv[t] / z for t in inv}
    return {t: math.log(p[t]) for t in p}


def winprob(a, b, strength):
    """Sannolikhet att lag a slar lag b i en slutspelsmatch (ingen oavgjort)."""
    return 1.0 / (1.0 + math.exp(-K_KNOCKOUT * (strength[a] - strength[b])))


# ========== Simulering av en hel turnering ==========
def _poisson(rng, lam):
    """Knuths algoritm: ett Poisson(lam)-sampel med given RNG."""
    L = math.exp(-lam)
    k, p = 0, 1.0
    while True:
        k += 1
        p *= rng.random()
        if p <= L:
            return k - 1


def sample_goals(outcome, rng):
    """Trolig malsiffra (hemma, borta) som matchar utfallet 1/X/2.
    Anvands bara for OSPELADE matcher sa att malskillnad/gjorda mal far ett
    rimligt varde i gruppens tiebreak. Vinnaren tar minst ett mals marginal."""
    if outcome == "X":
        g = _poisson(rng, 1.1)
        return g, g
    margin = 1 + _poisson(rng, 0.7)
    loser = _poisson(rng, 0.8)
    winner = loser + margin
    return (winner, loser) if outcome == "1" else (loser, winner)


def sim_group(teams, fixtures, rng):
    """Spelar en grupp. Returnerar (rankad lista 1->4, poang, malskillnad, gjorda mal).
    Spelade matcher anvander sin VERKLIGA malsiffra (fx['score']) - en stor seger
    (t.ex. 5-1) ger darmed battre malskillnad an en knapp (1-0), precis som i FIFA:s
    gruppranking (poang -> malskillnad -> gjorda mal)."""
    pts = dict.fromkeys(teams, 0)
    gf = dict.fromkeys(teams, 0)   # gjorda mal
    ga = dict.fromkeys(teams, 0)   # inslappta mal
    for fx in fixtures:
        res = fx.get("result")
        score = fx.get("score")
        if res is None:                                   # ej spelad -> simulera
            p = devig([fx["odds"]["1"], fx["odds"]["X"], fx["odds"]["2"]])
            r = rng.random()
            res = "1" if r < p[0] else ("X" if r < p[0] + p[1] else "2")
            hg, ag = sample_goals(res, rng)
        elif score and score[0] is not None and score[1] is not None:
            hg, ag = score[0], score[1]                   # verkligt resultat
        else:                                             # spelad utan malsiffra (gammal data)
            hg, ag = (1, 0) if res == "1" else ((0, 1) if res == "2" else (0, 0))
        h, a = fx["home"], fx["away"]
        gf[h] += hg; ga[h] += ag
        gf[a] += ag; ga[a] += hg
        if res == "1":
            pts[h] += 3
        elif res == "2":
            pts[a] += 3
        else:
            pts[h] += 1
            pts[a] += 1
    gd = {t: gf[t] - ga[t] for t in teams}
    # FIFA-ordning (forenklad): poang -> malskillnad -> gjorda mal -> slump.
    ranked = sorted(teams, key=lambda t: (pts[t], gd[t], gf[t], rng.random()), reverse=True)
    return ranked, pts, gd, gf


def resolve_slot(spec, standings, slot_to_third_group):
    """Oversatter en R32-feeder-spec till ett konkret lag.
    spec: {'kind':'dir','code':'1A'/'2C'} (etta/tvaa) eller
          {'kind':'third','slot':'E'} (trea via FIFA Annex C)."""
    if spec["kind"] == "dir":
        code = spec["code"]
        pos = int(code[0])          # 1 = etta, 2 = tvaa
        grp = code[1:]
        return standings[grp][pos - 1]
    third_group = slot_to_third_group[spec["slot"]]
    return standings[third_group][2]


def run_once(groups, fixtures_by_group, strength, bracket, rng):
    """En komplett simulerad turnering."""
    standings = {}
    gpos = {}                       # lag -> grupplacering 1..4
    thirds = []                     # (grupp, lag, poang, malskillnad, gjorda mal)
    for grp, teams in groups.items():
        ranked, pts, gd, gf = sim_group(teams, fixtures_by_group[grp], rng)
        standings[grp] = ranked
        for i, t in enumerate(ranked):
            gpos[t] = i + 1
        third = ranked[2]
        thirds.append((grp, third, pts[third], gd[third], gf[third]))

    # Basta 8 treorna gar vidare (FIFA: poang -> malskillnad -> gjorda mal -> slump).
    thirds.sort(key=lambda x: (x[2], x[3], x[4], rng.random()), reverse=True)
    qualifying_groups = sorted(g for g, *_ in thirds[:8])

    # FIFA Annex C (annexc.js, 495 rader): vilken trea (fran vilken grupp) som
    # hamnar i vilken winner-slot avgors av VILKA 8 grupper som levererar en trea.
    assignment = bracket["annexC"]["".join(qualifying_groups)]
    slot_to_third_group = {bracket["annexCSlots"][i]: assignment[i]
                           for i in range(len(assignment))}

    # Fyll R32 (32 platser) enligt feeder-specarna fran FIFA:s officiella trad.
    r32 = [resolve_slot(spec, standings, slot_to_third_group)
           for spec in bracket["order"]]

    # Spela av slutspelet. positions[rnd] = lista med deltagare i den rundan.
    positions = {"r32": r32}
    bronze = None                   # de tva semifinalforlorarna -> bronsmatch (m103)
    cur = r32
    for rnd in ROUND_ORDER[1:]:
        nxt, losers = [], []
        for m in range(0, len(cur), 2):
            a, b = cur[m], cur[m + 1]
            if rng.random() < winprob(a, b, strength):
                nxt.append(a); losers.append(b)
            else:
                nxt.append(b); losers.append(a)
        positions[rnd] = nxt
        if rnd == "final":          # forlorarna i semifinalerna gor upp om brons
            bronze = losers         # [forl. SF1, forl. SF2] = home/away i m103
        cur = nxt
    champion = positions["final"][0] if rng.random() < winprob(
        positions["final"][0], positions["final"][1], strength) else positions["final"][1]

    return positions, gpos, champion, bronze


# ========== Aggregering over manga simuleringar ==========
def simulate(n_sims):
    groups, fixtures, outrights = load_data()
    fixtures_by_group = defaultdict(list)
    for fx in fixtures:
        fixtures_by_group[fx["group"]].append(fx)
    strength = strengths_from_outrights(outrights)
    bracket = build_bracket()
    rng = random.Random()

    # Raknare
    pos_count = {rnd: [defaultdict(int) for _ in range(ROUND_TEAMS[rnd])]
                 for rnd in ROUND_ORDER}
    bronze_count = [defaultdict(int) for _ in range(2)]  # m103: forl. SF1, forl. SF2
    reached = {t: defaultdict(int) for t in strength}
    group_pos = {t: defaultdict(int) for t in strength}
    champ = defaultdict(int)

    for _ in range(n_sims):
        positions, gpos, champion, bronze = run_once(
            groups, fixtures_by_group, strength, bracket, rng)
        for t, pos in gpos.items():
            group_pos[t][pos] += 1
        for rnd in ROUND_ORDER:
            for i, team in enumerate(positions[rnd]):
                pos_count[rnd][i][team] += 1
                reached[team][rnd] += 1
        for i, team in enumerate(bronze):
            bronze_count[i][team] += 1
        champ[champion] += 1

    return build_output(n_sims, strength, pos_count, reached, group_pos, champ,
                        bracket, bronze_count)


def build_output(n, strength, pos_count, reached, group_pos, champ, bracket,
                 bronze_count):
    def dist(counter):
        return {t: round(c / n, 4) for t, c in
                sorted(counter.items(), key=lambda kv: kv[1], reverse=True)
                if c / n >= 0.001}

    nodes = {rnd: [dist(pos_count[rnd][i]) for i in range(ROUND_TEAMS[rnd])]
             for rnd in ROUND_ORDER}
    # Bronsmatchen (m103): nod med tva sidor = forlorarna i de tva semifinalerna.
    nodes["bronze"] = [dist(bronze_count[i]) for i in range(2)]
    rounds = {t: {**{rnd: round(reached[t][rnd] / n, 4) for rnd in ROUND_ORDER},
                  "win": round(champ[t] / n, 4)} for t in strength}
    group_positions = {t: {str(k): round(v / n, 4) for k, v in gp.items()}
                       for t, gp in group_pos.items()}

    return {
        "updated": datetime.now(timezone.utc).isoformat(),
        "nSims": n,
        "note": "R32-strukturen (assets/data.js) och basta-trean (FIFA Annex C, assets/annexc.js) ar officiella.",
        "slotLabels": bracket["labels"],   # position -> "1H", "2J" osv (for UI-text)
        "nodes": nodes,                    # klicka nod -> nodes[rnd][positionsindex]
        "rounds": rounds,                  # lag -> P(nar varje runda) + P(vinner)
        "groupPositions": group_positions,
    }


# ========== Bracket-struktur (FIFA officiell - via bracket_map.json) ==========
def build_bracket():
    """
    FIFA:s officiella R32-karta + Annex C, inlast ur bracket_map.json som
    gen_bracket_map.mjs genererar ur assets/data.js (WC.knockout) och
    assets/annexc.js (ANNEX_C). Inget hardkodas har - kor om generatorn om
    de kallorna andras. Motorns matematik ar oberoende av sjalva kartan.
    """
    data = json.loads(BRACKET_MAP_FILE.read_text())
    return {
        "order": data["order"],            # 32 feeder-specar (home, away per match)
        "labels": {"r32": data["labels"]}, # 32 etiketter ("1E", "3/ABCDF" ...)
        "annexCSlots": data["annexCSlots"],
        "annexC": data["annexC"],
    }


# ========== Indata (riktig fil eller syntetisk fallback) ==========
def load_data():
    fx_file = Path(os.environ.get("VM_GROUP_FIXTURES", "group_fixtures.json"))
    od_file = Path(os.environ.get("VM_WINNER_ODDS", "vinnarodds.json"))
    if fx_file.exists() and od_file.exists():
        fixtures = json.loads(fx_file.read_text())
        groups = defaultdict(list)
        for fx in fixtures:
            for team in (fx["home"], fx["away"]):
                if team not in groups[fx["group"]]:
                    groups[fx["group"]].append(team)
        raw = json.loads(od_file.read_text())
        outrights = {row["team"]: row["avgOdds"] for row in raw["teams"]}
        print(f"Laste riktig data: {len(fixtures)} matcher, {len(outrights)} lag")
        return dict(groups), fixtures, outrights

    print("VARNING: indatafiler saknas - kor pa SYNTETISK data (bara for test).")
    return make_synthetic()


def make_synthetic():
    rng = random.Random(42)
    groups, strength = {}, {}
    for L in LETTERS:
        teams = [f"{L}{i}" for i in range(1, 5)]
        groups[L] = teams
        for t in teams:
            strength[t] = rng.gauss(0, 1)

    def synth_1x2(sh, sa, home_adv=0.25, draw=0.26):
        p_home_excl = 1 / (1 + math.exp(-(sh + home_adv - sa)))
        ph = (1 - draw) * p_home_excl
        pa = (1 - draw) * (1 - p_home_excl)
        return ph, draw, pa

    fixtures = []
    for L, teams in groups.items():
        for i in range(4):
            for j in range(i + 1, 4):
                h, a = teams[i], teams[j]
                ph, px, pa = synth_1x2(strength[h], strength[a])
                fixtures.append({
                    "group": L, "home": h, "away": a, "result": None,
                    "odds": {"1": round(1 / ph, 2), "X": round(1 / px, 2),
                             "2": round(1 / pa, 2)},
                })
    ex = {t: math.exp(strength[t] * 1.4) for t in strength}
    z = sum(ex.values())
    outrights = {t: round(z / ex[t], 1) for t in strength}   # decimalodds ~ 1/p
    return groups, fixtures, outrights


def main():
    print(f"Simulerar {N_SIMS} turneringar...")
    out = simulate(N_SIMS)
    OUTPUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"Klart -> {OUTPUT_FILE}")
    top = sorted(out["rounds"].items(), key=lambda kv: kv[1]["win"], reverse=True)[:5]
    print("Topp 5 att vinna VM:")
    for t, r in top:
        print(f"  {t:5} {r['win']*100:5.1f}%   (final {r['final']*100:4.1f}%, "
              f"kvart {r['qf']*100:4.1f}%)")


if __name__ == "__main__":
    main()
