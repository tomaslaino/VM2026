/** Jämför assets/data.js (offline-fallback) med synkade API-fixtures. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Läs synkade fixtures
const resultsPath = path.join(__dir, "../data/results.json");
const { fixtures } = JSON.parse(fs.readFileSync(resultsPath, "utf8"));

// Evaluera data.js minimal – hämta groupSchedule + knockout edt
const dataJs = fs.readFileSync(path.join(__dir, "../../assets/data.js"), "utf8");
const WC = {};
const fn = new Function("WC", "window", dataJs + "\nreturn WC;");
fn(WC, { WC });

const grpDiff = [];
for (const [key, st] of Object.entries(WC.groupSchedule || {})) {
  const api = fixtures[key];
  if (!api) { grpDiff.push({ key, issue: "saknas i API", static: st }); continue; }
  if (st.date !== api.date || st.time !== api.time) {
    grpDiff.push({ key, static: st, api: { date: api.date, time: api.time } });
  }
}

const koDiff = [];
for (const mt of WC.knockout || []) {
  const key = "k:" + mt.m;
  const api = fixtures[key];
  if (!api) { koDiff.push({ key, issue: "saknas i API", static: { date: mt.date, edt: mt.edt } }); continue; }
  if (mt.date !== api.date || mt.edt !== api.time) {
    koDiff.push({ key, static: { date: mt.date, edt: mt.edt }, api: { date: api.date, time: api.time } });
  }
}

console.log("=== data.js (offline) vs API-fixtures ===\n");
console.log(`Gruppmatcher i data.js: ${Object.keys(WC.groupSchedule || {}).length}`);
console.log(`Grupp avvikelser:       ${grpDiff.length}`);
console.log(`Slutspel i data.js:     ${(WC.knockout || []).length}`);
console.log(`Slutspel avvikelser:    ${koDiff.length}`);

if (grpDiff.length) {
  console.log("\n--- Grupp (första 12) ---");
  grpDiff.slice(0, 12).forEach((d) =>
    console.log(`${d.key}: data.js ${d.static?.date} ${d.static?.time} → API ${d.api?.date} ${d.api?.time}`)
  );
}
if (koDiff.length) {
  console.log("\n--- Slutspel (första 12) ---");
  koDiff.slice(0, 12).forEach((d) =>
    console.log(`${d.key}: data.js ${d.static?.date} ${d.static?.edt} → API ${d.api?.date} ${d.api?.time}`)
  );
}
