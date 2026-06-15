#!/usr/bin/env python3
"""
VM 2026 grupp-odds (1X2) -> group_fixtures.json
================================================
Bygger indatafilen som vm_sannolikheter.py:s load_data() laser. Formatet ar
en LISTA av matcher, exakt:

    { "group": "A", "home": "Mexico", "away": "South Africa",
      "result": "1"|"X"|"2"|null, "odds": {"1": 2.10, "X": 3.30, "2": 3.40} }

Lagnamn kanoniseras till sajtens namn (assets/data.js) via teamnames.py, sa att
group_fixtures.json och vinnarodds.json delar EXAKT samma nycklar som motorn.

Kallor:
  - data/results.json  : alla 72 gruppmatcher (lagpar + ev. spelat resultat).
  - The Odds API (h2h) : 1X2-matchodds for ospelade matcher.
  - vinnarodds.json    : faller tillbaka pa lagstyrkor om en match saknar
                         marknadsodds (sa motorn alltid har odds att simulera pa).

Spelade matcher skrivs med sitt "result" -> simuleringen betingar pa det kanda.
Odds devigas i MOTORN (strengths/devig) - vi skickar ra decimalodds, ingen dubbel-vig.

Kor:
  ODDS_API_KEY=din_nyckel python3 vm_odds.py
Utan nyckel byggs filen anda (ospelade matcher far syntetiska odds ur
vinnaroddsen) - bra for test och sa att jobbet inte kraschar nar kvoten ar slut.

Miljovariabler:
  ODDS_API_KEY ODDS_SPORT_KEY(soccer_fifa_world_cup) ODDS_REGIONS(eu,uk)
  VM_RESULTS VM_WINNER_ODDS VM_GROUP_FIXTURES
"""

import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from teamnames import canonical, norm

try:
    import requests
except ImportError:
    requests = None

# ---------- Konfiguration ----------
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
API_KEY = os.environ.get("ODDS_API_KEY", "")
SPORT_KEY = os.environ.get("ODDS_SPORT_KEY", "soccer_fifa_world_cup")
REGIONS = os.environ.get("ODDS_REGIONS", "eu,uk")
RESULTS_FILE = Path(os.environ.get("VM_RESULTS", ROOT / "data" / "results.json"))
WINNER_ODDS = Path(os.environ.get("VM_WINNER_ODDS", SCRIPT_DIR / "vinnarodds.json"))
OUTPUT = Path(os.environ.get("VM_GROUP_FIXTURES", SCRIPT_DIR / "group_fixtures.json"))
ODDS_CACHE = Path(os.environ.get("VM_ODDS_CACHE", SCRIPT_DIR / "odds_cache.json"))
# FETCH_MARKET_ODDS=0 -> hoppa over API-anrop, anvand cachade odds (for taeta
# "raekna om pa nya resultat"-koerningar som inte ska kosta manadskvot).
FETCH_MARKET = os.environ.get("FETCH_MARKET_ODDS", "1").lower() not in ("0", "false", "no", "off")
BASE = "https://api.the-odds-api.com/v4"


# ---------- Schema + resultat fran results.json ----------
def load_fixtures():
    """Listan av gruppmatcher (group, home, away, result) ur results.json, kanoniserad."""
    if not RESULTS_FILE.exists():
        print(f"FEL: hittar inte {RESULTS_FILE}")
        sys.exit(1)
    data = json.loads(RESULTS_FILE.read_text())
    fixtures = data.get("fixtures", {})
    results = data.get("results", {})
    out, unknown = [], set()
    for key, fx in fixtures.items():
        if not key.startswith("g:"):
            continue
        group = key.split(":")[1]
        home = canonical(fx.get("home")) or fx.get("home")
        away = canonical(fx.get("away")) or fx.get("away")
        if canonical(fx.get("home")) is None:
            unknown.add(fx.get("home"))
        if canonical(fx.get("away")) is None:
            unknown.add(fx.get("away"))
        result = None
        score = None
        res = results.get(key)
        status = (res or {}).get("status") or fx.get("status")
        if res and res.get("h") is not None and res.get("a") is not None \
                and str(status).upper() in ("FINISHED", "FULL_TIME", "FT"):
            h, a = res["h"], res["a"]
            result = "1" if h > a else ("2" if a > h else "X")
            score = [h, a]   # behall malsiffran sa motorn kan vikta malskillnad
        out.append({"group": group, "home": home, "away": away, "result": result,
                    "score": score, "idx": int(key.split(":")[2])})
    if unknown:
        print(f"VARNING: okanda lagnamn (ingen kanonisering): {sorted(unknown)}")
    out.sort(key=lambda m: (m["group"], m["idx"]))
    return out


