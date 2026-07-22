/*
  Bygger data/news_summaries.json AUTOMATISKT: "Redaktionens analys" per kommande
  slutspelsmatch – en fyllig svensk analysartikel skriven av en språkmodell UTIFRÅN
  färska källor, som väger samman läget i båda lägren OCH LANDAR I EN KONKRET
  PROGNOS (troligt slutresultat) med argument för den.

  Pipeline per match:
    1. Läs kommande slutspelsmatcher ur data/results.json (fixtures) – bara
       matcher med känd avspark i framtiden, inom ett fönster, och där båda
       lagen är klara (inte "Round of 16 X Winner").
    2. Samla REFERENSER färskt: lokala medier för båda lagen (Google Nyheter-RSS
       per lands utgåva, samma frågor som syncTeamNews) + en internationell
       förhandssökning på "Lag A" "Lag B". Dedupas, åldersfiltreras, rankas på
       relevans + färskhet och översätts till svenska (gratis gtx, ingen nyckel).
       Dessutom byggs ett deterministiskt xG-UNDERLAG per lag ur
       data/fotmob_ratings.json (mål/xG, insläppta/xGA, effektivitet, senaste
       matcherna) som matas in i prompten – så prognosen väger vem som faktiskt
       skapar chanser mot vem som bara gör mer/mindre än chanserna borde ge.
       xG-fingeravtrycket ingår i refsHash så artikeln regenereras när nytt
       xG-underlag landat (t.ex. efter lagets senaste match).
    3. Trappa: ju närmare avspark, desto tätare regenerering. Artikeln skrivs bara
       om när referenserna faktiskt ändrats (refsHash) eller trappans intervall
       löpt ut – annars hoppas matchen över (spar API-anrop).
    4. Språkmodellen (Google Gemini, gratis nivå) skriver {headline, lead,
       paragraphs, prediction, predictionNote} på svenska med markörerna **fet**,
       *kursiv* och [[n]]-källhänvisningar mot de numrerade referenserna. Analysen
       väger samman källorna och avslutas med en argumenterad prognos; prediction
       är det troliga slutresultatet (t.ex. "2–1 Brasilien") och predictionNote en
       kort brasklapp. Vi renumrerar citaten till exakt de källor som faktiskt
       användes och skriver ut posten.

  Poster med "manual": true rörs aldrig (handskrivna behålls).

  Miljö:
    GEMINI_API_KEY   – nyckel från Google AI Studio (gratis nivå). Krävs.
    GEMINI_MODEL     – modell, default "gemini-2.5-flash".

  Flaggor:
    --dry-run        – hämta + ranka referenser och skriv ut prompten, men anropa
                       INTE modellen och skriv INTE filen. Funkar utan nyckel.
    --force          – strunta i trappan/refsHash, regenerera alla i fönstret.
    --match k:NN     – begränsa till en match (kan upprepas).

  Körs av .github/workflows/sync-news-summaries.yml. Manuellt:
    GEMINI_API_KEY=... node server/scripts/syncNewsSummaries.js
    node server/scripts/syncNewsSummaries.js --dry-run --match k:91
*/
import "dotenv/config"; // lokal körning läser GEMINI_API_KEY ur .env; i Actions vinner injicerade secrets
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { TEAMS, parseItems, fetchRss, translateToSwedish, tightenSummary } from "./syncTeamNews.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dir, "../../data/news_summaries.json");
const RESULTS_FILE = path.join(__dir, "../../data/results.json");
const TEAM_NEWS_FILE = path.join(__dir, "../../data/team_news.json");
const STATUS_FILE = path.join(__dir, "../../data/wc2026_player_status.json");
const PLAYERS_FILE = path.join(__dir, "../../data/wc2026_players.json");
// Lärdomskorpus från post-match-facit (syncMatchReviews.js): matas in i prompten
// så prognoserna lär av tidigare träffar/missar. Valfri – saknas den, ingen sektion.
const LESSONS_FILE = path.join(__dir, "../../data/analysis_lessons.json");
// FotMob-xG per spelad match (syncFotmobRatings.js): deterministiskt statistik-
// underlag till prompten. Valfri – saknas den, ingen xG-sektion.
const FOTMOB_FILE = path.join(__dir, "../../data/fotmob_ratings.json");

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
// Reservmodell (egen, separat gratiskvot) om primärmodellen slår i kvottaket (429).
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.0-flash";
const API_KEY = process.env.GEMINI_API_KEY || "";

const GEN_WINDOW_H = 144;     // hur långt före avspark en match börjar få artikel (6 dygn)
const MAX_REFS = 18;          // tak på antal referenser per artikel
const LOCAL_PER_TEAM = 6;     // minst så många hemmakällor per lag garanteras i urvalet
const REF_MAX_AGE_DAYS = 12;  // äldre artiklar tas inte med som referens
const PER_SOURCE_LOCAL = 9;   // träffar per allmän lokal lagsökning (landets media)
const PER_SOURCE_MATCH = 7;   // träffar per lokal sökning som även nämner motståndaren
const PER_PREVIEW = 6;        // träffar ur den internationella förhandssökningen
const PER_CONDITIONS = 4;     // träffar ur sökningen om spelavgörande förhållanden
const FETCH_DELAY_MS = 180;   // paus mellan nätanropen – snällt mot Google
const BODY_MAX_CHARS = 2000;  // hur mycket artikeltext som skickas med per källa
const BODY_TIMEOUT = 12000;   // timeout för att lösa ut + hämta en artikel
const BODY_CONCURRENCY = 4;    // hur många artiklar som hämtas parallellt
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

/* iso → { en (ESPN-namn), sv } för de 48 lagen. Används för namn i prompten och
   för relevansrankning av rubriker. */
