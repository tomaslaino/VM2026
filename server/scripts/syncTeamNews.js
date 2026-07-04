/*
  Bygger data/team_news.json: senaste nyheterna om varje landslag i VM 2026,
  hämtade från RESPEKTIVE LANDS egna medier via Google Nyheter-RSS.

  Poängen är lokal vinkel: nyheter om Egypten kommer ur egyptisk press (arabiska),
  nyheter om Japan ur japansk press osv. Det styrs per lag med en sökfråga på
  landets språk (landslagets vedertagna namn/smeknamn) plus Google News-parametrar
  hl (språk), gl (land) och ceid (utgåva).

  Varje rubrik översätts dessutom till en kort svensk sammanfattning (title_sv)
  via Googles öppna översättnings-endpoint (ingen nyckel). Frontenden
  (assets/matchinfo.js, fliken "Senaste nytt") visar den svenska texten med
  källhänvisning till den inhemska tidningen; originalrubriken behålls i title.
  Redan översatta rubriker återanvänds från förra körningen (nyckel: url) så
  bara nytillkomna artiklar kostar översättningsanrop.

  Ger en fråga noll träffar i landets utgåva provas en reservutgåva för samma
  språk. Misslyckas hämtningen helt behålls lagets gamla nyheter från förra
  körningen, så att fliken inte blir tom vid enstaka nätverksfel.

  Körs av .github/workflows/sync-team-news.yml. Kan köras manuellt:
    node server/scripts/syncTeamNews.js
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dir, "../../data/team_news.json");

const MAX_ITEMS = 6;        // per lag i utfilen
const MAX_AGE_DAYS = 14;    // äldre träffar än så tas inte med
const FETCH_TIMEOUT = 15000;
const DELAY_MS = 150;       // paus mellan anropen – snällt mot Google
const SUMMARY_MAX = 170;    // max längd på den svenska sammanfattningen

/* Sökfråga per lag på landets eget språk (landslagets namn/smeknamn) +
   Google News-utgåva. gl väger upp källor från landet; "when:14d" begränsar
   till färska artiklar redan på serversidan. Exporteras: syncAvailability.js
   återanvänder samma frågor för riktade skadesökningar per lag. */
