#!/usr/bin/env node
/*
  Bygger data/bracket_probs.json med SAMMA motor och SAMMA data som frontend.

  assets/bracketengine.js körs på:
    - data/results.json      (spelade/pågående matcher, samma fil sidan pollar)
    - data/odds.json         (exakt-resultatodds + ev. slutspels-1X2)
    - data/winner_odds.json  (outright-styrkor)
    - data/bracket_map.json  (officiellt träd + Annex C)
  med samma antal simuleringar (40 000) och samma seed som webbläsaren.

  Indata-bygget är en 1:1-portering av bracketBuildInput() i assets/app.js –
  ändras logiken där ska den ändras här. Resultatet: den statiska filen (och
  Renders /api/bracketprobs) kan aldrig visa andra siffror än sidan själv
  räknar fram lokalt.

    node scripts/prob/gen_bracket_probs.mjs

  Ersätter den gamla Python-motorn (vm_sannolikheter.py), som byggde på en
  annan modell (1X2-devig grupper + ren logistisk slutspelsmodell) och därför
  gav andra siffror än sidans lokala beräkning.

  Miljövariabler:
    VM_N_SIMS          antal simuleringar (default 40000 – ändra INTE i det
                       schemalagda jobbet: annat n = andra siffror än sidan)
    VM_BRACKET_OUTPUT  utfil (default data/bracket_probs.json)
    VM_WINNER_ODDS     vinnarodds-fil (default data/winner_odds.json)
*/
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const SIM_N = Number(process.env.VM_N_SIMS || 40000);
const SEED = 0x9e3779b9; // = frontendens seed (app.js) – krävs för identiska siffror
const OUTPUT = process.env.VM_BRACKET_OUTPUT || "data/bracket_probs.json";
const WINNER_ODDS_FILE = process.env.VM_WINNER_ODDS || "data/winner_odds.json";

// Eval:a browser-JS i en sandbox där window === globalThis (som gen_bracket_map.mjs).
function loadGlobals(file) {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox);
  return sandbox;
}
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

const { WC } = loadGlobals("assets/data.js");
const { BracketEngine } = loadGlobals("assets/bracketengine.js");

const payload = readJson("data/results.json");
const oddsRaw = readJson("data/odds.json");
const winnerOdds = readJson(WINNER_ODDS_FILE);
const bracketMap = readJson("data/bracket_map.json");

/* ---------- resultat/live-läge (= sync-lagret + app.js-hjälparna) ---------- */
const resMap = payload.results || {};
const fixtures = payload.fixtures || {};
const liveMap = {};
(payload.live || []).forEach((l) => { if (l && l.key) liveMap[l.key] = l; });

const isLiveStatus = (s) => s === "IN_PLAY" || s === "PAUSED" || s === "LIVE";
function isMatchLive(key) {
  if (liveMap[key]) return true;
  const fx = fixtures[key];
  if (fx && isLiveStatus(fx.status)) return true;
  const r = resMap[key];
  return !!(r && isLiveStatus(r.status));
}
function isFinishedMatch(key) {
  const r = resMap[key];
  if (!r || r.h === undefined || r.a === undefined) return false;
  if (isMatchLive(key)) return false;
  return !isLiveStatus(r.status);
}
// = liveMatchState() i app.js: ställning + andel kvarvarande ordinarie tid.
function liveMatchState(key) {
  if (!isMatchLive(key)) return null;
  const lv = liveMap[key] || {};
  let ch = null, ca = null;
  const rr = resMap[key];
  if (rr && rr.h != null && rr.a != null) { ch = rr.h; ca = rr.a; }
  else { const sc = lv.score || {}; ch = sc.home != null ? sc.home : sc.h; ca = sc.away != null ? sc.away : sc.a; }
  if (ch == null || ca == null) return null;
  const min = typeof lv.minute === "number" ? lv.minute : null;
  const st = String(lv.status || (rr && rr.status) || "").toUpperCase();
  let frac;
  if (st === "PAUSED" || st === "HT" || st === "HALFTIME") frac = 0.5;
  else if (min == null) frac = 0.5;
  else frac = Math.max(0.04, Math.min(1, (90 - min) / 90));
  return { h: ch, a: ca, frac };
}

/* ---------- grupper, FIFA-ranking, fixturer (= app.js) ---------- */
const names = {}, fifa = {};
WC.groupLetters.forEach((L) => {
  names[L] = WC.groups[L].map((t) => t.name);
  fifa[L] = WC.groups[L].map((t) => {
    const r = WC.fifaRank && WC.fifaRank[t.iso];
    return typeof r === "number" ? r : 999;
  });
});

// Rundordningen för gruppmatcher (= RR i app.js): nyckel g:L:idx -> lagindex.
const RR = [[[0, 1], [2, 3]], [[0, 2], [3, 1]], [[3, 0], [1, 2]]];
function groupFixtureList(L) {
  const out = [];
  let idx = 0;
  for (const md of RR) for (const [h, a] of md) out.push({ key: `g:${L}:${idx++}`, h, a });
  return out;
}

