/*
  Bygger data/match_reviews.json AUTOMATISKT: "Facit" per SPELAD slutspelsmatch –
  en efteranalys som jämför redaktionens FÖRHANDSPROGNOS (ur news_summaries.json)
  med hur matchen FAKTISKT gick, väger in statistik (matchdetails, FotMob-betyg)
  och färska matchrapporter/reaktioner ur medierna, och avslutar med ett självbetyg
  och 1–3 LÄRDOMAR som matas tillbaka in i kommande förhandsanalyser.

  Pipeline per spelad match:
    1. Läs spelade slutspelsmatcher ur results.json (status FINISHED) som HAR en
       färdig förhandsanalys MED prognos i news_summaries.json (annars finns inget
       att betygsätta – hoppas över).
    2. Betygsätt prognosen DETERMINISTISKT i kod: tolka prognostexten ("2–1 Brasilien",
       "1–1, Marocko på straffar") och jämför vinnare + resultat mot facit ur
       matchdetails.json. Ger verdict { winner: hit|miss, score: hit|miss }.
    3. Samla FÄRSKA referenser efter matchen: lokala medier för båda lagen +
       internationell matchrapport/betygssökning. Dedupas, rankas, översätts.
    4. Språkmodellen (Gemini) skriver {headline, lead, paragraphs, grade, lessons}
       på svenska med fet/kursiv-markörer och [[n]]-källhänvisningar: en efteranalys
       som förklarar VARFÖR prognosen slog in eller inte, med ett självbetyg (0–5)
       och generella lärdomar. Vi renumrerar citaten och skriver ut posten.
    5. data/analysis_lessons.json byggs om ur alla facit (träffsäkerhet + lärdomar)
       och läses av syncNewsSummaries.js för att förbättra framtida prognoser.

  Poster med "manual": true rörs aldrig.

  Miljö: GEMINI_API_KEY (krävs), GEMINI_MODEL (default gemini-2.5-flash).
  Flaggor: --dry-run (skriv prompt, ingen modell/fil), --force, --match k:NN.

  Körs av .github/workflows/sync-match-reviews.yml.
*/
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { TEAMS, translateToSwedish, tightenSummary } from "./syncTeamNews.js";
import {
  sleep, fetchSearch, normTitle, attachBodies, callGemini, isoOf, roundLabel, TEAM_NAMES
} from "./syncNewsSummaries.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dir, "../../data/match_reviews.json");
const LESSONS_FILE = path.join(__dir, "../../data/analysis_lessons.json");
const RESULTS_FILE = path.join(__dir, "../../data/results.json");
const DETAILS_FILE = path.join(__dir, "../../data/matchdetails.json");
const SUMMARIES_FILE = path.join(__dir, "../../data/news_summaries.json");
const FOTMOB_FILE = path.join(__dir, "../../data/fotmob_ratings.json");
const TEAM_NEWS_FILE = path.join(__dir, "../../data/team_news.json");

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.0-flash";
const API_KEY = process.env.GEMINI_API_KEY || "";

const SETTLE_H = 2;            // vänta så länge efter avspark innan facit skrivs (matchen är säkert slut + rapporter hinner komma)
const REVIEW_WINDOW_H = 336;   // sluta aktivt uppdatera facit så här länge efter avspark (14 dygn) om det redan finns
const MAX_REFS = 14;           // tak på referenser per facit
const REF_MAX_AGE_DAYS = 8;    // matchrapporter är färska
const PER_SOURCE_LOCAL = 7;
const PER_SOURCE_MATCH = 6;
const PER_REPORT = 7;
const FETCH_DELAY_MS = 180;
const LESSONS_CAP = 40;        // hur många lärdomar som sparas i korpusen

