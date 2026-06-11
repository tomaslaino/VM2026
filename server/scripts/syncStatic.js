import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../config.js";
import { getCallCount } from "../espn.js";
import { RESULTS_FILE, fetchSnapshot, syncDetails, writeResultsFile } from "../espnSync.js";
import { shouldSyncNow } from "../syncSchedule.js";

/*
  Hämtar alla VM-matcher från ESPN:s öppna API (ingen nyckel behövs) och
  skriver en statisk results.json som frontend (GitHub Pages) kan läsa
  direkt – utan att en Node-server behöver vara igång.
  Körs av GitHub Actions (.github/workflows).

  Utdata har samma form som GET /api/results: { meta, results, live, fixtures }.

  Dessutom: data/matchdetails.json med mål/kort/byten/statistik för pågående
  och avslutade matcher. Pågående matcher uppdateras varje synk (live-vy),
  avslutade hämtas en gång och sparas permanent (historik).
*/

function readCachedSnapshot() {
  try {
    if (fs.existsSync(RESULTS_FILE)) {
      return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
    }
  } catch (e) {
    /* ignorera trasig cache */
  }
  return null;
}

export async function syncStatic({ log = console.log, force = false } = {}) {
  const cached = readCachedSnapshot();
  if (!force) {
    const plan = shouldSyncNow(cached);
    if (!plan.sync) {
      log(
        `[espn] Hoppar över synk (${plan.level}, senast ${plan.ageSec}s sedan, ` +
          `väntar ${plan.minSyncGapSec}s).`
      );
      return { skipped: true, reason: plan.level };
    }
    log(`[espn] Synkar nu (${plan.level}) …`);
  } else {
    log("[espn] Tvingad synk …");
  }

  log("[espn] Hämtar matcher från ESPN …");
  const { matches, results, live, fixtures, standings, mapped, skipped } =
    await fetchSnapshot({ log });

  writeResultsFile({ results, live, fixtures, standings, mapped }, getCallCount());

  let detailCount = 0;
  try {
    detailCount = await syncDetails(matches, { log });
  } catch (e) {
    log(`[espn] Kunde inte synka matchdetaljer: ${e.message}`);
  }

  log(
    `[espn] Klart. ${matches.length} matcher från API, ${mapped} resultat, ` +
      `${skipped} utan nyckel, ${live.length} live, ${detailCount} detaljer → ` +
      `${path.relative(ROOT, RESULTS_FILE)}`
  );
  return { total: matches.length, mapped, live: live.length, details: detailCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.env.SYNC_FORCE === "1" || process.argv.includes("--force");
  syncStatic({ force }).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