/* ---------- odds.json → motorformat (= normalizeOddsJson) ---------- */
const oddsMatches = (oddsRaw.matches || []).map((m) => {
  const inv = m.scores.map((s) => 1 / s.odds);
  const tot = inv.reduce((a, b) => a + b, 0);
  const scores = m.scores.map((s, k) => ({ h: s.h, a: s.a, p: inv[k] / tot }));
  const rp = { 1: 0, X: 0, 2: 0 };
  scores.forEach((s) => { rp[s.h > s.a ? "1" : s.h === s.a ? "X" : "2"] += s.p; });
  const pair = [m.home_idx, m.away_idx].slice().sort((a, b) => a - b).join(",");
  return {
    id: `${m.group}-${m.home_idx}-${m.away_idx}`,
    g: m.group, i: m.home_idx, j: m.away_idx,
    home: m.home, away: m.away, pair, scores, rp,
    oddsContext: m.oddsContext || "prematch",
  };
});
const koScraped = (oddsRaw.knockout || []).map((ko) => {
  const h2h = ko.h2h || {};
  const inv = {
    1: h2h["1"] ? 1 / h2h["1"] : 0,
    X: h2h.X ? 1 / h2h.X : 0,
    2: h2h["2"] ? 1 / h2h["2"] : 0,
  };
  const tot = inv["1"] + inv.X + inv["2"];
  const rp = tot > 0
    ? { 1: inv["1"] / tot, X: inv.X / tot, 2: inv["2"] / tot }
    : { 1: 1 / 3, X: 1 / 3, 2: 1 / 3 };
  return { key: ko.key, rp, oddsContext: ko.oddsContext || "prematch" };
});

/* ---------- styrkor + matchmodell (samma som visningslagret i app.js) ------ */
const strength = BracketEngine.strengthsFromOutrights(winnerOdds.teams);
const ratingMatches = oddsMatches.map((m) => {
  let muH = 0, muA = 0;
  m.scores.forEach((s) => { muH += s.h * s.p; muA += s.a * s.p; });
  return { home: m.home, away: m.away, g: m.g, muH, muA };
});
const matchModel = BracketEngine.buildMatchModel({ ratingMatches, strength, K: 0.6 });

// = koRpFallback i app.js: modellens 90-minuters 1X2, logistisk som nödfall.
function koRpFallback(home, away) {
  const rp = matchModel && matchModel.rp90 ? matchModel.rp90(home, away) : null;
  if (rp) return rp;
  if (!strength || strength[home] == null || strength[away] == null) return null;
  const p1 = 1 / (1 + Math.exp(-0.6 * (strength[home] - strength[away])));
  let px = 0.22;
  let p2 = 1 - p1 - px;
  if (p2 < 0) { px = 0.1; p2 = Math.max(0.02, 1 - p1 - px); }
  return { 1: p1, X: px, 2: p2 };
}

/* ---------- played / oddsGames / neutral (= bracketBuildInput) ------------- */
// Poisson på resterande tid (pre-match) eller villkorad sampling (inplay).
function attachLiveOdds(g, m, live) {
  if (!live) return g;
  const ctx = m.oddsContext || "prematch";
  if (ctx === "inplay") {
    g.live = { h: live.h, a: live.a, mode: "inplay" };
  } else {
    let muH = 0, muA = 0;
    m.scores.forEach((s) => { muH += s.h * s.p; muA += s.a * s.p; });
    g.live = { h: live.h, a: live.a, mode: "prematch", lamH: muH * live.frac, lamA: muA * live.frac };
  }
  return g;
}

const played = [], playedPairs = {}, fxKeyByPair = {};
WC.groupLetters.forEach((L) => {
  playedPairs[L] = {}; fxKeyByPair[L] = {};
  groupFixtureList(L).forEach((fx) => {
    const pair = [fx.h, fx.a].slice().sort((a, b) => a - b).join(",");
    fxKeyByPair[L][pair] = fx.key;
    if (!isFinishedMatch(fx.key)) return;
    const r = resMap[fx.key];
    played.push({ g: L, i: fx.h, j: fx.a, gi: r.h, gj: r.a });
    playedPairs[L][pair] = true;
  });
});

const oddsPairs = {}, oddsGames = [];
oddsMatches.forEach((m) => {
  oddsPairs[m.g] = oddsPairs[m.g] || {}; oddsPairs[m.g][m.pair] = true;
  if (playedPairs[m.g] && playedPairs[m.g][m.pair]) return;
  const fxKey = fxKeyByPair[m.g] && fxKeyByPair[m.g][m.pair];
  const live = fxKey ? liveMatchState(fxKey) : null;
  const g = { id: m.id, g: m.g, i: m.i, j: m.j, scores: m.scores, fixed: null };
  oddsGames.push(attachLiveOdds(g, m, live));
});

