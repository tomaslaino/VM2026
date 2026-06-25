#!/usr/bin/env node
/**
 * Jämför två results.json – mål/FT för grupp (g:) och slutspel (k:).
 */
import fs from "node:fs";

const FINISHED = new Set(["FINISHED", "FULL_TIME", "FT"]);

/**
 * @param {object} before
 * @param {object} after
 */
export function detectResultChanges(before, after) {
  /** @type {{ key: string, type: "goal"|"ft", phase: "group"|"knockout" }[]} */
  const changes = [];
  const keys = new Set([
    ...Object.keys(before.results || {}),
    ...Object.keys(after.results || {}),
  ]);

  for (const key of keys) {
    if (!key.startsWith("g:") && !key.startsWith("k:")) continue;
    const o = before.results?.[key] || {};
    const n = after.results?.[key] || {};
    const oFin = FINISHED.has(String(o.status || "").toUpperCase());
    const nFin = FINISHED.has(String(n.status || "").toUpperCase());
    const scoreChanged = o.h !== n.h || o.a !== n.a;
    const phase = key.startsWith("k:") ? "knockout" : "group";

    if (nFin && !oFin) changes.push({ key, type: "ft", phase });
    else if (scoreChanged && !nFin) changes.push({ key, type: "goal", phase });
  }
  return changes;
}

if (process.argv[1] && process.argv[1].endsWith("detectResultChanges.mjs")) {
  const before = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const after = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  console.log(JSON.stringify({ changes: detectResultChanges(before, after) }));
}
