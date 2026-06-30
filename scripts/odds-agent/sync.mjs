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
import { loadAllOpenFixtures } from "./fixtures.mjs";
import { mergeOddsFile } from "./merge.mjs";
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
  let fixtures = loadAllOpenFixtures();
  if (matchFilter) {
    const q = matchFilter.toLowerCase();
    fixtures = fixtures.filter(
      (f) =>
        `${f.home} vs ${f.away}`.toLowerCase().includes(q) ||
        f.key.toLowerCase().includes(q)
    );
  }

  if (!fixtures.length) {
    console.log("Inga ospelade matcher att hämta odds för.");
    process.exit(0);
  }

  const koN = fixtures.filter((f) => f.phase === "knockout").length;
  console.log(`Hämtar odds för ${fixtures.length} matcher (${koN} slutspel)…`);
  const started = Date.now();
  const { matches, failures } = await scrapeAll(fixtures, {
    onProgress({ i, total, match }) {
      console.log(`  [${i}/${total}] ${match.home} – ${match.away}`);
    },
  });

  const scrapePayload = {
    updated: new Date().toISOString(),
    source: "oddschecker.com",
    market: "correct-score + knockout-h2h",
    agent: "scripts/odds-agent",
    matches,
    failures,
  };

  console.log(`Klart på ${((Date.now() - started) / 1000).toFixed(1)}s: ${matches.length} OK, ${failures.length} misslyckades`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f.home} – ${f.away}: ${f.error}`);
  }

  if (dryRun) {
    console.log(JSON.stringify(scrapePayload, null, 2));
    process.exit(failures.length && !matches.length ? 1 : 0);
  }

  if (!matches.length) {
    console.error("Ingen data hämtad – lämnar odds.json orörd.");
    process.exit(1);
  }

  const merged = mergeOddsFile(
    matches.filter((m) => m.group || String(m.key || "").startsWith("g:")),
    matches.filter((m) => String(m.key || "").startsWith("k:")),
    OUT
  );
  fs.writeFileSync(OUT, JSON.stringify(merged, null, 2) + "\n");
  console.log(`Skrev ${OUT}`);
  process.exit(failures.length ? 2 : 0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
