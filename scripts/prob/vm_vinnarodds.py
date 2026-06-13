#!/usr/bin/env python3
"""
VM 2026 vinnarodds-hämtare (The Odds API)
Hämtar outright-odds ("vem vinner VM") från 350+ bookmakers, slår ihop
dem per landslag och skriver resultatet till vinnarodds.json.

Till skillnad från match-odds rör sig vinnarodds långsamt, så det här
scriptet är gjort för att KÖRAS EN GÅNG och avsluta. Lägg det i en
cron-job som kör t.ex. var 2-3:e timme - det sparar API-kvoten.

  # crontab -e  -> var 3:e timme:
  0 */3 * * * /usr/bin/python3 /sökväg/vm_vinnarodds.py

Körning manuellt:  ODDS_API_KEY=din_nyckel python3 vm_vinnarodds.py
Kräver:            pip install requests
Skaffa gratisnyckel på: https://the-odds-api.com  (gratisnivå har månadskvot)
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

from teamnames import canonical, CANONICAL_TEAMS

# ---------- Konfiguration ----------
API_KEY = os.environ.get("ODDS_API_KEY", "")   # lägg din nyckel i miljövariabel
SPORT_KEY = "soccer_fifa_world_cup_winner"      # outright-nyckeln för VM-vinnaren
REGIONS = "eu,uk"                               # bookmaker-regioner (eu,uk,us,au)
ODDS_FORMAT = "decimal"                          # vi vill ha 2.45, inte 29/20
OUTPUT_FILE = Path(os.environ.get("VM_WINNER_ODDS", "vinnarodds.json"))
BASE = "https://api.the-odds-api.com/v4"


def get_winner_odds():
    """Hämtar rå outright-data för VM-vinnaren. Returnerar listan av events."""
    url = f"{BASE}/sports/{SPORT_KEY}/odds"
    params = {
        "apiKey": API_KEY,
        "regions": REGIONS,
        "markets": "outrights",
        "oddsFormat": ODDS_FORMAT,
    }
    try:
        r = requests.get(url, params=params, timeout=20)
    except requests.RequestException as e:
        print(f"Nätverksfel: {e}")
        return None

    # Kvot-info skickas i svarets headers - bra att hålla koll på
    remaining = r.headers.get("x-requests-remaining")
    used = r.headers.get("x-requests-used")
    if remaining is not None:
        print(f"API-kvot: {used} använda, {remaining} kvar denna månad")

    if r.status_code == 401:
        print("FEL: Ogiltig eller saknad API-nyckel (ODDS_API_KEY).")
        return None
    if r.status_code == 404:
        print(f"FEL: Okänd sport-nyckel '{SPORT_KEY}'. "
              f"Kolla aktuell nyckel via {BASE}/sports/?apiKey=DIN_NYCKEL")
        return None
    if r.status_code == 429:
        print("FEL: Kvoten är slut för månaden (HTTP 429).")
        return None
    if r.status_code != 200:
        print(f"FEL: HTTP {r.status_code} - {r.text[:200]}")
        return None

    return r.json()


def aggregate_by_team(events):
    """
    Slår ihop alla bookmakers till en rad per landslag.
    För varje lag: bästa odds, snittodds, antal bookmakers + implied %.
    """
    # team -> lista av (bookmaker, odds)
    teams = {}
    for ev in events:
        for bk in ev.get("bookmakers", []):
            book = bk.get("title", bk.get("key", "?"))
            for market in bk.get("markets", []):
                if market.get("key") != "outrights":
                    continue
                for outcome in market.get("outcomes", []):
                    name = outcome.get("name")
                    price = outcome.get("price")
                    if not name or not price:
                        continue
                    teams.setdefault(name, []).append((book, price))

    out = []
    for name, quotes in teams.items():
        prices = [p for _, p in quotes]
        best = max(prices)
        avg = round(sum(prices) / len(prices), 2)
        # bästa pris + vilken bookmaker som gav det
        best_book = max(quotes, key=lambda q: q[1])[0]
        out.append({
            "team": name,
            "bestOdds": best,                       # högsta (bästa) decimalodds
            "bestBook": best_book,
            "avgOdds": avg,                          # snitt över alla bookmakers
            "books": len(prices),                    # hur många bookmakers
            "impliedPct": round(100 / avg, 1),       # marknadens sannolikhet (~)
        })

    # sortera favorit -> outsider (lägst snittodds först)
    out.sort(key=lambda t: t["avgOdds"])
    return out


def canonicalize_and_complete(teams):
    """Mappar lagnamn -> sajtens kanoniska namn (teams.json) och ser till att ALLA
    48 deltagande lag finns med. Motorn bygger styrkor ur den har filen och kraschar
    pa ett lag som saknas, sa saknade lag fylls med en lang default-odds."""
    by_name, unknown = {}, []
    for row in teams:
        canon = canonical(row.get("team", ""))
        if canon is None:
            unknown.append(row.get("team"))
            continue
        row = {**row, "team": canon}
        if canon not in by_name or row["avgOdds"] < by_name[canon]["avgOdds"]:
            by_name[canon] = row
    if unknown:
        print(f"VARNING: outright-lag utan kanonisering (ignoreras): {sorted(set(unknown))}")
    missing = [t for t in CANONICAL_TEAMS if t not in by_name]
    if missing:
        longshot = round(max((r["avgOdds"] for r in by_name.values()), default=300.0) * 3, 1)
        for t in missing:
            by_name[t] = {"team": t, "bestOdds": longshot, "bestBook": "—",
                          "avgOdds": longshot, "books": 0, "impliedPct": round(100 / longshot, 1)}
        print(f"VARNING: {len(missing)} lag saknade outright-odds, fyllde med {longshot}: {missing}")
    return sorted(by_name.values(), key=lambda t: t["avgOdds"])


def main():
    if not API_KEY:
        print("Sätt din nyckel först:  export ODDS_API_KEY=din_nyckel")
        sys.exit(1)

    print("Hämtar VM-vinnarodds...")
    events = get_winner_odds()
    if not events:
        print("Inga odds hämtade - filen lämnas oförändrad.")
        sys.exit(1)

    teams = aggregate_by_team(events)
    if not teams:
        print("Inga lag hittades i svaret (marknaden kanske inte är öppen än).")
        sys.exit(1)

    teams = canonicalize_and_complete(teams)

    payload = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "source": "the-odds-api.com",
        "market": "VM-vinnare (outright)",
        "teams": teams,
    }
    OUTPUT_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2)
    )
    print(f"Klart: {len(teams)} lag skrivna till {OUTPUT_FILE}")
    print(f"Favorit: {teams[0]['team']} "
          f"({teams[0]['avgOdds']}, ~{teams[0]['impliedPct']}%)")


if __name__ == "__main__":
    main()