export const TEAMS = {
  // Grupp A
  mx: { q: '"selección mexicana"', hl: "es-419", gl: "MX", ceid: "MX:es-419" },
  kr: { q: "축구대표팀", hl: "ko", gl: "KR", ceid: "KR:ko" },
  za: { q: '"Bafana Bafana"', hl: "en", gl: "ZA", ceid: "ZA:en" },
  cz: { q: '"fotbalová reprezentace"', hl: "cs", gl: "CZ", ceid: "CZ:cs" },
  // Grupp B
  ca: { q: '"CanMNT" OR "Canada men\'s national soccer team"', hl: "en", gl: "CA", ceid: "CA:en" },
  ch: { q: '"Schweizer Nati" Fussball', hl: "de", gl: "CH", ceid: "CH:de" },
  qa: { q: '"منتخب قطر"', hl: "ar", gl: "QA", ceid: "QA:ar" },
  ba: { q: '"reprezentacija BiH" OR Zmajevi', hl: "bs", gl: "BA", ceid: "BA:bs" },
  // Grupp C
  br: { q: '"seleção brasileira"', hl: "pt-BR", gl: "BR", ceid: "BR:pt-419" },
  ma: { q: '"Lions de l\'Atlas"', hl: "fr", gl: "MA", ceid: "MA:fr" },
  "gb-sct": { q: '"Scotland national team" football', hl: "en-GB", gl: "GB", ceid: "GB:en" },
  ht: { q: '"sélection haïtienne" OR "Grenadiers" football', hl: "fr", gl: "HT", ceid: "FR:fr" },
  // Grupp D
  us: { q: "USMNT", hl: "en", gl: "US", ceid: "US:en" },
  py: { q: '"selección paraguaya" OR Albirroja', hl: "es-419", gl: "PY", ceid: "PY:es-419" },
  au: { q: "Socceroos", hl: "en", gl: "AU", ceid: "AU:en" },
  tr: { q: '"A Milli Futbol Takımı"', hl: "tr", gl: "TR", ceid: "TR:tr" },
  // Grupp E
  de: { q: '"DFB-Team" OR "deutsche Nationalmannschaft"', hl: "de", gl: "DE", ceid: "DE:de" },
  ec: { q: '"selección ecuatoriana" OR "La Tri"', hl: "es-419", gl: "EC", ceid: "EC:es-419" },
  ci: { q: '"Éléphants" "Côte d\'Ivoire" football', hl: "fr", gl: "CI", ceid: "SN:fr" },
  cw: { q: 'Curaçao voetbalelftal OR "Curaçao" WK', hl: "nl", gl: "NL", ceid: "NL:nl" },
  // Grupp F
  nl: { q: '"Nederlands elftal" OR Oranje voetbal', hl: "nl", gl: "NL", ceid: "NL:nl" },
  jp: { q: "サッカー日本代表", hl: "ja", gl: "JP", ceid: "JP:ja" },
  tn: { q: '"منتخب تونس"', hl: "ar", gl: "TN", ceid: "EG:ar" },
  se: { q: '"svenska landslaget" OR Blågult fotboll', hl: "sv", gl: "SE", ceid: "SE:sv" },
  // Grupp G
  be: { q: '"Rode Duivels"', hl: "nl", gl: "BE", ceid: "BE:nl" },
  ir: { q: '"تیم ملی فوتبال ایران"', hl: "fa", gl: "IR", ceid: "IR:fa" },
  eg: { q: '"منتخب مصر"', hl: "ar", gl: "EG", ceid: "EG:ar" },
  nz: { q: '"All Whites" football', hl: "en", gl: "NZ", ceid: "NZ:en" },
  // Grupp H
  es: { q: '"selección española" fútbol', hl: "es", gl: "ES", ceid: "ES:es" },
  uy: { q: '"selección uruguaya" OR "La Celeste" fútbol', hl: "es-419", gl: "UY", ceid: "UY:es-419" },
  sa: { q: '"المنتخب السعودي"', hl: "ar", gl: "SA", ceid: "SA:ar" },
  cv: { q: '"seleção de Cabo Verde" OR "Tubarões Azuis"', hl: "pt-PT", gl: "CV", ceid: "PT:pt-150" },
  // Grupp I
  fr: { q: '"équipe de France" football', hl: "fr", gl: "FR", ceid: "FR:fr" },
  sn: { q: '"Lions de la Téranga" OR "équipe du Sénégal"', hl: "fr", gl: "SN", ceid: "SN:fr" },
  no: { q: "fotballandslaget Norge", hl: "no", gl: "NO", ceid: "NO:no" },
  iq: { q: '"منتخب العراق" OR "أسود الرافدين"', hl: "ar", gl: "IQ", ceid: "EG:ar" },
  // Grupp J
  ar: { q: '"selección argentina"', hl: "es-419", gl: "AR", ceid: "AR:es-419" },
  at: { q: '"ÖFB-Team" OR "Nationalteam" Fußball', hl: "de", gl: "AT", ceid: "AT:de" },
  dz: { q: '"équipe d\'Algérie" OR "Les Verts" football', hl: "fr", gl: "DZ", ceid: "FR:fr" },
  jo: { q: '"المنتخب الأردني" OR "النشامى"', hl: "ar", gl: "JO", ceid: "EG:ar" },
  // Grupp K
  pt: { q: '"seleção portuguesa" OR "Seleção Nacional" futebol', hl: "pt-PT", gl: "PT", ceid: "PT:pt-150" },
  co: { q: '"selección Colombia" fútbol', hl: "es-419", gl: "CO", ceid: "CO:es-419" },
  uz: { q: '"O‘zbekiston terma jamoasi" OR "Узбекистана по футболу сборная"', hl: "uz", gl: "UZ", ceid: "RU:ru" },
  cd: { q: '"Léopards" RDC football', hl: "fr", gl: "CD", ceid: "FR:fr" },
  // Grupp L
  "gb-eng": { q: '"England" "Three Lions" OR "England national team" football', hl: "en-GB", gl: "GB", ceid: "GB:en" },
  hr: { q: '"hrvatska reprezentacija" OR Vatreni nogomet', hl: "hr", gl: "HR", ceid: "HR:hr" },
  pa: { q: '"selección de Panamá" fútbol', hl: "es-419", gl: "PA", ceid: "PA:es-419" },
  gh: { q: '"Black Stars" Ghana', hl: "en", gl: "GH", ceid: "GH:en" }
};