const TEAM_NAMES = {"mx":{"en":"Mexico","sv":"Mexiko"},"kr":{"en":"South Korea","sv":"Sydkorea"},"za":{"en":"South Africa","sv":"Sydafrika"},"cz":{"en":"Czechia","sv":"Tjeckien"},"ca":{"en":"Canada","sv":"Kanada"},"ch":{"en":"Switzerland","sv":"Schweiz"},"qa":{"en":"Qatar","sv":"Qatar"},"ba":{"en":"Bosnia-Herzegovina","sv":"Bosnien och Hercegovina"},"br":{"en":"Brazil","sv":"Brasilien"},"ma":{"en":"Morocco","sv":"Marocko"},"gb-sct":{"en":"Scotland","sv":"Skottland"},"ht":{"en":"Haiti","sv":"Haiti"},"us":{"en":"USA","sv":"USA"},"py":{"en":"Paraguay","sv":"Paraguay"},"au":{"en":"Australia","sv":"Australien"},"tr":{"en":"Türkiye","sv":"Turkiet"},"de":{"en":"Germany","sv":"Tyskland"},"ec":{"en":"Ecuador","sv":"Ecuador"},"ci":{"en":"Ivory Coast","sv":"Elfenbenskusten"},"cw":{"en":"Curaçao","sv":"Curaçao"},"nl":{"en":"Netherlands","sv":"Nederländerna"},"jp":{"en":"Japan","sv":"Japan"},"tn":{"en":"Tunisia","sv":"Tunisien"},"se":{"en":"Sweden","sv":"Sverige"},"be":{"en":"Belgium","sv":"Belgien"},"ir":{"en":"Iran","sv":"Iran"},"eg":{"en":"Egypt","sv":"Egypten"},"nz":{"en":"New Zealand","sv":"Nya Zeeland"},"es":{"en":"Spain","sv":"Spanien"},"uy":{"en":"Uruguay","sv":"Uruguay"},"sa":{"en":"Saudi Arabia","sv":"Saudiarabien"},"cv":{"en":"Cape Verde","sv":"Kap Verde"},"fr":{"en":"France","sv":"Frankrike"},"sn":{"en":"Senegal","sv":"Senegal"},"no":{"en":"Norway","sv":"Norge"},"iq":{"en":"Iraq","sv":"Irak"},"ar":{"en":"Argentina","sv":"Argentina"},"at":{"en":"Austria","sv":"Österrike"},"dz":{"en":"Algeria","sv":"Algeriet"},"jo":{"en":"Jordan","sv":"Jordanien"},"pt":{"en":"Portugal","sv":"Portugal"},"co":{"en":"Colombia","sv":"Colombia"},"uz":{"en":"Uzbekistan","sv":"Uzbekistan"},"cd":{"en":"DR Congo","sv":"DR Kongo"},"gb-eng":{"en":"England","sv":"England"},"hr":{"en":"Croatia","sv":"Kroatien"},"pa":{"en":"Panama","sv":"Panama"},"gh":{"en":"Ghana","sv":"Ghana"}};

