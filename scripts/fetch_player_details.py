#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_player_details.py
Hämtar komplett spelarinfo för VM 2026 från Wikipedias samlade truppsida
och bygger wc2026_players.json — redo för klickbara spelarsidor.

Per spelare: namn, position, tröjnummer, födelsedatum, ålder, landskamper,
mål, klubb, klubbland, kaptensflagga, url-slug.

Körning:
    pip install requests beautifulsoup4
    python scripts/fetch_player_details.py

Output: data/wc2026_players.json (relativt repo-roten)
"""

import json
import re
import unicodedata
from datetime import date

import requests
from bs4 import BeautifulSoup

URL = "https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_squads"
OUT = "data/wc2026_players.json"
TOURNAMENT_START = date(2026, 6, 11)

# Wikipedias rubriknamn -> (svenskt namn, FIFA-kod)
TEAM_META = {
    "Algeria": ("Algeriet", "ALG"), "Argentina": ("Argentina", "ARG"),
    "Australia": ("Australien", "AUS"), "Austria": ("Österrike", "AUT"),
    "Belgium": ("Belgien", "BEL"),
    "Bosnia and Herzegovina": ("Bosnien-Hercegovina", "BIH"),
    "Brazil": ("Brasilien", "BRA"), "Canada": ("Kanada", "CAN"),
    "Cape Verde": ("Kap Verde", "CPV"), "Colombia": ("Colombia", "COL"),
    "Croatia": ("Kroatien", "CRO"), "Curaçao": ("Curaçao", "CUW"),
    "Czech Republic": ("Tjeckien", "CZE"), "Czechia": ("Tjeckien", "CZE"),
    "DR Congo": ("DR Kongo", "COD"), "Ecuador": ("Ecuador", "ECU"),
    "Egypt": ("Egypten", "EGY"), "England": ("England", "ENG"),
    "France": ("Frankrike", "FRA"), "Germany": ("Tyskland", "GER"),
    "Ghana": ("Ghana", "GHA"), "Haiti": ("Haiti", "HAI"),
    "Iran": ("Iran", "IRN"), "Iraq": ("Irak", "IRQ"),
    "Ivory Coast": ("Elfenbenskusten", "CIV"),
    "Côte d'Ivoire": ("Elfenbenskusten", "CIV"),
    "Japan": ("Japan", "JPN"), "Jordan": ("Jordanien", "JOR"),
    "Mexico": ("Mexiko", "MEX"), "Morocco": ("Marocko", "MAR"),
    "Netherlands": ("Nederländerna", "NED"),
    "New Zealand": ("Nya Zeeland", "NZL"), "Norway": ("Norge", "NOR"),
    "Panama": ("Panama", "PAN"), "Paraguay": ("Paraguay", "PAR"),
    "Portugal": ("Portugal", "POR"), "Qatar": ("Qatar", "QAT"),
    "Saudi Arabia": ("Saudiarabien", "KSA"), "Scotland": ("Skottland", "SCO"),
    "Senegal": ("Senegal", "SEN"), "South Africa": ("Sydafrika", "RSA"),
    "South Korea": ("Sydkorea", "KOR"), "Spain": ("Spanien", "ESP"),
    "Sweden": ("Sverige", "SWE"), "Switzerland": ("Schweiz", "SUI"),
    "Tunisia": ("Tunisien", "TUN"),
    "Turkey": ("Turkiet", "TUR"), "Türkiye": ("Turkiet", "TUR"),
    "United States": ("USA", "USA"), "Uruguay": ("Uruguay", "URU"),
    "Uzbekistan": ("Uzbekistan", "UZB"),
}

POS_MAP = {"GK": "goalkeeper", "DF": "defender",
           "MF": "midfielder", "FW": "forward"}
POS_SV = {"GK": "Målvakt", "DF": "Försvarare",
          "MF": "Mittfältare", "FW": "Anfallare"}


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s


def clean(text: str) -> str:
    text = re.sub(r"\[.*?\]", "", text)  # fotnoter [a], [1]
    for ch in ("\u200b", "\u200c", "\u2060", "\u00ad"):
        text = text.replace(ch, "")
    return re.sub(r"\s+", " ", text).strip()


def parse_dob(cell_text: str):
    """'(1992-05-13)13 May 1992 (aged 34)' -> ('1992-05-13', 34)"""
    iso = re.search(r"\((\d{4}-\d{2}-\d{2})\)", cell_text)
    age = re.search(r"aged?\s+(\d+)", cell_text)
    dob = iso.group(1) if iso else None
    if dob and not age:
        y, m, d = map(int, dob.split("-"))
        b = date(y, m, d)
        a = TOURNAMENT_START.year - b.year - (
            (TOURNAMENT_START.month, TOURNAMENT_START.day) < (b.month, b.day))
        return dob, a
    return dob, int(age.group(1)) if age else None


def main():
    print("Hämtar", URL)
    html = requests.get(URL, headers={
        "User-Agent": "WC2026SquadBot/1.0 (personal World Cup site)"
    }, timeout=60).text
    soup = BeautifulSoup(html, "html.parser")

    teams, problems = [], []
    current_group = None

    # Gå igenom dokumentet i ordning: h2 = grupp, h3 = lag, tabell = trupp
    for el in soup.select("h2, h3, table.sortable, table.wikitable"):
        if el.name == "h2":
            t = clean(el.get_text())
            m = re.match(r"Group ([A-L])", t)
            current_group = m.group(1) if m else current_group
            continue
        if el.name == "h3":
            current_team = clean(el.get_text())
            continue
        # Tabell — hör den till ett känt lag?
        if current_team not in TEAM_META:
            continue
        name_sv, code = TEAM_META[current_team]
        if any(t["fifa_code"] == code for t in teams):
            continue  # redan parsad (skydd mot extra tabeller)

        players = []
        for row in el.select("tr"):
            cells = row.find_all(["td", "th"])
            if len(cells) < 7:
                continue
            pos_raw = clean(cells[1].get_text()).upper()
            # Wikipedia kan visa "1GK", "2DF" m.fl. – plocka ut positionskoden.
            m = re.search(r"(GK|DF|MF|FW)$", pos_raw)
            if m:
                pos_raw = m.group(1)
            if pos_raw not in POS_MAP:
                continue
            raw_name = clean(cells[2].get_text())
            captain = "(captain)" in raw_name.lower() or "(c)" in raw_name.lower()
            pname = re.sub(r"\s*\((captain|c|vice-captain|vc)\)\s*", "",
                           raw_name, flags=re.I).strip()
            dob, age = parse_dob(clean(cells[3].get_text()))
            caps = clean(cells[4].get_text())
            goals = clean(cells[5].get_text())
            club_cell = cells[6]
            club = clean(club_cell.get_text())
            club_country = None
            flag = club_cell.find("span", class_="flagicon")
            if flag:
                a = flag.find("a")
                img = flag.find("img")
                club_country = (a.get("title") if a and a.get("title")
                                else (img.get("alt") if img else None))

            num_txt = clean(cells[0].get_text())
            players.append({
                "id": f"{code.lower()}-{slugify(pname)}",
                "name": pname,
                "shirt_number": int(num_txt) if num_txt.isdigit() else None,
                "position": POS_MAP[pos_raw],
                "position_sv": POS_SV[pos_raw],
                "pos_code": pos_raw,
                "captain": captain,
                "date_of_birth": dob,
                "age": age,
                "caps": int(caps) if caps.isdigit() else None,
                "goals": int(goals) if goals.isdigit() else None,
                "club": club,
                "club_country": club_country,
            })

        if len(players) < 23 or len(players) > 26:
            problems.append(f"{current_team}: {len(players)} spelare")
        teams.append({
            "name": current_team,
            "name_sv": name_sv,
            "fifa_code": code,
            "group": current_group,
            "squad_size": len(players),
            "players": players,
        })

    out = {
        "tournament": "FIFA World Cup 2026",
        "source": URL,
        "fetched": date.today().isoformat(),
        "team_count": len(teams),
        "total_players": sum(t["squad_size"] for t in teams),
        "teams": teams,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"Klart: {OUT} — {len(teams)} lag, {out['total_players']} spelare")
    if len(teams) != 48:
        print("OBS: förväntade 48 lag. Kontrollera TEAM_META mot sidans rubriker.")
    for p in problems:
        print("Kontrollera:", p)


if __name__ == "__main__":
    main()