/* Reservutgåva per språk om lagets primära ceid ger noll träffar
   (alla länder har ingen egen Google News-utgåva). */
export const FALLBACK_CEID = {
  ar: "EG:ar", en: "US:en", "en-GB": "GB:en", fr: "FR:fr",
  "es-419": "AR:es-419", es: "ES:es", "pt-BR": "BR:pt-419", "pt-PT": "PT:pt-150",
  de: "DE:de", nl: "NL:nl", bs: "HR:hr", uz: "RU:ru", fa: "US:en"
};

function newsUrl(cfg, ceid) {
  const q = encodeURIComponent(cfg.q + " when:" + MAX_AGE_DAYS + "d");
  return `https://news.google.com/rss/search?q=${q}&hl=${encodeURIComponent(cfg.hl)}` +
    `&gl=${encodeURIComponent(cfg.gl)}&ceid=${encodeURIComponent(ceid)}`;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .trim();
}

function tagContent(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m ? decodeEntities(m[1]) : null;
}

export function parseItems(xml, lang) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const title = tagContent(block, "title");
    const link = tagContent(block, "link");
    const pub = tagContent(block, "pubDate");
    const source = tagContent(block, "source");
    if (!title || !link) continue;
    // Google News avslutar rubriken med " - Källa" – ta bort dubbleringen.
    let clean = title;
    if (source && clean.toLowerCase().endsWith(" - " + source.toLowerCase())) {
      clean = clean.slice(0, clean.length - source.length - 3).trim();
    }
    const ts = pub ? Date.parse(pub) : NaN;
    items.push({
      title: clean,
      url: link,
      source: source || null,
      published: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
      lang
    });
  }
  return items;
}

export async function fetchRss(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; VM2026-news/1.0; +https://gravergrav.se)",
        Accept: "application/rss+xml, application/xml, text/xml"
      }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Svensk sammanfattning av rubrikerna ---------- */

/* Kort och kärnfullt: rensa osynliga tecken (Google Translate lämnar ibland
   zero-width spaces), normalisera whitespace och klipp överlånga rubriker
   (t.ex. inklistrade sociala medier-poster) vid närmaste ordgräns. */