/* ---------- Läsning ---------- */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/* Spelade slutspelsmatcher med färdig förhandsprognos att betygsätta. */
function finishedMatches(now, summaries) {
  const raw = readJson(RESULTS_FILE, {});
  const fixtures = raw.fixtures || {};
  const results = raw.results || {};
  const out = [];
  for (const [key, fx] of Object.entries(fixtures)) {
    const km = /^k:(\d+)$/.exec(key);
    if (!km) continue;
    if ((fx.status || "").toUpperCase() !== "FINISHED") continue;
    const sum = summaries[key];
    if (!sum || !sum.prediction) continue;                // inget att betygsätta
    const no = parseInt(km[1], 10);
    const koMs = fx.utcDate ? Date.parse(fx.utcDate) : NaN;
    const hoursSinceKo = Number.isFinite(koMs) ? (now - koMs) / 3600000 : 999;
    if (hoursSinceKo < SETTLE_H) continue;                // matchen precis slut – vänta
    const homeIso = isoOf(fx.home) || (sum.teams && sum.teams[0]);
    const awayIso = isoOf(fx.away) || (sum.teams && sum.teams[1]);
    if (!homeIso || !awayIso) continue;
    out.push({
      key, no, koMs, hoursSinceKo, homeIso, awayIso,
      home: TEAM_NAMES[homeIso] || { sv: homeIso, en: homeIso },
      away: TEAM_NAMES[awayIso] || { sv: awayIso, en: awayIso },
      round: roundLabel(no), summary: sum,
      result: results[key] || null
    });
  }
  return out.sort((a, b) => b.koMs - a.koMs);
}

/* ---------- Facit ur matchdetails ---------- */

function actualOutcome(det, result, homeIso, awayIso) {
  const sc = (det && det.score) || {};
  const reg = sc.et || sc.ft || (result ? { h: result.h, a: result.a } : null);
  const h = reg ? reg.h : (result ? result.h : null);
  const a = reg ? reg.a : (result ? result.a : null);
  const viaPens = (det && det.duration === "PENALTY_SHOOTOUT") || !!(sc.pen);
  const viaEt = (det && det.duration === "EXTRA_TIME") || !!(sc.et);
  let winnerIso = null;
  const w = det && det.winner;
  if (w === "HOME_TEAM") winnerIso = homeIso;
  else if (w === "AWAY_TEAM") winnerIso = awayIso;
  else if (h != null && a != null) winnerIso = h > a ? homeIso : (a > h ? awayIso : null);
  // Straffvinnaren ur penalties om winner-fältet saknas.
  if (!winnerIso && viaPens && det && det.penalties && det.score && det.score.pen) {
    winnerIso = det.score.pen.h > det.score.pen.a ? homeIso : awayIso;
  }
  return { h, a, winnerIso, viaPens, viaEt, pen: sc.pen || null };
}

/* Tolka förhandsprognosen ("2–1 Brasilien", "1–1, Marocko på straffar"). */
function parsePrediction(text, match) {
  const raw = String(text || "");
  const m = /(\d{1,2})\s*[–\-—:]\s*(\d{1,2})/.exec(raw);
  const a = m ? parseInt(m[1], 10) : null;
  const b = m ? parseInt(m[2], 10) : null;
  const low = raw.toLowerCase();
  const viaPens = /straff|penalt/.test(low);
  const viaEt = /förläng|extra tid|extra time/.test(low);
  // Vilket lag pekas ut som vinnare? Matcha lagnamn (sv + en).
  const names = (iso) => [match[iso === match.homeIso ? "home" : "away"].sv,
    match[iso === match.homeIso ? "home" : "away"].en].filter(Boolean).map((s) => s.toLowerCase());
  const homeHit = names(match.homeIso).some((n) => low.includes(n));
  const awayHit = names(match.awayIso).some((n) => low.includes(n));
  let winnerIso = null;
  if (homeHit && !awayHit) winnerIso = match.homeIso;
  else if (awayHit && !homeHit) winnerIso = match.awayIso;
  return { a, b, winnerIso, viaPens, viaEt, raw };
}

/* Deterministisk dom: rätt vinnare? rätt resultat? */
function gradePrediction(pred, actual) {
  const verdict = { winner: "na", score: "na" };
  if (pred.winnerIso && actual.winnerIso) {
    verdict.winner = pred.winnerIso === actual.winnerIso ? "hit" : "miss";
  }
  if (pred.a != null && pred.b != null && actual.h != null && actual.a != null) {
    const predDraw = pred.a === pred.b;
    const actDraw = actual.h === actual.a;
    if (predDraw || actDraw) {
      verdict.score = (predDraw && actDraw && pred.a === actual.h &&
        (pred.viaPens ? actual.viaPens : true) && verdict.winner !== "miss") ? "hit" : "miss";
    } else {
      const pw = Math.max(pred.a, pred.b), pl = Math.min(pred.a, pred.b);
      const aw = Math.max(actual.h, actual.a), al = Math.min(actual.h, actual.a);
      verdict.score = (verdict.winner === "hit" && pw === aw && pl === al && !actual.viaPens) ? "hit" : "miss";
    }
  }
  return verdict;
}