/* ESPN/fixtures skriver några lag annorlunda än data.js – mappa till samma iso. */
const NAME_TO_ISO = (() => {
  const m = {};
  for (const [iso, n] of Object.entries(TEAM_NAMES)) m[n.en.toLowerCase()] = iso;
  Object.assign(m, {
    "united states": "us", "congo dr": "cd", "dr congo": "cd",
    "korea republic": "kr", "ir iran": "ir", "china pr": null
  });
  return m;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoOf(name) {
  return name ? (NAME_TO_ISO[String(name).toLowerCase().trim()] || null) : null;
}

/* Rondnamn ur matchnumret (k:NN). 73–88 = sextondelsfinal osv. */
function roundLabel(no) {
  if (no >= 73 && no <= 88) return "sextondelsfinal";
  if (no >= 89 && no <= 96) return "åttondelsfinal";
  if (no >= 97 && no <= 100) return "kvartsfinal";
  if (no >= 101 && no <= 102) return "semifinal";
  if (no === 103) return "bronsmatch";
  if (no === 104) return "final";
  return "slutspelsmatch";
}

/* Trappans regenereringsintervall (timmar): så här ofta skrivs artikeln om ÄVEN
   om referenserna står stilla, så texten aldrig blir gammal. Tätare nära avspark. */
function tierIntervalH(hoursToKo) {
  if (hoursToKo > 120) return 24;
  if (hoursToKo > 72) return 12;
  if (hoursToKo > 24) return 6;
  if (hoursToKo > 6) return 2;
  return 0.75;
}

/* Hämtningsspärr (timmar): så här ofta bryr vi oss om att hämta referenser för
   att upptäcka ändringar. Långt bort räcker det gles (snällt mot Google),
   nära avspark hämtar vi ofta så färsk info fångas snabbt. */
function fetchGateH(hoursToKo) {
  if (hoursToKo > 120) return 6;
  if (hoursToKo > 72) return 3;
  if (hoursToKo > 24) return 1.5;
  if (hoursToKo > 6) return 0.75;
  return 0.33;
}

/* Kommande slutspelsmatcher ur results.json (fixtures). */
function upcomingMatches(now) {
  const raw = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
  const fixtures = raw.fixtures || {};
  const out = [];
  for (const [key, fx] of Object.entries(fixtures)) {
    const km = /^k:(\d+)$/.exec(key);
    if (!km) continue;
    const no = parseInt(km[1], 10);
    const koMs = fx.utcDate ? Date.parse(fx.utcDate) : NaN;
    if (!Number.isFinite(koMs)) continue;
    if ((fx.status || "").toUpperCase() === "FINISHED") continue;
    const hoursToKo = (koMs - now) / 3600000;
    if (hoursToKo <= 0 || hoursToKo > GEN_WINDOW_H) continue;   // spelad/pågår eller för långt bort
    const homeIso = isoOf(fx.home), awayIso = isoOf(fx.away);
    if (!homeIso || !awayIso) continue;                        // lag ännu inte klart
    out.push({ key, no, koMs, hoursToKo, homeIso, awayIso,
      home: TEAM_NAMES[homeIso], away: TEAM_NAMES[awayIso],
      round: roundLabel(no) });
  }
  return out.sort((a, b) => a.koMs - b.koMs);
}

/* ---------- Avbräck (skador/avstängningar/osäkra) ---------- */

const AVAIL_SV = { out: "borta", doubtful: "osäker", suspended: "avstängd", injured: "skadad", questionable: "osäker" };

/* Läs spelarstatusen och koppla iso → lagets id-prefix (fifa_code) via
   truppfilen, så vi kan plocka avbräck för just den här matchens två lag. */
function loadAvailability() {
  let statuses = {}, teams = [];
  try { statuses = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")).statuses || {}; } catch { /* valfritt */ }
  try { teams = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8")).teams || []; } catch { /* valfritt */ }
  const svToPrefix = {};
  for (const t of teams) if (t.name_sv && t.fifa_code) svToPrefix[t.name_sv] = t.fifa_code.toLowerCase();
  const isoToPrefix = {};
  for (const [iso, n] of Object.entries(TEAM_NAMES)) if (svToPrefix[n.sv]) isoToPrefix[iso] = svToPrefix[n.sv];
  const byPrefix = {};
  for (const [id, st] of Object.entries(statuses)) {
    const p = id.split("-")[0];
    (byPrefix[p] || (byPrefix[p] = [])).push({ id, ...st });
  }
  return { isoToPrefix, byPrefix };
}

function titleCase(s) {
  return String(s).split(" ").map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

/* Avbräck för matchens två lag som referens-kandidater (hög prioritet, med
   källa så modellen kan citera dem korrekt). */
function availItemsForMatch(match, avail) {
  const out = [];
  for (const iso of [match.homeIso, match.awayIso]) {
    const prefix = avail.isoToPrefix[iso];
    if (!prefix) continue;
    for (const st of avail.byPrefix[prefix] || []) {
      if (!st.source || !st.source.url) continue;
      const name = titleCase(st.id.slice(prefix.length + 1).replace(/-/g, " "));
      const av = AVAIL_SV[st.availability] || st.availability || "osäker";
      const title = `${name} (${TEAM_NAMES[iso].sv}) – ${av}${st.detail ? ": " + st.detail : ""}`;
      out.push({
        source: st.source.name || null,
        title, title_sv: title, lang: "sv",   // redan svenska – ska ej översättas
        url: st.source.url,
        published: st.updated ? st.updated + "T12:00:00Z" : null,
        avail: true, team: iso
      });
    }
  }
  return out;
}

/* Google Nyheter-sök-RSS. cfg = { q, hl, gl, ceid }. */
function searchUrl(cfg) {
  const q = encodeURIComponent(cfg.q + " when:" + REF_MAX_AGE_DAYS + "d");
  return `https://news.google.com/rss/search?q=${q}&hl=${encodeURIComponent(cfg.hl)}` +
    `&gl=${encodeURIComponent(cfg.gl)}&ceid=${encodeURIComponent(cfg.ceid)}`;
}

async function fetchSearch(cfg, lang, limit) {
  try {
    const items = parseItems(await fetchRss(searchUrl(cfg)), lang);
    return items.slice(0, limit);
  } catch {
    return [];
  }
}

function normTitle(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9åäö]+/g, " ").trim();
}

/* ---------- Artikelbrödtext ---------- */

async function fetchTextRaw(url, timeout, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout || BODY_TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow",
      headers: { "User-Agent": BROWSER_UA, ...(init && init.headers) }, ...(init || {}) });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; } finally { clearTimeout(timer); }
}

/* Google Nyheter-länkarna är omdirigeringar. Lös ut den riktiga artikel-URL:en
   via Googles batchexecute (samma flöde som webbläsaren använder). Bäst-möjligt:
   går det inte returneras null och vi faller tillbaka på rubriken. */
async function resolveGoogleNewsUrl(gnUrl) {
  const m = /\/articles\/([^?]+)/.exec(gnUrl || "");
  if (!m) return gnUrl && /^https?:/.test(gnUrl) ? gnUrl : null;   // redan direkt-URL
  const token = m[1];
  const page = await fetchTextRaw("https://news.google.com/rss/articles/" + token, BODY_TIMEOUT);
  if (!page) return null;
  const sg = /data-n-a-sg="([^"]+)"/.exec(page);
  const ts = /data-n-a-ts="([^"]+)"/.exec(page);
  const id = /data-n-a-id="([^"]+)"/.exec(page);
  if (!sg || !ts) return null;
  const inner = JSON.stringify(["garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
      "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    id ? id[1] : token, parseInt(ts[1], 10), sg[1]]);
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner]]]));
  const resp = await fetchTextRaw("https://news.google.com/_/DotsSplashUi/data/batchexecute", BODY_TIMEOUT,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body });
  if (!resp) return null;
  const um = /(https?:\/\/[^\s\\"]+)/.exec(resp.replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\\//g, "/"));
  return um ? um[1] : null;
}

function cleanParagraph(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (x, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

/* Ser stycket ut som riktig brödtext (mening) och inte som en meny/navrad? */
function looksLikeProse(p) {
  if (p.length < 60) return false;
  const words = p.split(/\s+/).filter(Boolean);
  if (words.length < 10) return false;
  if (!/[.!?…]/.test(p)) return false;                       // menyer är sällan meningar
  const letters = (p.match(/[a-zåäöáéíóúñç]/gi) || []).length;
  const upper = (p.match(/[A-ZÅÄÖÁÉÍÓÚÑÇ]/g) || []).length;
  if (letters && upper / letters > 0.3) return false;        // CamelCase-navrader
  if (words.filter((w) => w.length > 25).length / words.length > 0.1) return false; // hopklistrade navord
  return true;
}

/* Plocka läsbar brödtext ur artikel-HTML: rensa bort skript/nav/sidhuvud,
   föredra innehållet i <article> och behåll bara stycken som ser ut som prosa.
   Ger för lite ren text tillbaka → tom sträng (då används rubriken i stället). */
function extractArticleText(html, maxChars) {
  if (!html) return "";
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "").replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "").replace(/<aside[\s\S]*?<\/aside>/gi, "");
  const arts = [...html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]);
  const scope = arts.length ? arts.sort((a, b) => b.length - a.length)[0] : html;
  const ps = [...scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => cleanParagraph(m[1])).filter(looksLikeProse);
  const text = ps.join(" ").replace(/\s+/g, " ").trim();
  if (text.length < 200) return "";
  return text.length > maxChars ? text.slice(0, maxChars) + " …" : text;
}

