/*
  seed_players_from_squads.mjs
  Bygger en initial data/wc2026_players.json från grunddatan
  data/wc2026_squads.json så att sajten har truppdata direkt.

  Detaljfält (tröjnummer, födelsedatum, ålder, landskamper, mål, klubb)
  saknas i grunddatan och sätts till null tills GitHub Action kör
  scripts/fetch_player_details.py som berikar filen från Wikipedia.

  Körning:  node scripts/seed_players_from_squads.mjs
*/
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQUADS = join(ROOT, "data", "wc2026_squads.json");
const OUT = join(ROOT, "data", "wc2026_players.json");

const POS_MAP = { GK: "goalkeeper", DF: "defender", MF: "midfielder", FW: "forward" };
const POS_SV = { GK: "Målvakt", DF: "Försvarare", MF: "Mittfältare", FW: "Anfallare" };

// FIFA-kod -> grupp (A–L), samma indelning som assets/data.js.
const GROUP_BY_CODE = {
  MEX: "A", KOR: "A", RSA: "A", CZE: "A",
  CAN: "B", SUI: "B", QAT: "B", BIH: "B",
  BRA: "C", MAR: "C", SCO: "C", HAI: "C",
  USA: "D", PAR: "D", AUS: "D", TUR: "D",
  GER: "E", ECU: "E", CIV: "E", CUW: "E",
  NED: "F", JPN: "F", TUN: "F", SWE: "F",
  BEL: "G", IRN: "G", EGY: "G", NZL: "G",
  ESP: "H", URU: "H", KSA: "H", CPV: "H",
  FRA: "I", SEN: "I", NOR: "I", IRQ: "I",
  ARG: "J", AUT: "J", ALG: "J", JOR: "J",
  POR: "K", COL: "K", UZB: "K", COD: "K",
  ENG: "L", CRO: "L", PAN: "L", GHA: "L",
};

const POS_GROUPS = [
  ["goalkeepers", "GK"],
  ["defenders", "DF"],
  ["midfielders", "MF"],
  ["forwards", "FW"],
];

function slugify(name) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

const squads = JSON.parse(readFileSync(SQUADS, "utf-8"));

const teams = squads.teams.map((t) => {
  const code = t.fifa_code;
  const players = [];
  for (const [field, pos] of POS_GROUPS) {
    (t[field] || []).forEach((name) => {
      players.push({
        id: `${code.toLowerCase()}-${slugify(name)}`,
        name,
        shirt_number: null,
        position: POS_MAP[pos],
        position_sv: POS_SV[pos],
        pos_code: pos,
        captain: false,
        date_of_birth: null,
        age: null,
        caps: null,
        goals: null,
        club: null,
        club_country: null,
      });
    });
  }
  return {
    name: t.name,
    name_sv: t.name_sv,
    fifa_code: code,
    group: GROUP_BY_CODE[code] || null,
    squad_size: t.squad_size != null ? t.squad_size : players.length,
    players,
  };
});

const out = {
  tournament: "FIFA World Cup 2026",
  source: "Seed från data/wc2026_squads.json (platshållare tills Wikipedia-synk)",
  fetched: new Date().toISOString().slice(0, 10),
  team_count: teams.length,
  total_players: teams.reduce((n, t) => n + t.players.length, 0),
  teams,
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf-8");
console.log(`Klart: ${OUT} — ${out.team_count} lag, ${out.total_players} spelare`);