/* ---------- FotMob-betyg (topp per lag) ---------- */

function topRatings(fotmob, key, match) {
  const entry = fotmob && fotmob.matches && fotmob.matches[key];
  if (!entry || !entry.players) return null;
  const pick = (side) => Object.entries(entry.players[side] || {})
    .sort((x, y) => y[1] - x[1]).slice(0, 2)
    .map(([name, r]) => `${titleCaseName(name)} ${Number(r).toFixed(1)}`);
  return {
    team: entry.teamRating || null,
    home: pick("h"), away: pick("a"),
    homeName: match.home.sv, awayName: match.away.sv
  };
}
function titleCaseName(s) {
  return String(s).split(" ").map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

/* ---------- Referenser (matchrapporter/reaktioner) ---------- */

async function buildReferences(match, teamNews, prevSv) {
  const cand = [];
  const push = (arr) => { for (const it of arr || []) cand.push(it); };
  const tag = (arr, extra) => (arr || []).map((it) => ({ ...it, ...extra }));

  for (const iso of [match.homeIso, match.awayIso]) {
    const cfg = TEAMS[iso];
    const opp = iso === match.homeIso ? match.away : match.home;
    if (cfg) {
      const lang = cfg.hl.split("-")[0];
      push(tag(await fetchSearch(cfg, lang, PER_SOURCE_LOCAL), { local: true, team: iso }));
      await sleep(FETCH_DELAY_MS);
      const matchCfg = { q: `${cfg.q} (${opp.en} OR ${opp.sv})`, hl: cfg.hl, gl: cfg.gl, ceid: cfg.ceid };
      push(tag(await fetchSearch(matchCfg, lang, PER_SOURCE_MATCH), { local: true, team: iso }));
      await sleep(FETCH_DELAY_MS);
    }
    const tn = teamNews && teamNews[iso];
    if (tn && Array.isArray(tn.items)) push(tag(tn.items, { local: true, team: iso }));
  }
  // Internationell matchrapport/betyg/reaktion.
  const reportQ = `"${match.home.en}" "${match.away.en}" (report OR "player ratings" OR reaction OR verdict OR analysis)`;
  push(tag(await fetchSearch({ q: reportQ, hl: "en-US", gl: "US", ceid: "US:en" }, "en", PER_REPORT), { report: true }));
  await sleep(FETCH_DELAY_MS);

  const now = Date.now();
  const cutoff = match.koMs - 6 * 3600000;   // referenser ska vara från/efter matchdagen
  const byUrl = new Map(), seenTitle = new Set(), refs = [];
  for (const it of cand) {
    if (!it || !it.url || !it.title) continue;
    if (byUrl.has(it.url)) continue;
    const pub = it.published ? Date.parse(it.published) : NaN;
    if (Number.isFinite(pub)) {
      if (pub < cutoff) continue;                              // förhandsartiklar bort
      if ((now - pub) / 86400000 > REF_MAX_AGE_DAYS) continue; // för gammalt
    }
    const nt = normTitle(it.title_sv || it.title);
    if (nt.length > 10 && seenTitle.has(nt)) continue;
    byUrl.set(it.url, true);
    if (nt.length > 10) seenTitle.add(nt);
    refs.push({ ...it });
  }

  for (const it of refs) {
    if (it.title_sv) continue;
    if (it.lang === "sv") { it.title_sv = tightenSummary(it.title); continue; }
    const prev = prevSv.get(it.url);
    if (prev) { it.title_sv = prev; continue; }
    const sv = await translateToSwedish(it.title);
    it.title_sv = sv ? tightenSummary(sv) : it.title;
    await sleep(FETCH_DELAY_MS);
  }

  refs.sort((a, b) => scoreRef(b, match, now) - scoreRef(a, match, now));
  return refs.slice(0, MAX_REFS).map((it) => ({
    source: it.source || null, title: it.title_sv || it.title, url: it.url,
    published: it.published || null, report: !!it.report, local: !!it.local
  }));
}

const REPORT_WORDS = ["report","rating","betyg","reaction","reaktion","verdict","analys","player ratings",
  "mål", "goal", "matchrapport", "recension", "utvärder", "hjälte", "syndabock"];
function scoreRef(it, match, now) {
  let s = 0;
  const pub = it.published ? Date.parse(it.published) : 0;
  if (pub) { const days = (now - pub) / 86400000; s += days < 1 ? 3 : days < 2 ? 2 : days < 4 ? 1 : 0; }
  const low = (it.title_sv || it.title || "").toLowerCase();
  if (it.report) s += 1;
  if (it.local) s += 1;
  for (const w of REPORT_WORDS) if (low.includes(w)) { s += 1; break; }
  return s;
}

function sourceHashOf(refs, actual) {
  const basis = refs.map((r) => r.url).sort().join("\n") +
    "|" + [actual.h, actual.a, actual.viaPens, actual.viaEt, actual.winnerIso].join(",");
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

/* ---------- Prompt + Gemini ---------- */

function scoreLineSv(actual, match) {
  const base = `${actual.h}–${actual.a}`;
  if (actual.viaPens && actual.pen) return `${base} efter full tid, ${actual.pen.h}–${actual.pen.a} på straffar`;
  if (actual.viaEt) return `${base} efter förlängning`;
  return base;
}

function factsBlock(match, det, actual, ratings) {
  const lines = [];
  const winName = actual.winnerIso ? (TEAM_NAMES[actual.winnerIso] || {}).sv : null;
  lines.push(`- Slutresultat: ${scoreLineSv(actual, match)}${winName ? ` (${winName} vidare)` : ""}.`);
  const goalStr = (side, iso) => (det.goals || []).filter((g) => g.team === side)
    .map((g) => `${g.scorer || "?"} ${g.minute || "?"}'${g.type === "PENALTY" ? " (straff)" : g.type === "OWN" ? " (självmål)" : ""}`).join(", ");
  const hg = goalStr("h"), ag = goalStr("a");
  if (hg) lines.push(`- ${match.home.sv} mål: ${hg}.`);
  if (ag) lines.push(`- ${match.away.sv} mål: ${ag}.`);
  const stat = (key) => { const s = (det.stats || []).find((x) => x.key === key); return s ? `${s.h}–${s.a}` : null; };
  const poss = stat("possessionPct"), shots = stat("totalShots"), sot = stat("shotsOnTarget"), corn = stat("wonCorners");
  const sbits = [];
  if (poss) sbits.push(`bollinnehav ${poss}`);
  if (shots) sbits.push(`skott ${shots}`);
  if (sot) sbits.push(`skott på mål ${sot}`);
  if (corn) sbits.push(`hörnor ${corn}`);
  if (sbits.length) lines.push(`- Statistik (${match.home.sv}–${match.away.sv}): ${sbits.join(", ")}.`);
  const reds = (det.bookings || []).filter((b) => b.card === "RED" || b.card === "YELLOW_RED")
    .map((b) => `${b.player || "?"} (${b.minute || "?"}')`);
  if (reds.length) lines.push(`- Utvisningar: ${reds.join(", ")}.`);
  if (ratings) {
    if (ratings.home && ratings.home.length) lines.push(`- FotMob-betyg ${match.home.sv}: ${ratings.home.join(", ")}.`);
    if (ratings.away && ratings.away.length) lines.push(`- FotMob-betyg ${match.away.sv}: ${ratings.away.join(", ")}.`);
  }
  if (det.attendance) lines.push(`- Publik: ${Number(det.attendance).toLocaleString("sv-SE")}.`);
  if (det.referee) lines.push(`- Domare: ${det.referee}.`);
  return lines.join("\n");
}

function verdictSv(verdict) {
  const w = verdict.winner === "hit" ? "RÄTT vinnare" : verdict.winner === "miss" ? "FEL vinnare" : "vinnare ej bedömd";
  const s = verdict.score === "hit" ? "RÄTT slutresultat" : verdict.score === "miss" ? "FEL slutresultat" : "resultat ej bedömt";
  return `${w}, ${s}`;
}

function buildPrompt(match, refs, facts, verdict, pred) {
  const list = refs.map((r, i) => {
    let s = `[${i + 1}]${r.report ? " [RAPPORT]" : ""} (${r.source || "okänd källa"}) ${r.title}`;
    if (r.body) s += `\n    Utdrag: ${r.body}`;
    return s;
  }).join("\n\n") || "(inga externa källor hittades – bygg på fakta nedan)";
  const sum = match.summary;
  return `Du skriver "Facit" EFTER en spelad VM-match 2026: en kort efteranalys som jämför redaktionens FÖRHANDSPROGNOS med hur matchen FAKTISKT gick, förklarar VARFÖR det blev som det blev och drar lärdomar. Skriv på svenska.

MATCH
- ${match.home.sv} mot ${match.away.sv}, ${match.round} i VM 2026.

REDAKTIONENS FÖRHANDSPROGNOS (det vi sa INNAN matchen)
- Prognos: ${pred.raw}${sum.predictionNote ? ` (brasklapp: ${sum.predictionNote})` : ""}
- Förhandsrubrik: ${sum.headline || "–"}
- Huvudtes inför: ${sum.lead || "–"}

FACIT (vad som FAKTISKT hände – dessa fakta är sanna, hitta inte på andra)
${facts}

DETERMINISTISK DOM (redan uträknad – din text och ditt betyg MÅSTE vara förenliga med denna)
- ${verdictSv(verdict)}.

KÄLLOR (matchrapporter, spelarbetyg, reaktioner ur medierna)
${list}

SKRIVKRAV
- Slagkraftig, kort rubrik (headline, REN TEXT). Kort ingress (lead, ~20–30 ord) som slår fast hur väl prognosen höll.
- 2–4 stycken (paragraphs), cirka 180–270 ord TOTALT (lead + paragraphs). Var konkret men stram: koppla utfallet till DET VI SA INNAN – vad vi fick rätt i, vad vi missade, och VARFÖR (avgörande spelare, taktik, avbräck, förhållanden, tur/domslut). Använd fakta och siffror ur FACIT och högst 1–2 korta citat/omdömen ur källorna. Undvik upprepningar och utfyllnad.
- Hitta INTE på fakta, namn, siffror eller citat. Håll dig till FACIT och källorna.
- **fet** för nyckelnamn/avgörande fakta, *kursiv* för citat. Varje påstående ur en källa får en hänvisning direkt efter: [[3]] eller [[2,5]] (max 1–2 per påstående). Fakta ur FACIT behöver ingen hänvisning.
- Ton: initierad, självkritisk där det behövs, inte skrytsam. Erkänn misar öppet.

SJÄLVBETYG (grade)
- "grade.verdict": EN mening som sammanfattar hur bra förhandsprognosen var (t.ex. "Rätt favorit men fel om målskyttarna."). Ren text.
- "grade.score": HELTAL 0–5 för hur bra prognosen var (5 = rätt vinnare och resultat och rätt skäl; 0 = helt fel). MÅSTE stämma med den deterministiska domen: rätt vinnare + rätt resultat ⇒ 4–5; rätt vinnare men fel resultat ⇒ 2–3; fel vinnare ⇒ 0–2.

LÄRDOMAR (lessons) – VIKTIGAST FÖR FRAMTIDEN
- 1–3 KORTA, GENERELLA lärdomar (ren text, en mening var) som kan göra KOMMANDE förhandsanalyser bättre. Formulera dem så de går att tillämpa på andra matcher, inte bara denna (t.ex. "Övervärdera inte hemmalagets höjdfördel när motståndaren redan är höjdvan." eller "Väg in att lag som spelat förlängning i förra matchen ofta startar trött."). Undvik banaliteter.

Svara ENDAST med JSON: {"headline":"...","lead":"...","paragraphs":["...","..."],"grade":{"verdict":"...","score":3},"lessons":["...","..."]}.`;
}

const REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" },
    lead: { type: "STRING" },
    paragraphs: { type: "ARRAY", items: { type: "STRING" } },
    grade: { type: "OBJECT", properties: { verdict: { type: "STRING" }, score: { type: "INTEGER" } }, required: ["verdict", "score"] },
    lessons: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["headline", "lead", "paragraphs", "grade", "lessons"]
};

/* Renumrera citaten till exakt de källor som användes (lead + paragraphs). */
function renumberReview(art, refs) {
  const order = [], map = new Map();
  const remap = (text) => String(text || "").replace(/\[\[\s*([\d\s,]+?)\s*\]\]/g, (mm, nums) => {
    const kept = nums.split(",").map((s) => parseInt(s.trim(), 10))
      .filter((n) => n >= 1 && n <= refs.length)
      .map((n) => { if (!map.has(n)) { order.push(n); map.set(n, order.length); } return map.get(n); });
    return kept.length ? "[[" + kept.join(",") + "]]" : "";
  });
  const lead = remap(art.lead);
  const paragraphs = (art.paragraphs || []).map(remap).filter(Boolean);
  if (!paragraphs.length) return null;
  const references = order.map((old) => refs[old - 1]).map((r) => ({ source: r.source, title: r.title, url: r.url }));
  const plain = (s) => String(s || "").replace(/\[\[[^\]]*\]\]/g, "").replace(/\*+/g, "").replace(/\s+/g, " ").trim();
  const score = Math.max(0, Math.min(5, Math.round(Number(art.grade && art.grade.score))));
  const lessons = (art.lessons || []).map(plain).filter((s) => s.length > 8).slice(0, 3);
  return {
    headline: plain(art.headline),
    lead, paragraphs, references,
    grade: { verdict: plain(art.grade && art.grade.verdict), score: Number.isFinite(score) ? score : null },
    lessons
  };
}