async function attachBody(ref) {
  try {
    const real = await resolveGoogleNewsUrl(ref.url);
    if (!real) return;
    ref.realUrl = real;
    const text = extractArticleText(await fetchTextRaw(real, BODY_TIMEOUT), BODY_MAX_CHARS);
    if (text && text.length >= 120) ref.body = text;
  } catch { /* tyst – rubriken används i stället */ }
}

/* Hämta brödtext för alla referenser med begränsad parallellism. */
async function attachBodies(refs) {
  let i = 0, ok = 0;
  const worker = async () => { while (i < refs.length) { const j = i++; await attachBody(refs[j]); if (refs[j].body) ok++; } };
  await Promise.all(Array.from({ length: Math.min(BODY_CONCURRENCY, refs.length) }, worker));
  return ok;
}

/* Poäng för en referens: färskhet (0–3) + relevans (lagnamn/nyckelord). */
const RELEVANCE_WORDS = ["lineup","laguppst","startel","injur","skad","avstäng","suspend",
  "doubt","osäker","preview","inför","predict","odds","form","comeback","återvänd","tillbaka",
  "avspark","kickoff","rött kort","red card","ban ","tactic","taktik","h2h","head-to-head",
  // spelavgörande förhållanden räknas som relevant, inte fluff
  "altitude","höjden","höjd över","meters höjd","värme","heat","väder","weather","hemmafördel",
  "home advantage","home-field","pitch","planen"];

/* Innehållslösa listningar (sändningstider, biljetter, kommunala storbilds-
   visningar, damlandslag m.m.) – lokala men utan konkret matchinfo. Straffas
   hårt så att redaktionella texter fyller platserna i stället. */
const JUNK_WORDS = ["hur man tittar","hur man ser","hur du tittar","var man kan se","var du kan se",
  "how to watch","tv-kanal","tv channel","livestream","live stream","spelschema","schema och var",
  "när spelar","när är","vad tid","what time","biljett","ticket","köpa","kommun","ayuntamiento",
  "prefeitura","câmara","instagram","damlag","femenin","women","feminin",
  "pubar","pubs"," pub ","öppet till","öppettider","opening hours"];

function scoreRef(it, match, now) {
  let s = 0;
  if (it.avail) s += 5;                    // avbräck lyfts alltid högt
  if (it.conditions) s += 4;               // spelavgörande förhållanden (höjd/värme/plan) säkras in
  if (it.local) s += 3;                    // ländernas egna medier prioriteras
  const ageH = it.published ? (now - Date.parse(it.published)) / 3600000 : 240;
  if (ageH < 24) s += 3; else if (ageH < 72) s += 2; else if (ageH < 168) s += 1;
  const hay = (normTitle(it.title) + " " + normTitle(it.title_sv || "")) ;
  for (const nm of [match.home.en, match.home.sv, match.away.en, match.away.sv]) {
    if (nm && hay.includes(normTitle(nm))) s += 2;
  }
  const low = (it.title + " " + (it.title_sv || "")).toLowerCase();
  for (const w of RELEVANCE_WORDS) if (low.includes(w)) { s += 1; break; }
  if (/\d/.test(it.title_sv || it.title)) s += 1;   // siffror = konkret (resultat/statistik)
  if (!it.avail) for (const w of JUNK_WORDS) if (low.includes(w)) { s -= 5; break; }
  return s;
}

/* Balanserat urval av de MAX_REFS bästa: garantera att BÅDA lagens hemmamedier
   är representerade (minst LOCAL_PER_TEAM per lag) i stället för att låta det
   mest produktiva/engelskspråkiga landet ta alla platser. Ordning: avbräck,
   förhållanden, hemmakällor per lag, därefter bäst rankade. `scored` ska vara
   sorterad fallande på poäng. */
function selectBalanced(scored, match) {
  const pick = [], used = new Set();
  const take = (it) => { if (it && !used.has(it.url) && pick.length < MAX_REFS) { used.add(it.url); pick.push(it); } };
  scored.filter((x) => x.avail).forEach(take);                       // alla avbräck
  scored.filter((x) => x.conditions).slice(0, 2).forEach(take);     // topp 2 förhållanden
  for (const iso of [match.homeIso, match.awayIso]) {               // minst N hemmakällor per lag
    scored.filter((x) => x.local && x.team === iso).slice(0, LOCAL_PER_TEAM).forEach(take);
  }
  for (const it of scored) take(it);                                // fyll upp med bäst rankade
  return pick;
}

/* Bygg referenslistan för en match: färska lokala + internationella träffar,
   dedupade, rankade, översatta. prevSv = url→svensk rubrik (återanvänds). */
