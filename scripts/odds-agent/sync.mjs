#!/usr/bin/env node
/**
 * Synka correct-score-odds från oddschecker → data/odds.json
 *
 * Kräver Chrome med remote debugging (se start-chrome.ps1).
 *
 *   npm run odds:sync
 *   npm run odds:sync -- --dry-run
 *   npm run odds:sync -- --match "Czechia vs Mexico"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOpenGroupFixtures } from "./fixtures.mjs";
import { scrapeAll } from "./scrape.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "data", "odds.json");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const matchFilter = (() => {
  const i = process.argv.indexOf("--match");
  return i >= 0 ? process.argv[i + 1] : null;
})();

async function main() {
  let fixtures = loadOpenGroupFixtures();
  if (matchFilter) {
    const q = matchFilter.toLowerCase();
    fixtures = fixtures.filter(
      (f) =>
        `${f.home} vs ${f.away}`.toLowerCase().includes(q) ||
        f.key.toLowerCase().includes(q)
    );
  }

  if (!fixtures.length) {
    console.log("Inga ospelade gruppmatcher att hämta odds för.");
    process.exit(0);
  }

  console.log(`Hämtar correct score för ${fixtures.length} matcher…`);
  const started = Date.now();
  const { matches, failures } = await scrapeAll(fixtures, {
    onProgress({ i, total, match }) {
      console.log(`  [${i}/${total}] ${match.home} – ${match.away}`);
    },
  });

  const payload = {
    updated: new Date().toISOString(),
    source: "oddschecker.com",
    market: "correct-score",
    agent: "scripts/odds-agent",
    matches,
    failures,
  };

  console.log(`Klart på ${((Date.now() - started) / 1000).toFixed(1)}s: ${matches.length} OK, ${failures.length} misslyckades`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f.home} – ${f.away}: ${f.error}`);
  }

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(failures.length && !matches.length ? 1 : 0);
  }

  if (!matches.length) {
    console.error("Ingen data hämtad – lämnar odds.json orörd.");
    process.exit(1);
  }

  fs.writeFileSync(OUT, JSON.stringify({ ...payload, failures: undefined }, null, 2) + "\n");
  console.log(`Skrev ${OUT}`);
  process.exit(failures.length ? 2 : 0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
