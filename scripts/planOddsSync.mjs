#!/usr/bin/env node
/**
 * Planera odds-sync utifrån repository_dispatch-payload.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "data", "results.json");
const FINISHED = new Set(["FINISHED", "FULL_TIME", "FT"]);

function loadResults() {
  return JSON.parse(fs.readFileSync(RESULTS, "utf8"));
}

function slotOf(key, data) {
  const fx = data.fixtures?.[key] || {};
  return fx.utcDate || `${fx.date || ""}T${fx.time || "00:00"}`;
}

/** @param {string[]} ftKeys @param {"group"|"knockout"|null} phaseFilter */
function timeslotReady(ftKeys, data, phaseFilter) {
  const slots = [...new Set(ftKeys.map((k) => slotOf(k, data)))];
  for (const slot of slots) {
    const prefix = phaseFilter === "knockout" ? "k:" : phaseFilter === "group" ? "g:" : null;
    const inSlot = Object.entries(data.fixtures || {})
      .filter(([k]) => {
        if (prefix && !k.startsWith(prefix)) return false;
        if (!prefix && !k.startsWith("g:") && !k.startsWith("k:")) return false;
        return slotOf(k, data) === slot;
      })
      .map(([k]) => k);
    for (const k of inSlot) {
      const r = data.results?.[k] || {};
      const st = String(r.status || data.fixtures?.[k]?.status || "").toUpperCase();
      if (!FINISHED.has(st)) return false;
    }
  }
  return true;
}

function writeOutput(obj) {
  const out = process.env.GITHUB_OUTPUT;
  const line = Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  if (out) fs.appendFileSync(out, line + "\n");
  console.log(line);
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(process.env.CLIENT_PAYLOAD || "{}");
  } catch {
    payload = {};
  }

  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const goals = [...new Set(changes.filter((c) => c.type === "goal").map((c) => c.key))];
  const fts = changes.filter((c) => c.type === "ft");
  const ftKeys = [...new Set(fts.map((c) => c.key))];

  if (!changes.length) {
    writeOutput({ skip: "1", reason: "no_changes" });
    return;
  }

  const data = loadResults();

  if (goals.length) {
    writeOutput({
      skip: "0",
      phase: "goal",
      debounce_sec: "90",
      keys: JSON.stringify(goals),
      background: "0",
      outright: "1",
    });
    return;
  }

  if (ftKeys.length) {
    const koFt = fts.some((c) => c.phase === "knockout" || String(c.key).startsWith("k:"));
    const groupFt = fts.some((c) => c.phase === "group" || String(c.key).startsWith("g:"));

    if (groupFt && !timeslotReady(ftKeys.filter((k) => k.startsWith("g:")), data, "group")) {
      writeOutput({ skip: "1", reason: "group_slot_not_ready" });
      return;
    }
    if (koFt && !timeslotReady(ftKeys.filter((k) => k.startsWith("k:")), data, "knockout")) {
      writeOutput({ skip: "1", reason: "ko_slot_not_ready" });
      return;
    }

    writeOutput({
      skip: "0",
      phase: "ft",
      debounce_sec: "300",
      keys: JSON.stringify([]),
      background: "1",
      outright: "1",
    });
    return;
  }

  writeOutput({ skip: "1", reason: "unknown_change" });
}

main();