# ---------- Marknadsodds (The Odds API, h2h = 1X2) ----------
def fetch_h2h_odds():
    """Lista av {home, away, avg{namn:pris}} ur The Odds API. [] vid fel/ingen nyckel."""
    if not API_KEY:
        print("Ingen ODDS_API_KEY satt - hoppar over marknadsodds (syntetiserar ospelade).")
        return []
    if requests is None:
        print("Modulen 'requests' saknas (pip install requests) - syntetiserar ospelade.")
        return []
    url = f"{BASE}/sports/{SPORT_KEY}/odds"
    params = {"apiKey": API_KEY, "regions": REGIONS, "markets": "h2h", "oddsFormat": "decimal"}
    try:
        r = requests.get(url, params=params, timeout=20)
    except requests.RequestException as e:
        print(f"Natverksfel mot odds-API: {e} - syntetiserar ospelade.")
        return []
    rem, used = r.headers.get("x-requests-remaining"), r.headers.get("x-requests-used")
    if rem is not None:
        print(f"API-kvot: {used} anvanda, {rem} kvar denna manad")
    if r.status_code != 200:
        print(f"Odds-API gav HTTP {r.status_code} ({r.text[:120]}) - syntetiserar ospelade.")
        return []

    out = []
    for ev in r.json():
        prices = {}
        for bk in ev.get("bookmakers", []):
            for market in bk.get("markets", []):
                if market.get("key") != "h2h":
                    continue
                for oc in market.get("outcomes", []):
                    nm, pr = oc.get("name"), oc.get("price")
                    if nm and pr:
                        prices.setdefault(nm, []).append(pr)
        if prices:
            out.append({
                "home": ev.get("home_team"), "away": ev.get("away_team"),
                "avg": {nm: round(sum(ps) / len(ps), 3) for nm, ps in prices.items()},
            })
    print(f"Hamtade h2h-odds for {len(out)} matcher.")
    return out


# ---------- Lagstyrkor ur vinnaroddsen (for syntetisk fallback) ----------
def load_strengths():
    """kanoniskt_lag -> rating (hogre = starkare) ur vinnarodds.json. {} om filen saknas."""
    if not WINNER_ODDS.exists():
        return {}
    raw = json.loads(WINNER_ODDS.read_text())
    inv = {}
    for row in raw.get("teams", []):
        team = canonical(row.get("team", "")) or row.get("team")
        odds = row.get("avgOdds")
        if team and odds:
            inv[team] = 1.0 / odds
    if not inv:
        return {}
    z = sum(inv.values())
    return {t: math.log(inv[t] / z) for t in inv}


def synth_1x2(sh, sa, home_adv=0.20, draw=0.26):
    """Syntetiska 1X2-decimalodds ur tva ratings (samma form som motorns make_synthetic)."""
    p_home_excl = 1.0 / (1.0 + math.exp(-(sh + home_adv - sa)))
    ph = (1 - draw) * p_home_excl
    pa = (1 - draw) * (1 - p_home_excl)
    return {"1": round(1 / ph, 2), "X": round(1 / draw, 2), "2": round(1 / pa, 2)}


# ---------- Sammanfogning ----------
def market_odds_for(m, h2h):
    """1X2-odds fran marknaden for match m, orienterat mot m.home/away. None om saknas."""
    for ev in h2h:
        eh, ea = canonical(ev["home"]), canonical(ev["away"])
        if not eh or not ea or {eh, ea} != {m["home"], m["away"]}:
            continue
        avg = ev["avg"]
        draw = next((v for k, v in avg.items() if norm(k) in ("draw", "tie", "x")), None)
        ph = next((v for k, v in avg.items() if canonical(k) == m["home"]), None)
        pa = next((v for k, v in avg.items() if canonical(k) == m["away"]), None)
        if ph and pa and draw:
            return {"1": ph, "X": draw, "2": pa}
    return None


def get_market_odds():
    """Hamtar h2h-odds och cachar dem. Vid FETCH_MARKET_ODDS=0 (eller misslyckad
    hamtning) laeses cachen utan API-anrop, sa frekventa omkoerningar ar gratis."""
    if FETCH_MARKET and API_KEY:
        h2h = fetch_h2h_odds()
        if h2h:
            try:
                ODDS_CACHE.write_text(json.dumps(h2h, ensure_ascii=False))
            except OSError:
                pass
            return h2h
        print("Hamtning gav inga odds - faller tillbaka pa cache om den finns.")
    if ODDS_CACHE.exists():
        try:
            cached = json.loads(ODDS_CACHE.read_text())
            print(f"Anvander cachade marknadsodds ({len(cached)} matcher) - inget API-anrop.")
            return cached
        except (OSError, ValueError):
            pass
    if not FETCH_MARKET:
        print("FETCH_MARKET_ODDS=0 och ingen cache - syntetiserar ospelade.")
    return []


def main():
    fixtures = load_fixtures()
    h2h = get_market_odds()
    strengths = load_strengths()

    out = []
    stats = {"market": 0, "synth": 0, "neutral": 0, "played": 0}
    for m in fixtures:
        odds = market_odds_for(m, h2h)
        source = "market"
        if odds is None:
            sh, sa = strengths.get(m["home"]), strengths.get(m["away"])
            if sh is not None and sa is not None:
                odds, source = synth_1x2(sh, sa), "synth"
            else:
                odds, source = {"1": 2.60, "X": 3.20, "2": 2.70}, "neutral"
        if m["result"] is not None:
            stats["played"] += 1
        else:
            stats[source] += 1
        out.append({"group": m["group"], "home": m["home"], "away": m["away"],
                    "result": m["result"], "score": m.get("score"), "odds": odds})

    OUTPUT.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"Klart -> {OUTPUT}  ({len(out)} matcher)")
    print(f"  spelade: {stats['played']}  |  ospelade: marknad {stats['market']}, "
          f"syntetiska {stats['synth']}, neutrala {stats['neutral']}")
    if stats["neutral"]:
        print("  OBS: neutrala odds anvanda (saknar bade marknad och vinnarodds) for "
              f"{stats['neutral']} matcher.")


if __name__ == "__main__":
    main()
