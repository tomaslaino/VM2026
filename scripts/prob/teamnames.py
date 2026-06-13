#!/usr/bin/env python3
"""
Delad lagnamns-kanonisering for sannolikhetspipan.
Kanoniskt namn = sajtens namn i assets/data.js. Laser teams.json (genererad av
gen_bracket_map.mjs) och mappar ESPN-/odds-API-stavningar till kanoniskt namn.
"""

import json
import unicodedata
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_TEAMS_FILE = _SCRIPT_DIR / "teams.json"


def norm(name):
    """Normaliserar for matchning: utan accenter, gemener, bara a-z0-9."""
    s = unicodedata.normalize("NFKD", name or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return "".join(c for c in s.lower() if c.isalnum())


def _load():
    if not _TEAMS_FILE.exists():
        raise FileNotFoundError(
            f"{_TEAMS_FILE} saknas - kor: node scripts/prob/gen_bracket_map.mjs"
        )
    data = json.loads(_TEAMS_FILE.read_text())
    teams = [t["name"] for t in data["teams"]]
    aliases = data["aliases"]  # redan normaliserade nycklar -> kanoniskt namn
    return teams, aliases


CANONICAL_TEAMS, _ALIASES = _load()


def canonical(name):
    """Kanoniskt lagnamn, eller None om okant (sa anroparen kan varna)."""
    return _ALIASES.get(norm(name))