async function callGeminiRetry(matchKey, prompt) {
  const models = [MODEL, FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr = null;
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { return { out: await callGemini(prompt, model, REVIEW_SCHEMA), dead: false }; }
      catch (e) {
        lastErr = e;
        console.warn(`${matchKey}: (${model}) försök ${attempt} misslyckades – ${e.message}`);
        if (e.status === 429) break;
        await sleep(e.status === 503 ? attempt * 4000 : 800);
      }
    }
  }
  return { out: null, dead: lastErr && lastErr.status === 429 };
}

/* ---------- Lärdomskorpus (matas in i förhandsanalyserna) ---------- */

function rebuildLessons(reviews) {
  const entries = Object.entries(reviews).filter(([, r]) => r && !r.hidden);
  let graded = 0, winner = 0, score = 0;
  const lessons = [];
  const seen = new Set();
  entries.sort((a, b) => Date.parse(b[1].written || 0) - Date.parse(a[1].written || 0));
  for (const [key, r] of entries) {
    const v = r.verdict || {};
    if (v.winner === "hit" || v.winner === "miss") { graded++; if (v.winner === "hit") winner++; if (v.score === "hit") score++; }
    for (const text of r.lessons || []) {
      const norm = String(text).toLowerCase().replace(/[^a-zåäö0-9 ]/g, "").replace(/\s+/g, " ").trim();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      lessons.push({ text, match: key, teams: r.teams || null, date: r.written || null });
    }
  }
  return {
    updated: new Date().toISOString(),
    accuracy: { graded, winner, score },
    lessons: lessons.slice(0, LESSONS_CAP)
  };
}

