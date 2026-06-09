/**
 * Verifierar att alla API-matcher mappas och att datum/tid stämmer.
 * Kör: node server/scripts/verifyFixtures.js
 */
import { getMatches } from "../footballData.js";
import { mapMatchesToFixtures, utcToSwedish } from "../mapResults.js";
import { groupFixtureIndex, KNOCKOUT, canonicalTeam } from "../wcFixtures.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DATA_JS = path.join(__dir, "../../assets/data.js");

function buildKoSlotMap(fdMatches) {
  const koFd = fdMatches.filter((m) => m.stage && m.stage !== "GROUP_STAGE");
  const byStage = {};
  for (const m of koFd) {
    if (!byStage[m.stage]) byStage[m.stage] = [];
    byStage[m.stage].push(m);
  }
  const slotMap = new Map();
  for (const stage of Object.keys(byStage)) {
    const ours = KNOCKOUT.filter((k) => k.stage === stage).sort((a, b) =>
      a.date.localeCompare(b.date)
    );
    const theirs = byStage[stage].sort((a, b) =>
      String(a.utcDate).localeCompare(String(b.utcDate))
    );
    for (let i = 0; i < Math.min(ours.length, theirs.length); i++) {
      slotMap.set(theirs[i].id, { key: `k:${ours[i].m}`, m: ours[i].m, api: theirs[i] });
    }
  }
  return slotMap;
}

