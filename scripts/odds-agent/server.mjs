#!/usr/bin/env node
/**
 * HTTP-agent på hemmadatorn – tar emot sync-förfrågningar från GitHub Actions
 * (via Tailscale) eller manuellt:
 *
 *   npm run odds:agent
 *   curl -X POST http://127.0.0.1:9847/sync -H "Authorization: Bearer TOKEN"
 *
 * Miljövariabler:
 *   ODDS_AGENT_TOKEN   – obligatorisk (slumpa ett långt värde)
 *   ODDS_AGENT_PORT    – default 9847
 *   ODDS_AGENT_HOST    – default 127.0.0.1 (sätt 0.0.0.0 bakom Tailscale)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOpenGroupFixtures } from "./fixtures.mjs";
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
  const h = req.headers.authorization || "";
  return h === `Bearer ${TOKEN}`;
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function runSync() {
  const fixtures = loadOpenGroupFixtures();
  if (!fixtures.length) {
    return { ok: true, message: "no_open_fixtures", matches: [], failures: [], data: { matches: [] } };
  }
  const { matches, failures } = await scrapeAll(fixtures);
  const payload = {
    updated: new Date().toISOString(),
    source: "oddschecker.com",
    market: "correct-score",
    agent: "scripts/odds-agent",
    matches,
  };
  if (matches.length) {
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  }
  return {
    ok: matches.length > 0,
    written: matches.length > 0,
    path: OUT,
    matchCount: matches.length,
    failureCount: failures.length,
    failures,
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

    busy = runSync()
      .then((result) => {
        busy = null;
        return result;
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

if (!TOKEN) {
  console.warn("VARNING: sätt ODDS_AGENT_TOKEN innan du exponerar agenten.");
}

server.listen(PORT, HOST, () => {
  console.log(`Odds-agent lyssnar på http://${HOST}:${PORT}`);
  console.log("  GET  /health");
  console.log("  POST /sync  (Authorization: Bearer …)");
});
