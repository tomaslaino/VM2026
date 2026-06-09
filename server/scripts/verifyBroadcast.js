/**
 * Verifierar WC.tvBroadcast mot användarens tablå.
 * Visar varje match med lag (sv), förväntad kanal och vad data.js har.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WC_GROUPS } from "../wcTeams.js";
import { canonicalTeam } from "../wcFixtures.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RR = [[[0, 1], [2, 3]], [[0, 2], [3, 1]], [[3, 0], [1, 2]]];

// Läs data.js tvBroadcast
const dataJs = fs.readFileSync(path.join(__dir, "../../assets/data.js"), "utf8");
const tvMatch = dataJs.match(/WC\.tvBroadcast\s*=\s*\{([\s\S]*?)\};/);
const current = {};
if (tvMatch) {
  for (const m of tvMatch[1].matchAll(/"(g:[A-L]:\d+|k:\d+)":\s*"(SVT|TV4)"/g)) {
    current[m[1]] = m[2];
  }
}

// Läs WC.groups sv-namn från data.js
const groups = {};
for (const L of "ABCDEFGHIJKL") {
  const re = new RegExp(`${L}:\\s*\\[([\\s\\S]*?)\\]\\s*,?\\s*[A-L]:`, "m");
  const block = dataJs.match(new RegExp(`${L}:\\s*\\[([\\s\\S]*?)\\n  \\]`, "m"));
  if (!block) continue;
  groups[L] = [];
  for (const t of block[1].matchAll(/sv:\s*"([^"]+)"/g)) groups[L].push(t[1]);
}

function fixtureTeams(key) {
  const m = key.match(/^g:([A-L]):(\d+)$/);
  if (!m) return null;
  const L = m[1];
  const idx = +m[2];
  const teams = WC_GROUPS[L];
  let i = 0;
  for (let md = 0; md < RR.length; md++) {
    for (const [h, a] of RR[md]) {
      if (i === idx) {
        const sv = groups[L] || [];
        return `${sv[h] || teams[h]} – ${sv[a] || teams[a]}`;
      }
      i++;
    }
  }
  return null;
}

const SV_TO_EN = {
  Mexiko: "Mexico", Sydafrika: "South Africa", Sydkorea: "South Korea", Tjeckien: "Czechia",
  Kanada: "Canada", "Bosnien och Hercegovina": "Bosnia-Herzegovina", USA: "USA", Paraguay: "Paraguay",
  Qatar: "Qatar", Schweiz: "Switzerland", Brasilien: "Brazil", Marocko: "Morocco", Haiti: "Haiti",
  Skottland: "Scotland", Australien: "Australia", Turkiet: "Türkiye", Tyskland: "Germany",
  Curacao: "Curaçao", Nederländerna: "Netherlands", Japan: "Japan", Elfenbenskusten: "Ivory Coast",
  Ecuador: "Ecuador", Sverige: "Sweden", Tunisien: "Tunisia", Spanien: "Spain", "Kap Verde": "Cape Verde",
  Belgien: "Belgium", Egypten: "Egypt", Saudiarabien: "Saudi Arabia", Uruguay: "Uruguay", Iran: "Iran",
  "Nya Zeeland": "New Zealand", Frankrike: "France", Senegal: "Senegal", Irak: "Iraq", Norge: "Norway",
  Argentina: "Argentina", Algeriet: "Algeria", Österrike: "Austria", Jordanien: "Jordan",
  Portugal: "Portugal", "Kongo-Kinshasa": "DR Congo", England: "England", Kroatien: "Croatia",
  Ghana: "Ghana", Panama: "Panama", Uzbekistan: "Uzbekistan", Colombia: "Colombia",
};

function pairKey(a, b) {
  const x = canonicalTeam(a);
  const y = canonicalTeam(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

const keyByPair = new Map();
const keyLabels = new Map();
for (const [letter, teams] of Object.entries(WC_GROUPS)) {
  let idx = 0;
  for (let md = 0; md < RR.length; md++) {
    for (const [h, a] of RR[md]) {
      const key = `g:${letter}:${idx}`;
      keyByPair.set(pairKey(teams[h], teams[a]), key);
      const sv = groups[letter] || [];
      keyLabels.set(key, `${sv[h] || teams[h]} – ${sv[a] || teams[a]}`);
      idx++;
    }
  }
}

// Full användarlista med datum (för felsökning)
const USER_SCHEDULE = `
2026-06-11 21:00 Mexiko vs Sydafrika TV4
2026-06-12 04:00 Sydkorea vs Tjeckien TV4
2026-06-12 21:00 Kanada vs Bosnien och Hercegovina SVT
2026-06-13 03:00 USA vs Paraguay TV4
2026-06-13 21:00 Qatar vs Schweiz TV4
2026-06-14 00:00 Brasilien vs Marocko SVT
2026-06-14 03:00 Haiti vs Skottland SVT
2026-06-14 06:00 Australien vs Turkiet TV4
2026-06-14 19:00 Tyskland vs Curacao TV4
2026-06-14 22:00 Nederländerna vs Japan TV4
2026-06-15 01:00 Elfenbenskusten vs Ecuador TV4
2026-06-15 04:00 Sverige vs Tunisien SVT
2026-06-15 18:00 Spanien vs Kap Verde SVT
2026-06-15 21:00 Belgien vs Egypten SVT
2026-06-16 00:00 Saudiarabien vs Uruguay TV4
2026-06-16 03:00 Iran vs Nya Zeeland TV4
2026-06-16 21:00 Frankrike vs Senegal SVT
2026-06-17 00:00 Irak vs Norge TV4
2026-06-17 03:00 Argentina vs Algeriet TV4
2026-06-17 06:00 Österrike vs Jordanien TV4
2026-06-17 19:00 Portugal vs Kongo-Kinshasa TV4
2026-06-17 22:00 England vs Kroatien TV4
2026-06-18 01:00 Ghana vs Panama TV4
2026-06-18 04:00 Uzbekistan vs Colombia TV4
2026-06-18 18:00 Tjeckien vs Sydafrika TV4
2026-06-18 21:00 Schweiz vs Bosnien och Hercegovina TV4
2026-06-19 00:00 Kanada vs Qatar TV4
2026-06-19 03:00 Mexiko vs Sydkorea TV4
2026-06-19 21:00 USA vs Australien SVT
2026-06-20 00:00 Skottland vs Marocko SVT
2026-06-20 03:00 Brasilien vs Haiti TV4
2026-06-20 06:00 Turkiet vs Paraguay TV4
2026-06-20 19:00 Nederländerna vs Sverige TV4
2026-06-20 22:00 Tyskland vs Elfenbenskusten TV4
2026-06-21 02:00 Ecuador vs Curacao TV4
2026-06-21 06:00 Tunisien vs Japan SVT
2026-06-21 18:00 Spanien vs Saudiarabien TV4
2026-06-21 21:00 Belgien vs Iran TV4
2026-06-22 00:00 Uruguay vs Kap Verde TV4
2026-06-22 03:00 Nya Zeeland vs Egypten TV4
2026-06-22 19:00 Argentina vs Österrike SVT
2026-06-22 23:00 Frankrike vs Irak SVT
2026-06-23 02:00 Norge vs Senegal SVT
2026-06-23 05:00 Jordanien vs Algeriet TV4
2026-06-23 19:00 Portugal vs Uzbekistan SVT
2026-06-23 22:00 England vs Ghana SVT
2026-06-24 01:00 Panama vs Kroatien TV4
2026-06-24 04:00 Colombia vs Kongo-Kinshasa TV4
2026-06-24 21:00 Schweiz vs Kanada TV4
2026-06-24 21:00 Bosnien och Hercegovina vs Qatar TV4
2026-06-25 00:00 Marocko vs Haiti TV4
2026-06-25 00:00 Skottland vs Brasilien TV4
2026-06-25 03:00 Sydafrika vs Sydkorea SVT
2026-06-25 03:00 Tjeckien vs Mexiko SVT
2026-06-25 22:00 Curacao vs Elfenbenskusten SVT
2026-06-25 22:00 Ecuador vs Tyskland SVT
2026-06-26 01:00 Tunisien vs Nederländerna SVT
2026-06-26 01:00 Japan vs Sverige SVT
2026-06-26 04:00 Turkiet vs USA TV4
2026-06-26 04:00 Paraguay vs Australien TV4
2026-06-26 21:00 Norge vs Frankrike TV4
2026-06-26 21:00 Senegal vs Irak TV4
2026-06-27 02:00 Kap Verde vs Saudiarabien TV4
2026-06-27 02:00 Uruguay vs Spanien TV4
2026-06-27 05:00 Nya Zeeland vs Belgien TV4
2026-06-27 05:00 Egypten vs Iran TV4
2026-06-27 23:00 Panama vs England SVT
2026-06-27 23:00 Kroatien vs Ghana SVT
2026-06-28 01:30 Kongo-Kinshasa vs Uzbekistan TV4
2026-06-28 01:30 Colombia vs Portugal TV4
2026-06-28 04:00 Algeriet vs Österrike TV4
2026-06-28 04:00 Jordanien vs Argentina TV4
`;

const expected = {};
const conflicts = [];
const missing = [];

for (const line of USER_SCHEDULE.trim().split("\n")) {
  const m = line.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+?)\s+vs\s+(.+?)\s+(SVT|TV4)$/);
  if (!m) continue;
  const a = SV_TO_EN[m[3].trim()] || m[3].trim();
  const b = SV_TO_EN[m[4].trim()] || m[4].trim();
  const key = keyByPair.get(pairKey(a, b));
  if (!key) {
    missing.push(line);
    continue;
  }
  if (expected[key] && expected[key].ch !== m[5]) {
    conflicts.push({ key, was: expected[key], now: { line, ch: m[5] } });
  }
  expected[key] = { ch: m[5], line, label: `${m[3]} – ${m[4]}`, date: m[1], time: m[2] };
}

const KO_USER = {
  73: "TV4", 74: "SVT", 75: "SVT", 76: "TV4", 77: "TV4", 78: "TV4",
  79: "TV4", 80: "SVT", 81: "TV4", 82: "TV4", 83: "TV4", 84: "SVT",
  85: "TV4", 86: "SVT", 87: "SVT", 88: "TV4",
  89: "SVT", 90: "TV4", 91: "TV4", 92: "SVT", 93: "TV4", 94: "TV4",
  95: "TV4", 96: "SVT", 97: "TV4", 98: "SVT", 99: "TV4", 100: "SVT",
  101: "SVT", 102: "TV4", 103: "SVT", 104: "TV4",
};
for (const [no, ch] of Object.entries(KO_USER)) expected[`k:${no}`] = { ch, label: `M${no}` };

const wrong = [];
for (const [key, exp] of Object.entries(expected)) {
  const cur = current[key];
  if (cur !== exp.ch) {
    wrong.push({
      key,
      teams: keyLabels.get(key) || fixtureTeams(key) || exp.label,
      expected: exp.ch,
      actual: cur || "(saknas)",
      userLine: exp.line || exp.label,
    });
  }
}

const extra = Object.keys(current).filter((k) => !expected[k]);

console.log("=== TV-tablå verifiering ===\n");
console.log(`Förväntade: ${Object.keys(expected).length}`);
console.log(`I data.js:  ${Object.keys(current).length}`);
console.log(`Fel kanal:  ${wrong.length}`);
console.log(`Saknade par: ${missing.length}`);
console.log(`Konflikter: ${conflicts.length}`);
console.log(`Extra nycklar: ${extra.length}`);

if (missing.length) {
  console.log("\n--- Kunde inte mappa lagpar ---");
  missing.forEach((l) => console.log(l));
}
if (wrong.length) {
  console.log("\n--- FEL KANAL ---");
  wrong.forEach((w) => console.log(`${w.key} ${w.teams}: ska ${w.expected}, har ${w.actual} | ${w.userLine || ""}`));
}
if (conflicts.length) {
  console.log("\n--- Dubbelmappning samma nyckel ---");
  conflicts.forEach((c) => console.log(c));
}

// Visa alla gruppmatcher med kanal för manuell granskning
console.log("\n--- Alla gruppmatcher (key → lag → kanal) ---");
for (const L of "ABCDEFGHIJKL") {
  for (let i = 0; i < 6; i++) {
    const key = `g:${L}:${i}`;
    const exp = expected[key];
    const cur = current[key];
    const ok = exp && cur === exp.ch ? "✓" : "!";
    console.log(`${ok} ${key} ${keyLabels.get(key)} → förväntat ${exp?.ch || "?"}, data.js ${cur || "?"}`);
  }
}

process.exit(wrong.length || missing.length ? 1 : 0);
