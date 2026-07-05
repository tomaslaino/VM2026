/*
  Bygger data/news_summaries.json AUTOMATISKT: en kort svensk förhandsartikel
  ("Senaste nytt"-fliken) per kommande slutspelsmatch, skriven av en språkmodell
  UTIFRÅN färska källor.

  Pipeline per match:
    1. Läs kommande slutspelsmatcher ur data/results.json (fixtures) – bara
       matcher med känd avspark i framtiden, inom ett fönster, och där båda
       lagen är klara (inte "Round of 16 X Winner").
    2. Samla REFERENSER färskt: lokala medier för båda lagen (Google Nyheter-RSS
       per lands utgåva, samma frågor som syncTeamNews) + en internationell
       förhandssökning på "Lag A" "Lag B". Dedupas, åldersfiltreras, rankas på
       relevans + färskhet och översätts till svenska (gratis gtx, ingen nyckel).
    3. Trappa: ju närmare avspark, desto tätare regenerering. Artikeln skrivs bara
       om när referenserna faktiskt ändrats (refsHash) eller trappans intervall
       löpt ut – annars hoppas matchen över (spar API-anrop).
    4. Språkmodellen (Google Gemini, gratis nivå) skriver {headline, lead,
       paragraphs} på svenska med markörerna **fet**, *kursiv* och [[n]]-
       källhänvisningar mot de numrerade referenserna. Vi renumrerar till exakt
       de källor som faktiskt citerades och skriver ut posten.

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

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const API_KEY = process.env.GEMINI_API_KEY || "";

const GEN_WINDOW_H = 144;     // hur långt före avspark en match börjar få artikel (6 dygn)
const MAX_REFS = 16;          // tak på antal referenser per artikel
const REF_MAX_AGE_DAYS = 12;  // äldre artiklar tas inte med som referens
const PER_SOURCE_LOCAL = 8;   // träffar per allmän lokal lagsökning (landets media)
const PER_SOURCE_MATCH = 6;   // träffar per lokal sökning som även nämner motståndaren
const PER_PREVIEW = 6;        // träffar ur den internationella förhandssökningen
const FETCH_DELAY_MS = 180;   // paus mellan nätanropen – snällt mot Google

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
        avail: true
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

/* Poäng för en referens: färskhet (0–3) + relevans (lagnamn/nyckelord). */
const RELEVANCE_WORDS = ["lineup","laguppst","startel","injur","skad","avstäng","suspend",
  "doubt","osäker","preview","inför","predict","odds","form","comeback","återvänd","tillbaka",
  "avspark","kickoff","rött kort","red card","ban ","tactic","taktik","h2h","head-to-head"];

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
      push(tag(await fetchSearch(cfg, lang, PER_SOURCE_LOCAL), { local: true }));
      await sleep(FETCH_DELAY_MS);
      // 2) Lokal bevakning som specifikt nämner motståndaren – mer matchkonkret.
      const matchCfg = { q: `${cfg.q} (${opp.en} OR ${opp.sv})`, hl: cfg.hl, gl: cfg.gl, ceid: cfg.ceid };
      push(tag(await fetchSearch(matchCfg, lang, PER_SOURCE_MATCH), { local: true }));
      await sleep(FETCH_DELAY_MS);
    }
    // Redan översatta lokala nyheter ur team_news.json som extra underlag (även de lokala).
    const tn = teamNews && teamNews[iso];
    if (tn && Array.isArray(tn.items)) push(tag(tn.items, { local: true }));
  }
  // Internationell förhandssökning på matchen (H2H/odds som komplement).
  const previewQ = `"${match.home.en}" "${match.away.en}" (World Cup OR Mundial OR "VM")`;
  push(await fetchSearch({ q: previewQ, hl: "en-US", gl: "US", ceid: "US:en" }, "en", PER_PREVIEW));
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
  return refs.slice(0, MAX_REFS).map((it) => ({
    source: it.source || null,
    title: it.title_sv || it.title,
    url: it.url,
    published: it.published || null,
    avail: !!it.avail
  }));
}

