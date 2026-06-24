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
import { buildPairIndex, keyForIds, loadLiveFixtures, loadPlayedFixtures } from "./highlights/match.js";
import { fetchSvtHighlights, fetchSvtLive } from "./highlights/svtPlay.js";
import { fetchTv4Highlights } from "./highlights/tv4Play.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dir, "../../data/highlights.json");

const TYPE_ORDER = ["live", "full", "long", "short"];

function orderTypes(obj) {
  const out = {};
  for (const t of TYPE_ORDER) if (obj[t]) out[t] = obj[t];
  return out;
}

export async function syncHighlights({ log = console.log } = {}) {
  const played = loadPlayedFixtures();
  const live = loadLiveFixtures();
  log(`[highlights] ${played.length} spelade matcher (klipp) + ${live.length} pågående/kommande (livesändning)`);
  if (!played.length && !live.length) {
    writeFile({}, log);
    return { matches: 0 };
  }

  // Lagpar → nyckel måste täcka både spelade och pågående/kommande matcher så att
  // TV4:s panelträffar kan mappas oavsett matchstatus.
  const pairIndex = buildPairIndex(played.concat(live));
  const liveKeys = new Set(live.map((fx) => fx.key));

  const [svt, svtLive, tv4] = await Promise.all([
    fetchSvtHighlights(played, { log }).catch((e) => {
      log(`[svt] misslyckades: ${e.message}`);
      return {};
    }),
    fetchSvtLive(live, { log }).catch((e) => {
      log(`[svt] live misslyckades: ${e.message}`);
      return {};
    }),
    fetchTv4Highlights((ids) => keyForIds(ids, pairIndex), liveKeys, { log }).catch((e) => {
      log(`[tv4] misslyckades: ${e.message}`);
      return {};
    }),
  ]);

  const byKey = {};
  const keys = new Set([...Object.keys(svt), ...Object.keys(svtLive), ...Object.keys(tv4)]);
  for (const key of keys) {
    const svtTypes = Object.assign({}, svt[key], svtLive[key]);
    const entry = {};
    if (Object.keys(svtTypes).length) entry.SVT = orderTypes(svtTypes);
    if (tv4[key]) entry.TV4 = orderTypes(tv4[key]);
    if (Object.keys(entry).length) byKey[key] = entry;
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
