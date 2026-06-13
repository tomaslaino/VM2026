#!/usr/bin/env node
/*
  Bootstrap/fallback-vinnarodds ur FIFA-rankingen i assets/data.js.
  Anvands nar marknadsodds inte finns (ingen ODDS_API_KEY / kvot slut), sa att
  hela pipan + sajten har riktig data anda. vm_vinnarodds.py SKRIVER OVER denna
  med marknadsodds nar nyckeln finns.

    node scripts/prob/gen_fallback_outrights.mjs   # -> scripts/prob/vinnarodds.json

  Skriver INTE over en fil som redan kommer fran marknaden (source = the-odds-api).
*/
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "assets/data.js"), "utf8"), sandbox);
const WC = sandbox.WC;

const outFile = path.join(__dirname, "vinnarodds.json");
// Rör inte en marknadshämtad fil.
if (fs.existsSync(outFile)) {
  try {
    const cur = JSON.parse(fs.readFileSync(outFile, "utf8"));
    if (cur.source && String(cur.source).includes("odds-api")) {
      console.log("vinnarodds.json kommer redan från marknaden – lämnar orörd.");
      process.exit(0);
    }
  } catch {
    /* trasig fil – skriv om */
  }
}

// Grov outright-odds ur FIFA-ranking (lägre rank = starkare = lägre odds).
const teams = [];
for (const arr of Object.values(WC.groups)) {
  for (const t of arr) {
    const rank = WC.fifaRank?.[t.iso] ?? 60;
    const avg = Math.round((1 + rank * 1.7) * 10) / 10;
    teams.push({
      team: t.name,
      bestOdds: avg,
      bestBook: "—",
      avgOdds: avg,
      books: 0,
      impliedPct: Math.round((100 / avg) * 10) / 10,
    });
  }
}
teams.sort((a, b) => a.avgOdds - b.avgOdds);

const payload = {
  updated: null,
  source: "fallback (FIFA-ranking i data.js)",
  market: "VM-vinnare (bootstrap – ersätts av marknadsodds när ODDS_API_KEY finns)",
  teams,
};
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(`OK -> ${path.relative(ROOT, outFile)}  (${teams.length} lag, favorit ${teams[0].team} ${teams[0].avgOdds})`);