export function tightenSummary(s) {
  let t = String(s || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ").trim();
  if (t.length <= SUMMARY_MAX) return t;
  t = t.slice(0, SUMMARY_MAX);
  const cut = t.lastIndexOf(" ");
  if (cut > 60) t = t.slice(0, cut);
  return t.replace(/[\s,;:.!–—-]+$/, "") + " …";
}

/* Översätt en rubrik till svenska via Googles öppna gtx-endpoint (samma som
   translate.google.com använder – ingen API-nyckel). sl=auto klarar alla
   truppspråk; vid fel returneras null och frontenden visar originalrubriken. */
export async function translateToSwedish(text) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx" +
    "&sl=auto&tl=sv&dt=t&q=" + encodeURIComponent(text);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VM2026-news/1.0; +https://gravergrav.se)" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const segs = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
    const out = segs.map((seg) => (Array.isArray(seg) ? seg[0] || "" : "")).join("").trim();
    return out || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Sätt title_sv på varje nyhet. Svenska rubriker används rakt av; övriga slås
   först upp i förra körningens översättningar (prevSv, nyckel: url) och bara
   nya rubriker skickas till översättningen. */
async function addSwedishSummaries(items, prevSv, stats) {
  for (const it of items) {
    if (it.title_sv) continue;                       // följde med från förra körningen
    if (it.lang === "sv") { it.title_sv = tightenSummary(it.title); continue; }
    const prev = prevSv.get(it.url);
    if (prev) { it.title_sv = prev; continue; }
    const sv = await translateToSwedish(it.title);
    if (sv) { it.title_sv = tightenSummary(sv); stats.translated++; }
    else stats.missed++;
    await sleep(DELAY_MS);
  }
}

function freshSorted(items) {
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  return items
    .filter((it) => !it.published || Date.parse(it.published) >= cutoff)
    .sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0))
    .slice(0, MAX_ITEMS);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function syncTeamNews({ log = console.log } = {}) {
  // Behåll förra körningens data som fallback per lag.
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(OUT_FILE, "utf8")).teams || {};
  } catch {}

  // Översättningscache från förra körningen: url → svensk sammanfattning.
  const prevSv = new Map();
  for (const t of Object.values(previous)) {
    for (const it of t.items || []) {
      if (it.url && it.title_sv) prevSv.set(it.url, it.title_sv);
    }
  }
  const svStats = { translated: 0, missed: 0 };

  const teams = {};
  let ok = 0, empty = 0, failed = 0;
  for (const [iso, cfg] of Object.entries(TEAMS)) {
    const lang = cfg.hl.split("-")[0];
    let items = [];
    let usedCeid = cfg.ceid;
    try {
      items = freshSorted(parseItems(await fetchRss(newsUrl(cfg, cfg.ceid)), lang));
      const fallback = FALLBACK_CEID[cfg.hl] || FALLBACK_CEID[lang];
      if (!items.length && fallback && fallback !== cfg.ceid) {
        await sleep(DELAY_MS);
        usedCeid = fallback;
        items = freshSorted(parseItems(await fetchRss(newsUrl(cfg, fallback)), lang));
      }
    } catch (e) {
      log(`[news] ${iso}: hämtning misslyckades (${e.message})`);
    }
    if (items.length) {
      teams[iso] = { edition: usedCeid, items };
      ok++;
    } else if (previous[iso] && (previous[iso].items || []).length) {
      // Nätverksfel/tom träffbild → behåll gamla nyheter hellre än tom flik.
      teams[iso] = previous[iso];
      failed++;
      log(`[news] ${iso}: behåller ${previous[iso].items.length} gamla träffar`);
    } else {
      teams[iso] = { edition: usedCeid, items: [] };
      empty++;
    }
    await addSwedishSummaries(teams[iso].items, prevSv, svStats);
    await sleep(DELAY_MS);
  }

  const payload = {
    updated: new Date().toISOString(),
    source: "Google News RSS – respektive lands medier (lokala sökfrågor per lag)",
    note: "Byggd av server/scripts/syncTeamNews.js. Originalrubrik i title, svensk sammanfattning i title_sv.",
    teams
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
  log(`[news] klart: ${ok} lag med färska nyheter, ${failed} återanvända, ${empty} tomma · ` +
    `${svStats.translated} nyöversatta rubriker${svStats.missed ? `, ${svStats.missed} utan översättning` : ""} → ` +
    path.relative(process.cwd(), OUT_FILE));
  return { ok, failed, empty };
}

// Kör direkt när skriptet startas från kommandoraden.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncTeamNews().catch((e) => {
    console.error("[news] fatal:", e);
    process.exit(1);
  });
}
