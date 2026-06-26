/** Bygger WC.tvBroadcast + WC.tvSchedule från användarens TV4/SVT-lista. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WC_GROUPS } from "../wcTeams.js";
import { canonicalTeam } from "../wcFixtures.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RR = [[[0, 1], [2, 3]], [[0, 2], [3, 1]], [[3, 0], [1, 2]]];

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
for (const [letter, teams] of Object.entries(WC_GROUPS)) {
  let idx = 0;
  for (let md = 0; md < RR.length; md++) {
    for (const [h, a] of RR[md]) {
      keyByPair.set(pairKey(teams[h], teams[a]), `g:${letter}:${idx}`);
      idx++;
    }
  }
}

let fixtures = {};
try {
  fixtures = JSON.parse(fs.readFileSync(path.join(__dir, "../data/results.json"), "utf8")).fixtures || {};
} catch { /* */ }

const USER_GROUP = `
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

const KO = [
  ["2026-06-28", "21:00", 73, "TV4"],
  ["2026-06-29", "19:00", 76, "TV4"],
  ["2026-06-29", "22:30", 74, "SVT"],
  ["2026-06-30", "03:00", 75, "SVT"],
  ["2026-06-30", "19:00", 78, "TV4"],
  ["2026-06-30", "23:00", 77, "TV4"],
  ["2026-07-01", "03:00", 79, "TV4"],
  ["2026-07-01", "18:00", 80, "SVT"],
  ["2026-07-01", "22:00", 82, "TV4"],
  ["2026-07-02", "02:00", 81, "TV4"],
  ["2026-07-02", "21:00", 84, "SVT"],
  ["2026-07-03", "01:00", 83, "TV4"],
  ["2026-07-03", "05:00", 85, "TV4"],
  ["2026-07-03", "20:00", 88, "TV4"],
  ["2026-07-04", "00:00", 86, "SVT"],
  ["2026-07-04", "03:30", 87, "SVT"],
  ["2026-07-04", "19:00", 90, "TV4"],
  ["2026-07-04", "23:00", 89, "SVT"],
  ["2026-07-05", "22:00", 91, "TV4"],
  ["2026-07-06", "02:00", 92, "SVT"],
  ["2026-07-06", "21:00", 93, "TV4"],
  ["2026-07-07", "02:00", 94, "TV4"],
  ["2026-07-07", "18:00", 95, "TV4"],
  ["2026-07-07", "22:00", 96, "SVT"],
  ["2026-07-09", "22:00", 97, "TV4"],
  ["2026-07-10", "21:00", 98, "SVT"],
  ["2026-07-11", "23:00", 99, "TV4"],
  ["2026-07-12", "03:00", 100, "SVT"],
  ["2026-07-14", "21:00", 101, "SVT"],
  ["2026-07-15", "21:00", 102, "TV4"],
  ["2026-07-18", "23:00", 103, "SVT"],
  ["2026-07-19", "21:00", 104, "TV4"],
];

const tvBroadcast = {};
const tvSchedule = {};
const tvAirTime = {}; // sändningsstart enligt SVT/TV4-tabla (kan ligga före avspark)
const missing = [];

function schedKey(date, time, a, b) {
  return `${date}|${time}|${canonicalTeam(a)}|${canonicalTeam(b)}`;
}

for (const line of USER_GROUP.trim().split("\n")) {
  const m = line.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+?)\s+vs\s+(.+?)\s+(SVT|TV4)$/);
  if (!m) continue;
  const home = SV_TO_EN[m[3].trim()] || m[3].trim();
  const away = SV_TO_EN[m[4].trim()] || m[4].trim();
  const ch = m[5];
  const key = keyByPair.get(pairKey(home, away));
  if (!key) { missing.push(line); continue; }
  tvBroadcast[key] = ch;
  tvAirTime[key] = `${m[1]}|${m[2]}`;
  const fx = fixtures[key];
  const date = fx?.date || m[1];
  const time = fx?.time || m[2];
  tvSchedule[schedKey(date, time, home, away)] = ch;
  tvSchedule[schedKey(date, time, away, home)] = ch;
}

const tvKoTime = {};
for (const [date, time, no, ch] of KO) {
  tvBroadcast[`k:${no}`] = ch;
  tvAirTime[`k:${no}`] = `${date}|${time}`;
}

// Slutspel: koppla kanal till API:s avsparkstider via kronologisk ordning (TV4-tablå)
const userKo = KO.map(([d, t, no, ch]) => ({ d, t, no, ch, ts: `${d}T${t}` }))
  .sort((a, b) => a.ts.localeCompare(b.ts));
const apiKo = [];
for (let n = 73; n <= 104; n++) {
  const fx = fixtures[`k:${n}`];
  if (fx?.date && fx?.time) {
    apiKo.push({ m: n, date: fx.date, time: fx.time, ts: `${fx.date}T${fx.time}` });
  }
}
apiKo.sort((a, b) => a.ts.localeCompare(b.ts));
for (let i = 0; i < apiKo.length; i++) {
  const ch = userKo[i]?.ch;
  if (!ch) continue;
  tvKoTime[`${apiKo[i].date}|${apiKo[i].time}`] = ch;
}

if (missing.length) {
  console.error("MISSING:", missing);
  process.exit(1);
}

function emitObj(name, obj) {
  const lines = Object.entries(obj)
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([k, v]) => `  "${k}": "${v}"`);
  return `${name} = {\n${lines.join(",\n")}\n};`;
}

console.log("/* AUTO-GENERERAD – kör node server/scripts/buildBroadcastMap.js */");
console.log(emitObj("WC.tvBroadcast", tvBroadcast));
console.log(emitObj("WC.tvSchedule", tvSchedule));
console.log(emitObj("WC.tvKoTime", tvKoTime));
console.log(emitObj("WC.tvAirTime", tvAirTime));
console.error(`OK broadcast=${Object.keys(tvBroadcast).length} schedule=${Object.keys(tvSchedule).length} koTime=${Object.keys(tvKoTime).length} airTime=${Object.keys(tvAirTime).length}`);
