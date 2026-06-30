import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import { config, ROOT } from "./config.js";
import * as store from "./store.js";
import * as resultsStore from "./resultsStore.js";
import * as analytics from "./analytics.js";
import { renderStatsPage } from "./statsPage.js";
import { bus } from "./bus.js";
import { getCallCount as getApiFootballCalls } from "./apiFootball.js";
import { getCallCount as getEspnCalls } from "./espn.js";
import { startScheduler } from "./scheduler.js";

store.load();

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- REST ---------- */

app.get("/api/health", (req, res) => {
  const data = store.getData();
  const snap = resultsStore.getSnapshot();
  res.json({
    ok: true,
    source: "espn",
    apiFootball: !config.apiFootballOffline,
    espnCalls: getEspnCalls(),
    apiCalls: getApiFootballCalls(),
    resultsUpdatedAt: snap.meta.updatedAt,
    resultCount: Object.keys(snap.results).length,
    liveCount: snap.live?.length || 0,
    teams: Object.keys(data.teams).length,
    database: !!process.env.DATABASE_URL,
  });
});

/** Synkade matchresultat – frontend läser detta för grupper/slutspel/kalender. */
app.get("/api/results", (req, res) => {
  const snap = resultsStore.getSnapshot();
  res.json({
    meta: snap.meta,
    results: snap.results,
    live: snap.live,
    fixtures: snap.fixtures || {},
    standings: snap.standings || {},
  });
});

app.get("/api/snapshot", (req, res) => {
  const data = store.getData();
  const snap = resultsStore.getSnapshot();
  res.json({
    meta: { ...data.meta, results: snap.meta },
    teams: Object.values(data.teams).map((t) => ({
      id: t.id,
      name: t.name,
      group: t.group,
      logo: t.logo,
      playerCount: (t.players || []).length,
    })),
    live: data.live,
    results: snap.results,
  });
});

app.get("/api/teams", (req, res) => {
  const data = store.getData();
  res.json(
    Object.values(data.teams).map((t) => ({
      id: t.id,
      name: t.name,
      group: t.group,
      logo: t.logo,
      playerCount: (t.players || []).length,
    }))
  );
});

app.get("/api/teams/:idOrName", (req, res) => {
  const data = store.getData();
  const key = req.params.idOrName;
  let team = data.teams[key];
  if (!team) {
    const id = store.teamIdByName(key);
    if (id) team = data.teams[id];
  }
  if (!team) return res.status(404).json({ error: "Lag hittades inte" });
  res.json(team);
});

app.get("/api/players/:id", (req, res) => {
  const data = store.getData();
  const pid = String(req.params.id);
  for (const team of Object.values(data.teams)) {
    const p = (team.players || []).find((x) => String(x.id) === pid);
    if (p) return res.json({ ...p, team: { id: team.id, name: team.name, group: team.group, logo: team.logo } });
  }
  res.status(404).json({ error: "Spelare hittades inte" });
});

app.get("/api/live", (req, res) => {
  const snap = resultsStore.getSnapshot();
  res.json({ fixtures: snap.live, updatedAt: snap.meta.updatedAt });
});

/** Matchdetaljer (mål, kort, byten …) – skrivs av sync-jobbet till data/matchdetails.json. */
app.get("/api/matchdetails", (req, res) => {
  try {
    const file = path.join(ROOT, "data", "matchdetails.json");
    if (fs.existsSync(file)) {
      res.type("application/json").send(fs.readFileSync(file, "utf8"));
      return;
    }
  } catch {
    /* fall igenom till tomt svar */
  }
  res.json({ meta: {}, details: {} });
});

/** Slutspelssannolikheter (bracket_probs.json) – skrivs av prob-jobbet (scripts/prob/). */
app.get("/api/bracketprobs", (req, res) => {
  try {
    const file = path.join(ROOT, "data", "bracket_probs.json");
    if (fs.existsSync(file)) {
      res.type("application/json").send(fs.readFileSync(file, "utf8"));
      return;
    }
  } catch {
    /* fall igenom till tomt svar */
  }
  res.json({ nodes: {}, rounds: {}, slotLabels: {}, groupPositions: {} });
});

/* ---------- Besöksmätning ---------- */

/** Beacon från frontenden vid varje vy-byte. sendBeacon skickar text/plain,
 *  så vi tar emot rå text och tolkar JSON själva. Svarar alltid 204. */
app.post("/api/track", express.text({ type: "*/*", limit: "2kb" }), (req, res) => {
  res.sendStatus(204);
  let body = {};
  try { body = JSON.parse(req.body || "{}"); } catch { /* ignorera trasig body */ }
  analytics.record({
    view: body.view,
    visitor: body.visitor,
    referrer: body.ref,
    ua: req.headers["user-agent"] || "",
    session: body.session,
    duration: body.duration,
    kind: body.kind,
    detail: body.detail,
  });
});

/** Skyddad statistikpanel: /admin/stats?key=<STATS_TOKEN> */
app.get("/admin/stats", async (req, res) => {
  const token = process.env.STATS_TOKEN || "";
  if (!token) {
    return res
      .status(503)
      .type("text/plain; charset=utf-8")
      .send("Sätt miljövariabeln STATS_TOKEN för att aktivera statistikpanelen.");
  }
  const given = String(req.query.key || "");
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).type("text/plain; charset=utf-8").send("Fel eller saknad nyckel.");
  }
  try {
    const s = await analytics.stats();
    res.type("text/html; charset=utf-8").send(renderStatsPage(s));
  } catch (e) {
    console.error("[analytics] kunde inte bygga statistik:", e);
    res.status(500).type("text/plain; charset=utf-8").send("Kunde inte hämta statistik.");
  }
});

app.use(express.static(ROOT));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function pushToClients(msg) {
  const text = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(text);
  }
}

wss.on("connection", (ws) => {
  const snap = resultsStore.getSnapshot();
  ws.send(
    JSON.stringify({
      type: "results:updated",
      payload: {
        results: snap.results,
        live: snap.live,
        fixtures: snap.fixtures || {},
        standings: snap.standings || {},
        meta: snap.meta,
      },
      ts: Date.now(),
    })
  );

  ws.on("message", (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
    } catch {
      /* ignorera */
    }
  });
});

bus.on("broadcast", (msg) => pushToClients(msg));

server.listen(config.port, async () => {
  await resultsStore.load();
  console.log(`\nVM 2026-server kör på http://localhost:${config.port}`);
  console.log(`WebSocket: ws://localhost:${config.port}/ws`);
  console.log("Datakälla: ESPN (öppet API) – resultat synkas automatiskt\n");
  startScheduler();
});