/* ---------- Huvudflöde ---------- */

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const only = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--match" && args[i + 1]) only.push(args[++i]);

  if (!API_KEY && !dryRun) {
    console.log("GEMINI_API_KEY saknas – hoppar över (kör med --dry-run för att testa utan nyckel).");
    return;
  }

  const now = Date.now();
  const summaries = (readJson(SUMMARIES_FILE, { matches: {} }).matches) || {};
  const details = (readJson(DETAILS_FILE, { details: {} }).details) || {};
  const fotmob = readJson(FOTMOB_FILE, { matches: {} });
  const teamNews = (readJson(TEAM_NEWS_FILE, { teams: {} }).teams) || {};
  const file = fs.existsSync(OUT_FILE) ? readJson(OUT_FILE, null) : null;
  const out = file && file.matches ? file : { updated: new Date().toISOString(), note: "Facit per spelad slutspelsmatch (automatgenererat).", accuracy: null, matches: {} };

  const prevSv = new Map();
  for (const e of Object.values(out.matches))
    for (const r of e.references || []) if (r.url && r.title) prevSv.set(r.url, r.title);

  let matches = finishedMatches(now, summaries);
  if (only.length) matches = matches.filter((m) => only.includes(m.key));
  console.log(`${matches.length} spelad(e) match(er) med förhandsprognos att betygsätta.`);

  let wrote = 0, quotaDead = false;
  for (const match of matches) {
    if (quotaDead) break;
    const existing = out.matches[match.key];
    if (existing && existing.manual) { console.log(`${match.key}: manual=true – rörs ej.`); continue; }

    const det = details[match.key] || {};
    const actual = actualOutcome(det, match.result, match.homeIso, match.awayIso);
    if (actual.h == null || actual.a == null) { console.log(`${match.key}: saknar slutresultat – hoppar.`); continue; }
    const pred = parsePrediction(match.summary.prediction, match);
    const verdict = gradePrediction(pred, actual);

    const refs = await buildReferences(match, teamNews, prevSv);
    const hash = sourceHashOf(refs, actual);
    const already = existing && existing.sourceHash === hash;
    const settled = match.hoursSinceKo > REVIEW_WINDOW_H;   // gammalt facit uppdateras inte i onödan
    if (!force && existing && (already || settled)) {
      console.log(`${match.key}: oförändrat facit – hoppar.`); continue;
    }

    const ratings = topRatings(fotmob, match.key, match);
    const facts = factsBlock(match, det, actual, ratings);
    const bodies = refs.length ? await attachBodies(refs) : 0;
    const prompt = buildPrompt(match, refs, facts, verdict, pred);

    if (dryRun) {
      console.log(`\n===== ${match.key} ${match.home.sv}–${match.away.sv} (${refs.length} ref, ${bodies} brödtext) =====`);
      console.log("DOM:", verdictSv(verdict), "| prognos:", pred.raw, "| facit:", scoreLineSv(actual, match));
      console.log(prompt.slice(0, 1600) + "\n... [prompt trunkerad] ...");
      continue;
    }

    const { out: raw, dead } = await callGeminiRetry(match.key, prompt);
    if (dead) quotaDead = true;
    const art = raw && renumberReview(raw, refs);
    if (!art) { console.warn(`${match.key}: kunde inte generera facit – behåller ev. gammalt.`); if (quotaDead) break; continue; }

    out.matches[match.key] = {
      teams: [match.homeIso, match.awayIso],
      headline: art.headline, lead: art.lead, paragraphs: art.paragraphs,
      references: art.references, grade: art.grade, lessons: art.lessons,
      predicted: { text: pred.raw, a: pred.a, b: pred.b, winnerIso: pred.winnerIso, viaPens: pred.viaPens, viaEt: pred.viaEt },
      actual: { h: actual.h, a: actual.a, winnerIso: actual.winnerIso, viaPens: actual.viaPens, viaEt: actual.viaEt, pen: actual.pen },
      verdict,
      written: new Date().toISOString(), sourceHash: hash, generated: true
    };
    wrote++;
    console.log(`${match.key}: skrev facit (${verdictSv(verdict)}; betyg ${art.grade.score}/5; ${art.lessons.length} lärdom(ar)).`);
  }

  // Bygg alltid om träffsäkerhet + lärdomskorpus ur alla facit (även utan nya).
  const lessonsCorpus = rebuildLessons(out.matches);
  out.accuracy = lessonsCorpus.accuracy;

  if (dryRun) return;
  if (wrote) {
    out.updated = new Date().toISOString();
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n");
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessonsCorpus, null, 2) + "\n");
    console.log(`Klart – ${wrote} facit uppdaterade. Träffsäkerhet: rätt vinnare ${out.accuracy.winner}/${out.accuracy.graded}, rätt resultat ${out.accuracy.score}/${out.accuracy.graded}.`);
  } else {
    console.log("Inga nya facit. Uppdaterar bara lärdomskorpusen om den ändrats.");
    if (!fs.existsSync(LESSONS_FILE) || fs.readFileSync(LESSONS_FILE, "utf8") !== JSON.stringify(lessonsCorpus, null, 2) + "\n") {
      fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessonsCorpus, null, 2) + "\n");
    }
  }
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });

export { parsePrediction, gradePrediction, actualOutcome, rebuildLessons };
