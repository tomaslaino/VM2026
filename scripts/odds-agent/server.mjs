#!/usr/bin/env node
/**
 * HTTP-agent – POST /sync med valfri body { keys, background }.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllOpenFixtures, loadFixturesByKeys } from "./fixtures.mjs";
import { mergeOddsFile, mergeScrapeResult } from "./merge.mjs";
import { scrapeAll } from "./scrape.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "data", "odds.json");
const PORT = Number(process.env.ODDS_AGENT_PORT || 9847);
const HOST = process.env.ODDS_AGENT_HOST || "127.0.0.1";
const TOKEN = process.env.ODDS_AGENT_TOKEN || "";

/** @type {Promise<any> | null} */
let busy = null;

function auth(req) {
  if (!TOKEN) return false;
  return (req.headers.authorization || "") === `Bearer ${TOKEN}`;
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

async function scrapeBatch(fixtures, label) {
  if (!fixtures.length) return { scraped: null, failures: [] };
  const scraped = await scrapeAll(fixtures, {
    onProgress({ i, total, match }) {
      console.log(`  [${label} ${i}/${total}] ${match.home} – ${match.away}`);
    },
  });
  const payload = mergeScrapeResult(scraped, OUT);
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  return { scraped, payload };
}

/**
 * @param {{ keys?: string[], background?: boolean }} body
 */
async function runSync(body = {}) {
  const allOpen = loadAllOpenFixtures();
  if (!allOpen.length) {
    const data = mergeOddsFile([], [], OUT);
    return { ok: true, message: "no_open_fixtures", data, failures: [] };
  }

  const wantKeys = Array.isArray(body.keys) ? body.keys.filter(Boolean) : [];
  const doBackground = body.background !== false;

  let priority = wantKeys.length ? loadFixturesByKeys(wantKeys) : [];
  let background = doBackground
    ? allOpen.filter((f) => !priority.some((p) => p.key === f.key))
    : [];

  if (!priority.length && !background.length) {
    priority = allOpen;
    background = [];
  }

  const allFailures = [];
  if (priority.length) {
    const { scraped } = await scrapeBatch(priority, "prio");
    if (scraped) allFailures.push(...scraped.failures);
  }
  if (background.length) {
    const { scraped } = await scrapeBatch(background, "bg");
    if (scraped) allFailures.push(...scraped.failures);
  }

  const payload = mergeOddsFile([], [], OUT);
  const scrapedCount = (payload.matches?.length || 0) + (payload.knockout?.length || 0);

  return {
    ok: scrapedCount > 0 || allFailures.length === 0,
    written: true,
    path: OUT,
    matchCount: payload.matches?.length || 0,
    knockoutCount: payload.knockout?.length || 0,
    failureCount: allFailures.length,
    failures: allFailures,
    priority: priority.map((f) => f.key),
    background: background.map((f) => f.key),
    data: payload,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    return json(res, 200, { ok: true, busy: !!busy });
  }

  if (req.url === "/sync" && req.method === "POST") {
    if (!TOKEN) return json(res, 503, { ok: false, error: "ODDS_AGENT_TOKEN not set" });
    if (!auth(req)) return json(res, 401, { ok: false, error: "unauthorized" });
    if (busy) return json(res, 409, { ok: false, error: "sync_in_progress" });

    const body = await readBody(req);
    busy = runSync(body)
      .then((r) => {
        busy = null;
        return r;
      })
      .catch((e) => {
        busy = null;
        throw e;
      });

    try {
      const result = await busy;
      const code = result.ok ? 200 : result.message === "no_open_fixtures" ? 200 : 502;
      return json(res, code, result);
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message || String(e) });
    }
  }

  json(res, 404, { ok: false, error: "not_found" });
});

if (!TOKEN) console.warn("VARNING: sätt ODDS_AGENT_TOKEN innan du exponerar agenten.");

server.listen(PORT, HOST, () => {
  console.log(`Odds-agent lyssnar på http://${HOST}:${PORT}`);
});