async function buildReferences(match, teamNews, prevSv, availItems) {
  const cand = [];
  const push = (arr) => { for (const it of arr) cand.push(it); };

  const tag = (arr, extra) => (arr || []).map((it) => ({ ...it, ...extra }));

  // Avbräck först – de ska överleva dedup/cap och rankas högt.
  push(availItems || []);

  // Ländernas egna medier för båda lagen (färskt hämtat i respektive lands utgåva).
  for (const iso of [match.homeIso, match.awayIso]) {
    const cfg = TEAMS[iso];
    const opp = iso === match.homeIso ? match.away : match.home;
    if (cfg) {
      const lang = cfg.hl.split("-")[0];
      // 1) Allmän lagnyhet ur landets media (inför en match domineras flödet av matchbevakning).
      push(tag(await fetchSearch(cfg, lang, PER_SOURCE_LOCAL), { local: true, team: iso }));
      await sleep(FETCH_DELAY_MS);
      // 2) Lokal bevakning som specifikt nämner motståndaren – mer matchkonkret.
      const matchCfg = { q: `${cfg.q} (${opp.en} OR ${opp.sv})`, hl: cfg.hl, gl: cfg.gl, ceid: cfg.ceid };
      push(tag(await fetchSearch(matchCfg, lang, PER_SOURCE_MATCH), { local: true, team: iso }));
      await sleep(FETCH_DELAY_MS);
    }
    // Redan översatta lokala nyheter ur team_news.json som extra underlag (även de lokala).
    const tn = teamNews && teamNews[iso];
    if (tn && Array.isArray(tn.items)) push(tag(tn.items, { local: true, team: iso }));
  }
  // Internationell förhandssökning på matchen (H2H/odds som komplement).
  const previewQ = `"${match.home.en}" "${match.away.en}" (World Cup OR Mundial OR "VM")`;
  push(await fetchSearch({ q: previewQ, hl: "en-US", gl: "US", ceid: "US:en" }, "en", PER_PREVIEW));
  await sleep(FETCH_DELAY_MS);
  // Spelavgörande förhållanden (höjd, värme, plan) – säkerställer att sådana
  // källor finns i poolen så artikeln kan väva in dem konkret om de spelar roll.
  const condQ = `"${match.home.en}" "${match.away.en}" (altitude OR "high altitude" OR heat OR weather OR humidity OR pitch OR conditions)`;
  push(tag(await fetchSearch({ q: condQ, hl: "en-US", gl: "US", ceid: "US:en" }, "en", PER_CONDITIONS), { conditions: true }));
  await sleep(FETCH_DELAY_MS);

  // Dedupa på url och på normaliserad rubrik (samma story via flera källor).
  const now = Date.now();
  const byUrl = new Map(), seenTitle = new Set(), refs = [];
  for (const it of cand) {
    if (!it || !it.url || !it.title) continue;
    if (byUrl.has(it.url)) continue;
    const nt = normTitle(it.title_sv || it.title);
    if (nt.length > 10 && seenTitle.has(nt)) continue;
    const ageDays = it.published ? (now - Date.parse(it.published)) / 86400000 : 0;
    if (ageDays > REF_MAX_AGE_DAYS) continue;
    byUrl.set(it.url, true);
    if (nt.length > 10) seenTitle.add(nt);
    refs.push({ ...it });
  }

  // Översätt rubriker som saknar svensk version (återanvänd tidigare översättn.).
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
  return selectBalanced(refs, match).map((it) => ({
    source: it.source || null,
    title: it.title_sv || it.title,
    url: it.url,
    published: it.published || null,
    avail: !!it.avail,
    conditions: !!it.conditions,
    local: !!it.local
  }));
}