function refsHashOf(refs) {
  return crypto.createHash("sha1").update(refs.map((r) => r.url).sort().join("\n")).digest("hex").slice(0, 16);
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

function buildPrompt(match, refs) {
  const list = refs.map((r, i) =>
    `[${i + 1}]${r.avail ? " [AVBRÄCK]" : ""} (${r.source || "okänd källa"}) ${r.title}`).join("\n");
  return `Match: ${match.home.sv} – ${match.away.sv} (${match.round} i fotbolls-VM 2026, ${koLabelSv(match.koMs)}).

Skriv en KONKRET, faktaspäckad svensk förhandsartikel inför matchen, ENBART utifrån de numrerade källorna nedan.

Format:
- 3–4 stycken (paragraphs), en rubrik (headline, REN TEXT utan markörer eller källhänvisningar) och en ingress (lead, 1–2 meningar).
- Rubriken och ingressen ska säga något KONKRET om det som avgör matchen (nyckelspelare, avbräck, form, taktik, eller konkreta förhållanden som höjd, värme eller hemmaplan) – inte generellt sälja in matchen.
- Svara ENDAST med JSON: {"headline": "...", "lead": "...", "paragraphs": ["...","...","..."]}.

Konkret innehåll (det viktigaste):
- Varje mening ska bära NY, specifik information ur källorna: spelarnamn, exakta skade-/avstängningslägen, troliga laguppställningar, tränarcitat, resultat med siffror, tabell-/formuppgifter, statistik, taktiska detaljer, inbördes historik.
- Konkreta FÖRHÅLLANDEN som påverkar matchen hör absolut hemma i texten – höjd över havet, värme/väder, planförhållanden, hemmapublikens tryck, resande/trötthet, domaren. Skriv dem konkret (t.ex. "Azteca ligger på 2 240 meters höjd"), inte som svepande stämningsfraser.
- UNDVIK bara floskler och tomma laddningsfraser (det är detta som är "fluff"). Skriv ALDRIG innehållslösa fraser som "en match att minnas", "allt står på spel", "stämningen är på topp", "monumental utmaning", "dramatik utlovas", "skyhöga insatser", "en riktig rysare", eller avsluta med en retorisk fråga. Skillnaden: en konkret uppgift om höjd/värme/publik är BRA; en svepande känslomening utan fakta är fluff. Tillför en mening ingen konkret uppgift – stryk den.
- Ren logistik utan betydelse för spelet (TV-kanal, var man kan se, biljettpriser, öppettider) är inte relevant – hoppa över det.
- Prioritera vad LÄNDERNAS EGNA MEDIER rapporterar (laguppställningar, skadeläge, tränar- och spelarcitat, lokala vinklar). Källor märkta [AVBRÄCK] är bekräftade skador/avstängningar/osäkra – väv in de relevanta för respektive lag.

Källhantering:
- Bygg allt på källorna. Hitta INTE på fakta, namn, siffror eller citat. Är något osäkert i källan, skriv det inte.
- Varje påstående ska ha en hänvisning direkt efter: [[3]] eller [[2,5]]. Max 1–2 källor per påstående, inte långa listor.
- Markera med **fet** för nyckelnamn/avgörande fakta och *kursiv* för direkta citat och smeknamn.
- Använd bara källnummer som finns i listan; du måste inte använda alla.

Källor:
${list}`;
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" },
    lead: { type: "STRING" },
    paragraphs: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["headline", "lead", "paragraphs"]
};

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.45,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA
    }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("Gemini HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
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
  return { headline, lead, paragraphs, references };
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

  // url→svensk rubrik ur tidigare referenser (spar översättningsanrop).
  const prevSv = new Map();
  for (const e of Object.values(file.matches))
    for (const r of e.references || []) if (r.url && r.title) prevSv.set(r.url, r.title);

  let matches = upcomingMatches(now);
  if (only.length) matches = matches.filter((m) => only.includes(m.key));
  console.log(`${matches.length} kommande match(er) i fönstret (${GEN_WINDOW_H} h).`);

  let wrote = 0;
  for (const match of matches) {
    const existing = file.matches[match.key];
    if (existing && existing.manual) { console.log(`${match.key}: manual=true – rörs ej.`); continue; }

    const writtenMs = existing?.written ? Date.parse(existing.written) : 0;
    if (!force && writtenMs && now - writtenMs < fetchGateH(match.hoursToKo) * 3600000) {
      console.log(`${match.key}: hämtade nyligen – väntar (${match.hoursToKo.toFixed(0)} h kvar).`); continue;
    }

    const refs = await buildReferences(match, teamNews, prevSv, availItemsForMatch(match, avail));
    if (refs.length < 3) { console.log(`${match.key}: för få referenser (${refs.length}).`); continue; }
    const hash = refsHashOf(refs);
    const tierMs = tierIntervalH(match.hoursToKo) * 3600000;
    const tierElapsed = !writtenMs || now - writtenMs >= tierMs;
    const changed = !existing || existing.refsHash !== hash;
    if (!force && !tierElapsed && !changed) {
      console.log(`${match.key}: oförändrat & ej dags (${match.hoursToKo.toFixed(0)} h kvar).`); continue;
    }

    const prompt = buildPrompt(match, refs);
    if (dryRun) {
      console.log(`\n===== ${match.key} ${match.home.sv}–${match.away.sv} (${refs.length} ref) =====`);
      console.log(prompt);
      continue;
    }

    let art = null;
    for (let attempt = 1; attempt <= 2 && !art; attempt++) {
      try { art = renumberCitations(await callGemini(prompt), refs); }
      catch (e) { console.warn(`${match.key}: försök ${attempt} misslyckades – ${e.message}`); await sleep(800); }
    }
    if (!art) { console.warn(`${match.key}: kunde inte generera – behåller ev. gammal post.`); continue; }

    file.matches[match.key] = {
      teams: [match.homeIso, match.awayIso],
      headline: art.headline,
      lead: art.lead,
      paragraphs: art.paragraphs,
      references: art.references,
      written: new Date().toISOString(),
      refsHash: hash,
      generated: true
    };
    wrote++;
    console.log(`${match.key}: skrev artikel (${art.references.length} källor, ${match.hoursToKo.toFixed(0)} h kvar).`);
  }

  if (dryRun) return;
  if (wrote) {
    file.updated = new Date().toISOString();
    fs.writeFileSync(OUT_FILE, JSON.stringify(file, null, 2) + "\n");
    console.log(`Klart – ${wrote} artikel(er) uppdaterade i ${path.relative(process.cwd(), OUT_FILE)}.`);
  } else {
    console.log("Inga artiklar behövde uppdateras.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
