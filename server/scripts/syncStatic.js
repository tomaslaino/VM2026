import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, config } from "../config.js";
import { getMatches, getCallCount } from "../footballData.js";
import { mapMatchesToFixtures, mapMatchesToResults } from "../mapResults.js";

/*
  Hämtar alla VM-matcher från football-data.org och skriver en statisk
  results.json som frontend (GitHub Pages) kan läsa direkt – utan att en
  Node-server behöver vara igång. Körs av GitHub Actions (.github/workflows).

  Utdata har samma form som GET /api/results: { meta, results, live, fixtures }.
*/

const OUT_FILE = path.join(ROOT, "data", "results.json");

export async function syncStatic({ log = console.log } = {}) {
  if (config.fdOffline) {
    throw new Error(
      "FOOTBALL_DATA_TOKEN saknas – kan inte hämta resultat. Sätt miljövariabeln och kör igen."
    );
  }

  log("[fd] Hämtar matcher från football-data …");
  const data = await getMatches();
  const matches = data.matches || [];

  const { results, live, mapped, skipped } = mapMatchesToResults(matches);
  const fixtures = mapMatchesToFixtures(matches);

  const payload = {
    meta: {
      updatedAt: new Date().toISOString(),
      source: "football-data",
      matchCount: mapped,
      liveCount: live.length,
      fdCalls: getCallCount(),
    },
    results,
    live,
    fixtures,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n");

  log(
    `[fd] Klart. ${matches.length} matcher från API, ${mapped} resultat, ` +
      `${skipped} utan nyckel, ${live.length} live → ${path.relative(ROOT, OUT_FILE)}`
  );
  return { total: matches.length, mapped, live: live.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncStatic().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