function refsHashOf(refs, extra) {
  const basis = refs.map((r) => r.url).sort().join("\n") + (extra ? "|" + extra : "");
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

/* ---------- Prompt + Gemini ---------- */

function koLabelSv(koMs) {
  // Svensk tid (Europe/Stockholm ≈ UTC+2 sommartid). Enkel etikett för prompten.
  const d = new Date(koMs + 2 * 3600000);
  const wd = ["söndag","måndag","tisdag","onsdag","torsdag","fredag","lördag"][d.getUTCDay()];
  const mon = ["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${wd} ${d.getUTCDate()} ${mon}, kl ${hh}:${mm} svensk tid`;
}

/* Nästa fas (för att beskriva vad som står på spel i utslagsspel). */
function nextStageLabel(no) {
  if (no >= 73 && no <= 88) return "åttondelsfinal";
  if (no >= 89 && no <= 96) return "kvartsfinal";
  if (no >= 97 && no <= 100) return "semifinal";
  if (no >= 101 && no <= 102) return "final";
  return null;
}

/* Lärdomar + träffsäkerhet ur tidigare facit (data/analysis_lessons.json). */
function loadLessons() {
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")); } catch { return null; }
}
function lessonsSection(lessons) {
  if (!lessons) return "";
  const items = (lessons.lessons || []).slice(0, 12).map((l) => "- " + (l.text || l)).filter((s) => s.length > 3);
  const acc = lessons.accuracy || {};
  const rate = acc.graded
    ? `Hittills har redaktionens prognoser fått RÄTT VINNARE i ${acc.winner}/${acc.graded} betygsatta matcher och rätt slutresultat i ${acc.score}/${acc.graded}. Kalibrera din självsäkerhet därefter – var djärv men ödmjuk inför osäkerheten.`
    : "";
  if (!items.length && !rate) return "";
  return `\n\nLÄRDOMAR FRÅN TIDIGARE FACIT (redaktionens egna efteranalyser – väg in dessa så du inte upprepar gamla misstag)\n${items.join("\n")}${rate ? "\n" + rate : ""}`;
}

/* ---------- xG-underlag (data/fotmob_ratings.json) ----------

   Deterministisk lagprofil ur alla SPELADE VM-matcher med xG-data: mål och xG
   framåt/bakåt, effektivitet (mål − xG resp. xGA − insläppta) och de senaste
   matcherna match för match. Matas in i prompten som facit-siffror så modellen
   kan väga VEM SOM FAKTISKT SKAPAR CHANSER mot vem som bara över-/under-
   presterar mot sina lägen – utan att hitta på statistik. */

const svNum = (v, dec = 2) => v.toFixed(dec).replace(".", ",");
const svSigned = (v, dec = 2) => (v >= 0 ? "+" : "−") + svNum(Math.abs(v), dec);

function loadXgProfiles() {
  let fixtures = {}, results = {}, fot = {};
  try {
    const raw = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
    fixtures = raw.fixtures || {};
    results = raw.results || {};
  } catch { return null; }
  try { fot = JSON.parse(fs.readFileSync(FOTMOB_FILE, "utf8")).matches || {}; } catch { return null; }

  const rows = [];
  for (const [key, fx] of Object.entries(fixtures)) {
    if ((fx.status || "").toUpperCase() !== "FINISHED") continue;
    const r = results[key];
    const x = fot[key] && fot[key].xg;
    if (!r || r.h == null || r.a == null || !x || x.h == null || x.a == null) continue;
    const hIso = isoOf(fx.home), aIso = isoOf(fx.away);
    if (!hIso || !aIso) continue;
    rows.push({ key, date: fx.utcDate || "", hIso, aIso, r, x });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const prof = {};
  const add = (iso, oppIso, gf, ga, xf, xa) => {
    const p = prof[iso] || (prof[iso] = { n: 0, gf: 0, ga: 0, xg: 0, xga: 0, recent: [] });
    p.n++; p.gf += gf; p.ga += ga; p.xg += xf; p.xga += xa;
    p.recent.push({ oppIso, gf, ga, xf, xa });
  };
  for (const row of rows) {
    add(row.hIso, row.aIso, row.r.h, row.r.a, row.x.h, row.x.a);
    add(row.aIso, row.hIso, row.r.a, row.r.h, row.x.a, row.x.h);
  }
  return prof;
}

function xgTeamLine(iso, p) {
  const name = (TEAM_NAMES[iso] || {}).sv || iso;
  const recent = p.recent.slice(-3).reverse().map((m) => {
    const opp = (TEAM_NAMES[m.oppIso] || {}).sv || m.oppIso;
    return `${m.gf}–${m.ga} mot ${opp} (xG ${svNum(m.xf)}–${svNum(m.xa)})`;
  }).join(", ");
  return `- ${name} (${p.n} VM-matcher): ${p.gf} mål på ${svNum(p.xg)} xG (${svSigned(p.gf - p.xg)} mot förväntat), ` +
    `${p.ga} insläppta på ${svNum(p.xga)} xGA (${svSigned(p.xga - p.ga)} = försvar/målvakt mot förväntat). ` +
    `Senaste: ${recent}.`;
}

function xgSection(match, prof) {
  const h = prof && prof[match.homeIso];
  const a = prof && prof[match.awayIso];
  if (!h && !a) return "";
  const lines = [h && xgTeamLine(match.homeIso, h), a && xgTeamLine(match.awayIso, a)].filter(Boolean);
  return `\n\nSTATISTISKT UNDERLAG – xG I TURNERINGEN (Opta via FotMob; redaktionens egna facit-siffror – hitta inte på andra)
${lines.join("\n")}
Tolkning: xG mäter chansernas kvalitet. Mål − xG över noll = laget gör mer än chanserna borde ge (kliniska avslut – eller tur som tenderar att falla tillbaka, avgör själv utifrån källorna); under noll = skapar mer än det får betalt för och kan vara bättre än resultaten antyder. xGA − insläppta över noll = försvar/målvakt räddar mer än väntat. Väg in vad xG:t säger om det verkliga styrkeförhållandet i din prognos och referera gärna siffrorna i texten – de behöver INGEN källhänvisning (redaktionens egna data).`;
}

/* Kompakt xG-fingeravtryck för refsHash: ändras när nytt xG-underlag landat. */
function xgFingerprint(match, prof) {
  const f = (p) => (p ? `${p.n}:${p.xg.toFixed(2)}:${p.xga.toFixed(2)}` : "0");
  return `xg:${f(prof && prof[match.homeIso])}|${f(prof && prof[match.awayIso])}`;
}

function buildPrompt(match, refs, lessons, xg) {
  const list = refs.map((r, i) => {
    let s = `[${i + 1}]${r.avail ? " [AVBRÄCK]" : ""}${r.conditions ? " [FÖRHÅLLANDEN]" : ""} (${r.source || "okänd källa"}) ${r.title}`;
    if (r.body) s += `\n    Utdrag: ${r.body}`;
    return s;
  }).join("\n\n");
  const next = nextStageLabel(match.no);
  const stakes = next
    ? `Utslagsspel: vinnaren går vidare till ${next}, förloraren är utslagen. Oavgjort efter full tid avgörs i förlängning och eventuellt straffar.`
    : `Utslagsspel: oavgjort efter full tid avgörs i förlängning och eventuellt straffar.`;
  return `Du skriver "Redaktionens analys" inför en VM-match: en fyllig, källbelagd analysartikel som väger samman läget i båda lägren och SLUTAR MED EN KONKRET PROGNOS (troligt slutresultat) som du argumenterar för. Skriv på svenska.

MATCH
- Lag A: ${match.home.sv}
- Lag B: ${match.away.sv}
- Datum och tid: ${koLabelSv(match.koMs)}
- Fas: ${match.round} i fotbolls-VM 2026
- Betydelse: ${stakes}

UNDERLAG
Allt du skriver ska bygga på de numrerade källorna nedan (ur ländernas egna och internationella medier). Under de flesta källor finns ett "Utdrag" ur själva artikeltexten – det kan vara på originalspråk (spanska, arabiska, portugisiska ...); läs det och återge på svenska. Hämta konkreta detaljer, citat och siffror ur utdragen, inte bara ur rubrikerna. [AVBRÄCK] = bekräftad skada/avstängning/osäker spelare. [FÖRHÅLLANDEN] = spelavgörande omständigheter (höjd, värme, plan m.m.).

Leta i källorna efter de faktorer som faktiskt betyder något för just den här matchen – exempel på dimensioner:
- Spel & status: trolig laguppställning/formation, skador, avstängningar, form, vila/slitage, förlängning i förra matchen.
- Taktik: nyckeldueller, presspel, omställningar, fasta situationer, en möjlig planändring.
- Yttre faktorer: höjd, väder, plan, hemmapublik, resande, domarprofil.
- Narrativ: press på lagen, tränar-/spelarcitat, inbördes historik, rivalitet, interna problem.
- Statistik: form, mål/xG, försvarsdata, oddsläge/favoritskap – ur källorna OCH ur det statistiska xG-underlaget nedan.${xg || ""}${lessonsSection(lessons)}

SKRIVKRAV (ARTIKELN)
- Slagkraftig rubrik (headline, REN TEXT utan markörer eller källhänvisningar) och en ingress (lead, cirka 35–50 ord) som slår an artikelns huvudtes och antyder slutsatsen.
- Prioritera stenhårt den information som mest avgör slutresultatet: väg in flera källor och perspektiv, men bara det som faktiskt påverkar utgången, och förklara VARFÖR var och en spelar roll. Analys, inte uppräkning – välj bort det perifera.
- Var konkret: namn, siffror, exakta lägen, citat. Undvik generiska fraser och floskler ("allt står på spel", "stämningen är på topp", "en match att minnas", retoriska slutfrågor).
- Hitta INTE på fakta, namn, siffror eller citat. Saknas en uppgift i källorna – hoppa hellre över den än att spekulera.
- Ren logistik utan betydelse för spelet (TV-kanal, biljetter, öppettider) hör inte hit.
- Bygg brett på LÄNDERNAS EGNA MEDIER och ge BÅDA lagens hemmaperspektiv – vad skrivs i respektive lands press om det egna laget (laguppställning, skadeläge, tränar-/spelarcitat, stämning, förväntan). Väv ihop hemmakällor från båda länderna och komplettera med internationella källor.
- Ton: initierad, lite spetsig, journalistisk men inte överdriven. Målgrupp: fotbollsintresserade svenska VM-följare.
- Längd: cirka 315–390 ord totalt (ingress + paragraphs), fördelat på 4–5 stycken (paragraphs) – håll det stramt och tätt. De 1–2 SISTA styckena ska knyta ihop analysen och bygga argumentet för din prognos (favoritskap, avbräck, form, taktisk matchbild, yttre förhållanden – väg för och emot). VIKTIGT: ta bara med de faktorer som mest avgör slutresultatet och skär bort resten – varje mening ska tillföra konkret information; hellre färre, tätare poänger än utfyllnad, upprepning eller floskler för att fylla ut.

PROGNOS (avslut) – DETTA ÄR HALVA POÄNGEN, HOPPA INTE ÖVER DET
- Redan i ingressen (lead) ska du antyda din slutsats, och det ALLRA SISTA stycket ska vara en tydlig "Slutsats:" som uttryckligen säger VEM DU TROR VINNER (eller att det går till förlängning/straffar), MED VILKET RESULTAT, och pekar ut den/de avgörande faktorerna. Väg för och emot först, men landa sedan bestämt – vela inte, gardera dig inte.
- "prediction": ditt troliga SLUTRESULTAT, KORT och KONKRET. Nästan alltid med siffror och lagnamn, t.ex. "2–1 Brasilien" eller "1–1, Marocko på straffar". Skriv laget vid namn, inte "Lag A". REN TEXT utan markörer/källhänvisningar. Fältet får ALDRIG vara tomt.
- "predictionNote": EN mening som fångar den största osäkerheten/brasklappen (t.ex. vad som skulle kunna kullkasta prognosen). Ren text. Får vara tom sträng om ingen tydlig sådan finns.
- Prognosen (prediction) ska följa logiskt av argumenten i de sista styckena – siffrorna i prediction ska stämma med det du beskriver i slutsatsen.

KÄLLHANTERING
- Varje påstående som bygger på en källa ska ha en hänvisning direkt efter: [[3]] eller [[2,5]] (max 1–2 källor per påstående). Citaten gäller ARTIKELTEXTEN (lead + paragraphs), inte prediction/predictionNote.
- **fet** för nyckelnamn och avgörande fakta, *kursiv* för direkta citat och smeknamn.
- Använd bara källnummer som finns i listan; du måste inte använda alla, men använd gärna MÅNGA olika källor.

Svara ENDAST med JSON: {"headline": "...", "lead": "...", "paragraphs": ["...","..."], "prediction": "...", "predictionNote": "..."}.

Källor:
${list}`;
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" },
    lead: { type: "STRING" },
    paragraphs: { type: "ARRAY", items: { type: "STRING" } },
    prediction: { type: "STRING" },
    predictionNote: { type: "STRING" }
  },
  required: ["headline", "lead", "paragraphs", "prediction"]
};

async function callGemini(prompt, model, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.45,
      responseMimeType: "application/json",
      responseSchema: schema || RESPONSE_SCHEMA
    }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = new Error("Gemini HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) throw new Error("Gemini gav tomt svar");
  return JSON.parse(text);
}

/* Renumrera citaten till exakt de källor som faktiskt användes, i den ordning de
   först dyker upp. Släpper ogiltiga nummer och oanvända källor. Returnerar
   { lead, paragraphs, references } eller null om inga giltiga citat fanns. */
function renumberCitations(art, refs) {
  const order = [];
  const map = new Map();
  const remap = (text) => String(text || "").replace(/\[\[\s*([\d\s,]+?)\s*\]\]/g, (m, nums) => {
    const kept = nums.split(",").map((s) => parseInt(s.trim(), 10))
      .filter((n) => n >= 1 && n <= refs.length)
      .map((n) => {
        if (!map.has(n)) { order.push(n); map.set(n, order.length); }
        return map.get(n);
      });
    return kept.length ? "[[" + kept.join(",") + "]]" : "";
  });
  const lead = remap(art.lead);
  const paragraphs = (art.paragraphs || []).map(remap);
  if (!order.length) return null;
  const references = order.map((old) => refs[old - 1]).map((r) => ({
    source: r.source, title: r.title, url: r.url
  }));
  // Rubriken renderas som ren text – rensa ev. markörer/citat modellen råkat lägga in.
  const headline = String(art.headline || "")
    .replace(/\[\[[^\]]*\]\]/g, "").replace(/\*+/g, "").replace(/\s+/g, " ").trim();
  // Prognosen är redaktionens slutsats, inte en refererad rad – ren text.
  const plain = (s) => String(s || "").replace(/\[\[[^\]]*\]\]/g, "").replace(/\*+/g, "").replace(/\s+/g, " ").trim();
  const prediction = plain(art.prediction);
  const predictionNote = plain(art.predictionNote);
  if (!prediction) return null;
  return { headline, lead, paragraphs, references, prediction, predictionNote };
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
  const file = fs.existsSync(OUT_FILE)
    ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8"))
    : { updated: new Date().toISOString(), note: "", matches: {} };
  if (!file.matches) file.matches = {};
  const teamNews = fs.existsSync(TEAM_NEWS_FILE)
    ? (JSON.parse(fs.readFileSync(TEAM_NEWS_FILE, "utf8")).teams || {}) : {};
  const avail = loadAvailability();
  const lessons = loadLessons();   // lärdomar/träffsäkerhet ur tidigare facit (valfritt)
  const xgProfiles = loadXgProfiles(); // xG-lagprofiler ur fotmob_ratings (valfritt)

  // url→svensk rubrik ur tidigare referenser (spar översättningsanrop).
  const prevSv = new Map();
  for (const e of Object.values(file.matches))
    for (const r of e.references || []) if (r.url && r.title) prevSv.set(r.url, r.title);

  let matches = upcomingMatches(now);
  if (only.length) matches = matches.filter((m) => only.includes(m.key));
  console.log(`${matches.length} kommande match(er) i fönstret (${GEN_WINDOW_H} h).`);

  // Primär- + reservmodell (egen, separat gratiskvot vid 429). Ett anrop per match.
  const models = [MODEL, FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
  let quotaDead = false;

  // Kör prompten mot modellerna med retry/fallback. 503 = tillfälligt
  // överbelastad → backa av; 429 = kvot slut → byt modell, och är båda slut
  // sätts quotaDead så resten av körningen avbryts.
  async function generate(matchKey, prompt, schema) {
    let out = null, lastErr = null;
    for (const model of models) {
      for (let attempt = 1; attempt <= 2 && !out; attempt++) {
        try { out = await callGemini(prompt, model, schema); }
        catch (e) {
          lastErr = e;
          console.warn(`${matchKey}: (${model}) försök ${attempt} misslyckades – ${e.message}`);
          if (e.status === 429) break;
          await sleep(e.status === 503 ? attempt * 4000 : 800);
        }
      }
      if (out) break;
    }
    if (!out && lastErr && lastErr.status === 429) quotaDead = true;
    return out;
  }

  let wrote = 0;
  for (const match of matches) {
    if (quotaDead) break;
    const existing = file.matches[match.key];
    if (existing && existing.manual) { console.log(`${match.key}: manual=true – rörs ej.`); continue; }

    const writtenMs = existing?.written ? Date.parse(existing.written) : 0;
    if (!force && writtenMs && now - writtenMs < fetchGateH(match.hoursToKo) * 3600000) {
      console.log(`${match.key}: hämtade nyligen – väntar (${match.hoursToKo.toFixed(0)} h kvar).`); continue;
    }

    const refs = await buildReferences(match, teamNews, prevSv, availItemsForMatch(match, avail));
    if (refs.length < 3) { console.log(`${match.key}: för få referenser (${refs.length}).`); continue; }
    const hash = refsHashOf(refs, xgFingerprint(match, xgProfiles));
    const tierMs = tierIntervalH(match.hoursToKo) * 3600000;
    const tierElapsed = !writtenMs || now - writtenMs >= tierMs;
    const changed = !existing || existing.refsHash !== hash;
    if (!force && !tierElapsed && !changed) {
      console.log(`${match.key}: oförändrat & ej dags (${match.hoursToKo.toFixed(0)} h kvar).`); continue;
    }

    // Hämta artikelbrödtext (bäst-möjligt) så modellen får riktigt underlag,
    // inte bara rubriker. Görs först här, efter att matchen passerat trappan.
    const bodies = await attachBodies(refs);
    console.log(`${match.key}: ${bodies}/${refs.length} källor med brödtext.`);

    const prompt = buildPrompt(match, refs, lessons, xgSection(match, xgProfiles));
    if (dryRun) {
      console.log(`\n===== ${match.key} ${match.home.sv}–${match.away.sv} (${refs.length} ref) =====`);
      console.log(prompt);
      continue;
    }

    const raw = await generate(match.key, prompt, RESPONSE_SCHEMA);
    const art = raw && renumberCitations(raw, refs);
    if (!art) {
      console.warn(`${match.key}: kunde inte generera – behåller ev. gammal post.`);
      // Både primär- och reservmodell slut på kvot: resten skulle också 429:a –
      // avbryt körningen i stället för att hamra API:t. Nästa körning tar vid.
      if (quotaDead) {
        console.warn("Gemini-kvoten är slut på båda modellerna – avbryter resten av körningen.");
        break;
      }
      continue;
    }

    file.matches[match.key] = {
      teams: [match.homeIso, match.awayIso],
      headline: art.headline,
      lead: art.lead,
      paragraphs: art.paragraphs,
      references: art.references,
      prediction: art.prediction,
      predictionNote: art.predictionNote,
      written: new Date().toISOString(),
      refsHash: hash,
      generated: true
    };
    wrote++;
    console.log(`${match.key}: skrev analys (prognos: ${art.prediction}; ${art.references.length} källor, ${match.hoursToKo.toFixed(0)} h kvar).`);
  }

  if (dryRun) return;
  if (wrote) {
    file.updated = new Date().toISOString();
    fs.writeFileSync(OUT_FILE, JSON.stringify(file, null, 2) + "\n");
    console.log(`Klart – ${wrote} analys(er) uppdaterade i ${path.relative(process.cwd(), OUT_FILE)}.`);
  } else {
    console.log("Inga analyser behövde uppdateras.");
  }
}

// Kör bara pipelinen när filen startas direkt. Vid import (t.ex. från
// syncMatchReviews.js, som återanvänder hjälparna nedan) ska main() INTE köras.
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });

// Delade hjälpare som post-match-synken (syncMatchReviews.js) återanvänder, så att
// nyhetshämtning/översättning/artikeltext/Gemini-anrop bara finns i en kopia.
export {
  sleep, fetchSearch, normTitle, attachBodies, callGemini, isoOf,
  roundLabel, TEAM_NAMES, TEAM_NAMES as REVIEW_TEAM_NAMES
};