function loadStaticKnockout() {
  const raw = fs.readFileSync(DATA_JS, "utf8");
  const m = raw.match(/knockout:\s*\[([\s\S]*?)\],\s*venues/);
  if (!m) return {};
  const out = {};
  const re = /\{\s*m:\s*(\d+)[^}]*date:\s*"([^"]+)"[^}]*edt:\s*"([^"]+)"/g;
  let hit;
  while ((hit = re.exec(m[1])) !== null) {
    out[hit[1]] = { date: hit[2], edt: hit[3] };
  }
  return out;
}

function loadStaticGroupSchedule() {
  const raw = fs.readFileSync(DATA_JS, "utf8");
  const m = raw.match(/groupSchedule:\s*\{([\s\S]*?)\n\s*\}/);
  if (!m) return {};
  const out = {};
  const re = /"(g:[A-L]:\d+)":\s*\{\s*date:\s*"([^"]+)",\s*time:\s*"([^"]+)"/g;
  let hit;
  while ((hit = re.exec(m[1])) !== null) {
    out[hit[1]] = { date: hit[2], time: hit[3] };
  }
  return out;
}

const data = await getMatches();
const matches = data.matches || [];
const fixtures = mapMatchesToFixtures(matches);
const koMap = buildKoSlotMap(matches);
const staticKo = loadStaticKnockout();
const staticGrp = loadStaticGroupSchedule();
const gIndex = groupFixtureIndex();

let unmapped = [];
let timeMismatch = [];
let staticGrpDiff = [];
let staticKoDiff = [];
let teamMismatch = [];

for (const m of matches) {
  const sw = utcToSwedish(m.utcDate);
  const home = m.homeTeam?.name;
  const away = m.awayTeam?.name;

  if (m.stage === "GROUP_STAGE") {
    if (!home || !away) {
      unmapped.push({ id: m.id, reason: "saknar lag", home, away, utc: m.utcDate });
      continue;
    }
    const allGrp = Object.values(gIndex).flat();
    const key =
      allGrp.find(
        (fx) =>
          canonicalTeam(fx.homeName) === canonicalTeam(home) &&
          canonicalTeam(fx.awayName) === canonicalTeam(away)
      )?.key ||
      allGrp.find(
        (fx) =>
          canonicalTeam(fx.homeName) === canonicalTeam(away) &&
          canonicalTeam(fx.awayName) === canonicalTeam(home)
      )?.key;

    if (!key) {
      unmapped.push({ id: m.id, reason: "ingen nyckel", home, away, utc: m.utcDate });
      continue;
    }
    const fx = fixtures[key];
    if (!fx) {
      unmapped.push({ id: m.id, reason: "saknas i fixtures", key, home, away });
      continue;
    }
    if (fx.date !== sw.date || fx.time !== sw.time) {
      timeMismatch.push({ key, api: sw, mapped: { date: fx.date, time: fx.time }, home, away });
    }
    const st = staticGrp[key];
    if (st && (st.date !== fx.date || st.time !== fx.time)) {
      staticGrpDiff.push({ key, api: fx, static: st, home, away });
    }
  } else {
    const slot = koMap.get(m.id);
    if (!slot) {
      unmapped.push({ id: m.id, stage: m.stage, reason: "ingen ko-slot", utc: m.utcDate });
      continue;
    }
    const fx = fixtures[slot.key];
    if (!fx) {
      unmapped.push({ id: m.id, key: slot.key, reason: "saknas i fixtures" });
      continue;
    }
    if (fx.date !== sw.date || fx.time !== sw.time) {
      timeMismatch.push({ key: slot.key, api: sw, mapped: fx, stage: m.stage });
    }
    const st = staticKo[slot.m];
    if (st && (st.date !== fx.date || st.edt !== fx.time)) {
      staticKoDiff.push({ key: slot.key, m: slot.m, api: fx, static: st, stage: m.stage });
    }
    if (home && fx.home && canonicalTeam(home) !== canonicalTeam(fx.home)) {
      teamMismatch.push({ key: slot.key, field: "home", apiTeam: home, mapped: fx.home });
    }
    if (away && fx.away && canonicalTeam(away) !== canonicalTeam(fx.away)) {
      teamMismatch.push({ key: slot.key, field: "away", apiTeam: away, mapped: fx.away });
    }
  }
}

const expectedKeys = new Set();
for (const letter of Object.keys(gIndex)) {
  for (const fx of gIndex[letter]) expectedKeys.add(fx.key);
}
for (const k of KNOCKOUT) expectedKeys.add(`k:${k.m}`);

const missingKeys = [...expectedKeys].filter((k) => !fixtures[k]);
const extraKeys = Object.keys(fixtures).filter((k) => !expectedKeys.has(k));

console.log("=== API ↔ app-verifiering ===\n");
console.log(`API-matcher:        ${matches.length}`);
console.log(`Mappade fixtures:   ${Object.keys(fixtures).length}`);
console.log(`Förväntade nycklar: ${expectedKeys.size}`);
console.log(`Omappade API:       ${unmapped.length}`);
console.log(`Tid fel i mapping:  ${timeMismatch.length}`);
console.log(`Saknade nycklar:    ${missingKeys.length}`);
console.log(`Extra nycklar:      ${extraKeys.length}`);
console.log(`Statisk grupp ≠ API: ${staticGrpDiff.length} (parsade ${Object.keys(staticGrp).length} från data.js)`);
console.log(`Statisk ko ≠ API:    ${staticKoDiff.length} (parsade ${Object.keys(staticKo).length} från data.js)`);

if (unmapped.length) {
  console.log("\n--- Omappade API-matcher ---");
  unmapped.slice(0, 10).forEach((u) => console.log(u));
}
if (timeMismatch.length) {
  console.log("\n--- Tid stämmer inte (bugg) ---");
  timeMismatch.slice(0, 10).forEach((u) => console.log(u));
}
if (missingKeys.length) {
  console.log("\n--- Nycklar utan API-fixture ---");
  console.log(missingKeys.slice(0, 15));
}
if (staticGrpDiff.length) {
  console.log("\n--- Grupp: statisk data.js skiljer från API (förväntat efter synk) ---");
  staticGrpDiff.slice(0, 8).forEach((d) =>
    console.log(`${d.key} ${d.home}-${d.away}: API ${d.api.date} ${d.api.time} vs data.js ${d.static.date} ${d.static.time}`)
  );
  if (staticGrpDiff.length > 8) console.log(`… och ${staticGrpDiff.length - 8} till`);
}
if (staticKoDiff.length) {
  console.log("\n--- Slutspel: statisk data.js skiljer från API ---");
  staticKoDiff.slice(0, 8).forEach((d) =>
    console.log(`k:${d.m} (${d.stage}): API ${d.api.date} ${d.api.time} vs data.js ${d.static.date} ${d.static.edt}`)
  );
  if (staticKoDiff.length > 8) console.log(`… och ${staticKoDiff.length - 8} till`);
}

const allOk =
  unmapped.length === 0 &&
  timeMismatch.length === 0 &&
  missingKeys.length === 0 &&
  Object.keys(fixtures).length === expectedKeys.size;

console.log(allOk ? "\n✓ Alla matcher stämmer med API-datum/tid." : "\n✗ Det finns avvikelser – se ovan.");
