import { pathToFileURL } from "node:url";
import { getMatches, getCallCount } from "../footballData.js";
import { mapMatchesToFixtures, mapMatchesToResults } from "../mapResults.js";
import * as resultsStore from "../resultsStore.js";
import { broadcast } from "../bus.js";
import { config } from "../config.js";

/*
  Hämtar alla VM-matcher från football-data och mappar till appens
  resultatnycklar. Körs regelbundet av schemaläggaren.
*/

export async function syncFootballData({ log = console.log } = {}) {
  if (config.fdOffline) {
    log("[fd] FOOTBALL_DATA_TOKEN saknas – ingen synk.");
    return { skipped: true };
  }

  await resultsStore.load();
  log("[fd] Hämtar matcher …");

  const data = await getMatches();
  const matches = data.matches || [];
  const { results, live, mapped, skipped } = mapMatchesToResults(matches);
  const fixtures = mapMatchesToFixtures(matches);

  await resultsStore.save({ results, live, fixtures, mapped, fdCalls: getCallCount() });

  broadcast("results:updated", {
    results,
    live,
    fixtures,
    meta: resultsStore.getSnapshot().meta,
  });

  log(`[fd] Klart. ${matches.length} matcher från API, ${mapped} resultat mappade, ${skipped} utan nyckel, ${live.length} live.`);
  return { total: matches.length, mapped, live: live.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncFootballData().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
