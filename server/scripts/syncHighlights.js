/*
  Bygger data/highlights.json: länkar till SVT Play och TV4 Play (hela matchen
  i repris + kort/långt sammandrag) per spelad match.

  Filen skrivs om helt varje körning. Det gör att länkar dyker upp av sig själva
  när klippen publiceras och försvinner när de tas bort eller går ut (klipp som
  inte längre finns i API:erna, eller vars "tillgänglig till" passerat, tas inte
  med). Frontend (assets/matchinfo.js) läser filen och visar länkarna i
  matchmodalen.

  Körs av .github/workflows/sync-highlights.yml. Kan köras manuellt:
    node server/scripts/syncHighlights.js
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPairIndex, keyForIds, loadPlayedFixtures } from "./highlights/match.js";
import { fetchSvtHighlights } from "./highlights/svtPlay.js";
import { fetchTv4Highlights } from "./highlights/tv4Play.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dir, "../../data/highlights.json");

const TYPE_ORDER = ["full", "long", "short"];

function orderTypes(obj) {
  const out = {};
  for (const t of TYPE_ORDER) if (obj[t]) out[t] = obj[t];
  return out;
}

export async function syncHighlights({ log = console.log } = {}) {
  const fixtures = loadPlayedFixtures();
  log(`[highlights] ${fixtures.length} spelade matcher att söka klipp för`);
  if (!fixtures.length) {
    writeFile({}, log);
    return { matches: 0 };
  }

  const pairIndex = buildPairIndex(fixtures);

  const [svt, tv4] = await Promise.all([
    fetchSvtHighlights(fixtures, { log }).catch((e) => {
      log(`[svt] misslyckades: ${e.message}`);
      return {};
    }),
    fetchTv4Highlights((ids) => keyForIds(ids, pairIndex), { log }).catch((e) => {
      log(`[tv4] misslyckades: ${e.message}`);
      return {};
    }),
  ]);

  const byKey = {};
  for (const fx of fixtures) {
    const entry = {};
    if (svt[fx.key]) entry.SVT = orderTypes(svt[fx.key]);
    if (tv4[fx.key]) entry.TV4 = orderTypes(tv4[fx.key]);
    if (Object.keys(entry).length) byKey[fx.key] = entry;
  }

  writeFile(byKey, log);
  return { matches: Object.keys(byKey).length };
}

function writeFile(byKey, log) {
  const payload = {
    meta: { updatedAt: new Date().toISOString(), source: "svt+tv4", matchCount: Object.keys(byKey).length },
    byKey,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n");
  log(`[highlights] skrev ${Object.keys(byKey).length} matcher → ${path.relative(path.join(__dir, "../.."), OUT_FILE)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncHighlights().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
