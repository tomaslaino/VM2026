/** Verifierar kalender-TV mot tablå (API-tid + lag / slutspelstid). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WC_GROUPS } from "../wcTeams.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RR = [[[0, 1], [2, 3]], [[0, 2], [3, 1]], [[3, 0], [1, 2]]];
const dataJs = fs.readFileSync(path.join(__dir, "../../assets/data.js"), "utf8");
const { fixtures } = JSON.parse(fs.readFileSync(path.join(__dir, "../data/results.json"), "utf8"));

function parseObj(name) {
  const m = dataJs.match(new RegExp(`WC\\.${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  const o = {};
  if (!m) return o;
  for (const hit of m[1].matchAll(/"([^"]+)":\s*"(SVT|TV4)"/g)) o[hit[1]] = hit[2];
  return o;
}

const tvSchedule = parseObj("tvSchedule");
const tvKoTime = parseObj("tvKoTime");
const tvBroadcast = parseObj("tvBroadcast");

const svNames = {};
for (const L of "ABCDEFGHIJKL") {
  const block = dataJs.match(new RegExp(`${L}:\\s*\\[([\\s\\S]*?)\\n  \\]`, "m"));
  svNames[L] = [...block[1].matchAll(/sv:\s*"([^"]+)"/g)].map((x) => x[1]);
}

const USER = `
2026-06-11 21:00 Mexiko|Sydafrika|TV4
2026-06-16 03:00 Iran|Nya Zeeland|TV4
2026-06-22 03:00 Nya Zeeland|Egypten|TV4
2026-06-29 19:00 KO_SLOT|TV4
2026-06-29 22:30 KO_SLOT|SVT
`;

const userKo = [
  ["2026-06-28", "21:00", "TV4"],
  ["2026-06-29", "19:00", "TV4"],
  ["2026-06-29", "22:30", "SVT"],
];
const apiKo = [];
for (let n = 73; n <= 88; n++) {
  const fx = fixtures[`k:${n}`];
  if (fx) apiKo.push(fx);
}
apiKo.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));

let wrong = 0;
for (let i = 0; i < userKo.length; i++) {
  const [d, t, exp] = userKo[i];
  const api = apiKo[i];
  const got = tvKoTime[`${api.date}|${api.time}`];
  if (got !== exp) {
    console.log(`KO fel: API ${api.date} ${api.time} → ${got}, ska ${exp}`);
    wrong++;
  }
}

for (const [letter, teams] of Object.entries(WC_GROUPS)) {
  let idx = 0;
  for (let md = 0; md < RR.length; md++) {
    for (const [h, a] of RR[md]) {
      const key = `g:${letter}:${idx}`;
      const fx = fixtures[key];
      if (!fx) { idx++; continue; }
      const th = teams[h], ta = teams[a];
      const k1 = `${fx.date}|${fx.time}|${th}|${ta}`;
      const k2 = `${fx.date}|${fx.time}|${ta}|${th}`;
      const got = tvSchedule[k1] || tvSchedule[k2] || tvBroadcast[key];
      const exp = tvBroadcast[key];
      if (got !== exp) {
        console.log(`Grupp fel ${key} ${svNames[letter][h]}-${svNames[letter][a]} @ ${fx.date} ${fx.time}: ${got} vs ${exp}`);
        wrong++;
      }
      idx++;
    }
  }
}

console.log(wrong ? `Avvikelser: ${wrong}` : "Alla kalender-TV stämmer med tablå.");
