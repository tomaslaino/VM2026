import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, config } from "../config.js";
import { getMatches, getStandings, getCallCount } from "../footballData.js";
import { mapMatchesToFixtures, mapMatchesToResults, mapStandings } from "../mapResults.js";
import { shouldSyncNow } from "../syncSchedule.js";

/*
  Hämtar alla VM-matcher från football-data.org och skriver en statisk
  results.json som frontend (GitHub Pages) kan läsa direkt – utan att en
  Node-server behöver vara igång. Körs av GitHub Actions (.github/workflows).

  Utdata har samma form som GET /api/results: { meta, results, live, fixtures }.
*/

const OUT_FILE = path.join(ROOT, "data", "results.json");

function readCachedSnapshot() {
  try {
    if (fs.existsSync(OUT_FILE)) {
      return JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
    }
  } catch (e) {
    /* ignorera trasig cache */
  }
  return null;
}

export async function syncStatic({ log = console.log, force = false } = {}) {
  if (config.fdOffline) {
    throw new Error(
      "FOOTBALL_DATA_TOKEN saknas – kan inte hämta resultat. Sätt miljövariabeln och kör igen."
    );
  }

  const cached = readCachedSnapshot();
  if (!force) {
    const plan = shouldSyncNow(cached);
    if (!plan.sync) {
      log(
        `[fd] Hoppar över synk (${plan.level}, senast ${plan.ageSec}s sedan, ` +
          `väntar ${plan.minSyncGapSec}s).`
      );
      return { skipped: true, reason: plan.level };
    }
    log(`[fd] Synkar nu (${plan.level}) …`);
  } else {
    log("[fd] Tvingad synk …");
  }

  log("[fd] Hämtar matcher från football-data …");
  const data = await getMatches();
  const matches = data.matches || [];

  const { results, live, mapped, skipped } = mapMatchesToResults(matches);
  const fixtures = mapMatchesToFixtures(matches);

  let standings = {};
  try {
    log("[fd] Hämtar tabeller från football-data …");
    standings = mapStandings(await getStandings());
  } catch (e) {
    log(`[fd] Kunde inte hämta tabeller: ${e.message}`);
  }

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
    standings,
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
  const force = process.env.SYNC_FORCE === "1" || process.argv.includes("--force");
  syncStatic({ force }).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