const neutral = [];
WC.groupLetters.forEach((L) => {
  groupFixtureList(L).forEach((fx) => {
    if (isFinishedMatch(fx.key)) return;
    const pk = [fx.h, fx.a].slice().sort((a, b) => a - b).join(",");
    if (playedPairs[L][pk] || (oddsPairs[L] && oddsPairs[L][pk])) return;
    neutral.push({ g: L, i: fx.h, j: fx.a });
  });
});

/* ---------- slutspelsmatcher: marknadsodds + facit (= buildKoOddsMap) ------ */
const KO_PLACEHOLDER = /group|third place|winner|loser|\bplace\b/i;
const koTeamKnown = (n) => !!n && !KO_PLACEHOLDER.test(n);
const scrapedByKey = {};
koScraped.forEach((s) => { if (s.key) scrapedByKey[s.key] = s; });

const koOdds = {};
WC.knockout.forEach((mt) => {
  const key = `k:${mt.m}`;
  const fx = fixtures[key];
  const home = fx && koTeamKnown(fx.home) ? fx.home : null;
  const away = fx && koTeamKnown(fx.away) ? fx.away : null;
  if (!home || !away) return;
  const s = scrapedByKey[key];
  const entry = {
    home, away,
    rp: (s && s.rp) || koRpFallback(home, away),
    oddsContext: (s && s.oddsContext) || "prematch",
  };
  const r = resMap[key];
  if (isFinishedMatch(key) && r && r.h != null && r.a != null) {
    entry.finished = true;
    if (r.h !== r.a) entry.winner = r.h > r.a ? home : away;
    else if (r.pw) entry.winner = r.pw === "h" ? home : away;
  }
  const live = liveMatchState(key);
  if (live) entry.live = live;
  koOdds[key] = entry;
});

/* ---------- matchnummer per motor-varv (= buildKoPlayOrders) --------------- */
function buildKoPlayOrders(r32Order) {
  const byNo = {};
  WC.knockout.forEach((m) => { byNo[m.m] = m; });
  function findParent(m1, m2) {
    for (const no in byNo) {
      const m = byNo[no];
      if (m.round === "R32") continue;
      const hm = m.home.t === "wm" ? m.home.m : null;
      const am = m.away.t === "wm" ? m.away.m : null;
      if (hm && am && ((hm === m1 && am === m2) || (hm === m2 && am === m1))) return parseInt(no, 10);
    }
    return null;
  }
  const orders = [null, r32Order.slice()];
  let prev = r32Order.slice();
  for (let r = 0; r < 3; r++) {
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(findParent(prev[i], prev[i + 1]));
    orders.push(next);
    prev = next;
  }
  orders.push([104]);
  return orders;
}

/* ---------- kör motorn ---------- */
const input = {
  n: SIM_N, seed: SEED,
  groups: names, fifa,
  annexC: bracketMap.annexC, annexSlots: bracketMap.annexCSlots,
  order: bracketMap.order, labels: bracketMap.labels,
  strength, K: 0.6, ratingMatches,
  koPlayOrders: buildKoPlayOrders(bracketMap.r32MatchOrder || []),
  koOdds,
  played, oddsGames, neutral,
};

// Felsökning/paritetstest: dumpa motor-indata (ren JSON) i stället för att köra.
if (process.env.VM_DUMP_INPUT) {
  fs.writeFileSync(process.env.VM_DUMP_INPUT, JSON.stringify(input));
  console.log(`Indata-dump -> ${process.env.VM_DUMP_INPUT}`);
  process.exit(0);
}

console.log(`Simulerar ${SIM_N} turneringar (bracketengine.js, seed ${SEED.toString(16)})…`);
console.log(`  ${played.length} spelade gruppmatcher, ${oddsGames.length} odds-matcher, ` +
  `${neutral.length} neutrala, ${Object.keys(koOdds).length} kända slutspelsmatcher`);
const out = BracketEngine.compute(input);
out.note = "Genererad av scripts/prob/gen_bracket_probs.mjs – samma motor (assets/bracketengine.js), data och seed som sidans lokala beräkning.";

const outFile = path.join(ROOT, OUTPUT);
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(`Klart -> ${path.relative(ROOT, outFile)}`);

const top = Object.entries(out.rounds)
  .sort((a, b) => b[1].win - a[1].win)
  .slice(0, 5);
console.log("Topp 5 att vinna VM:");
for (const [t, r] of top) {
  console.log(`  ${t.padEnd(14)} ${(r.win * 100).toFixed(1).padStart(5)} %  ` +
    `(final ${(r.final * 100).toFixed(1)} %, kvart ${(r.qf * 100).toFixed(1)} %)`);
}
