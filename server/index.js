import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { config, ROOT } from "./config.js";
import * as store from "./store.js";
import * as resultsStore from "./resultsStore.js";
import { bus } from "./bus.js";
import { getCallCount as getApiFootballCalls } from "./apiFootball.js";
import { getCallCount as getEspnCalls } from "./espn.js";
import { startScheduler } from "./scheduler.js";

store.load();

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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

