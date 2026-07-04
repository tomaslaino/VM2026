/*
  Bygger data/wc2026_player_status.json – spelartillgänglighet inför varje lags
  NÄSTA match, med källa på varje post. Två oberoende källor:

  1) AVSTÄNGNINGAR – beräknas ur officiell matchdata (data/results.json +
     data/matchdetails.json, samma ESPN-synk som resten av sajten):
       · direkt rött kort eller två gula i samma match → avstängd nästa match
       · två ackumulerade gula kort i olika matcher → avstängd nästa match
         (enstaka gula nollställs efter kvartsfinalerna, FIFA:s regel)
     En avstängning visas bara tills den är avtjänad: gäller förseelsen inte
     lagets senast spelade match är den redan avklarad och tas inte med.
     Källänken pekar på ESPN:s matchsida för matchen där kortet delades ut.

  2) SKADOR/FRÅGETECKEN – ur respektive lands egna medier via Google
     Nyheter-RSS (samma lokala sökfrågor som team_news, plus skade-nyckelord
     på landets språk). Rubriker matchas mot truppens spelarnamn
     (data/wc2026_players.json); träffar översätts till svenska (gratis
     gtx-endpoint) och klassas som "out" bara vid starka nyckelord ("missar",
     "opereras" …), annars "doubtful". Artikeln följer med som källa.
     Rykten kastas om spelaren bevisligen SPELAT en match (laguppställningen i
     matchdetails) efter att artikeln publicerades, eller om artikeln är
     äldre än NEWS_MAX_AGE_DAYS.

  3) Manuella poster (manual: true) i den befintliga filen bevaras alltid och
     vinner över båda källorna ovan.

  Ingen API-nyckel behövs. Körs av .github/workflows/sync-player-status.yml
  varje timme. Manuellt: npm run sync:availability
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TEAMS, FALLBACK_CEID, parseItems, fetchRss, translateToSwedish, tightenSummary
} from "./syncTeamNews.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, "../..");
const PLAYERS_FILE = path.join(ROOT, "data", "wc2026_players.json");
const RESULTS_FILE = path.join(ROOT, "data", "results.json");
const DETAILS_FILE = path.join(ROOT, "data", "matchdetails.json");
const OUT_FILE = path.join(ROOT, "data", "wc2026_player_status.json");

const NEWS_MAX_AGE_DAYS = 6;   // äldre skaderykten än så är inaktuella i ett VM
const NEWS_MAX_ITEMS = 12;     // rubriker som skannas per lag
const DELAY_MS = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Samma iso ↔ FIFA-kod-karta som assets/players.js (data.js använder iso,
   trupp-/statusdatan fifa_code, team_news iso). */
const ISO_TO_CODE = {
  mx: "MEX", kr: "KOR", za: "RSA", cz: "CZE",
  ca: "CAN", ch: "SUI", qa: "QAT", ba: "BIH",
  br: "BRA", ma: "MAR", "gb-sct": "SCO", ht: "HAI",
  us: "USA", py: "PAR", au: "AUS", tr: "TUR",
  de: "GER", ec: "ECU", ci: "CIV", cw: "CUW",
  nl: "NED", jp: "JPN", tn: "TUN", se: "SWE",
  be: "BEL", ir: "IRN", eg: "EGY", nz: "NZL",
  es: "ESP", uy: "URU", sa: "KSA", cv: "CPV",
  fr: "FRA", sn: "SEN", no: "NOR", iq: "IRQ",
  ar: "ARG", at: "AUT", dz: "ALG", jo: "JOR",
  pt: "POR", co: "COL", uz: "UZB", cd: "COD",
  "gb-eng": "ENG", hr: "CRO", pa: "PAN", gh: "GHA",
};

/* ESPN-fixturnamn som avviker från Wikipedia-truppens lagnamn. */
const FIXTURE_ALIASES = {
  "czechia": "Czech Republic",
  "bosnia-herzegovina": "Bosnia and Herzegovina",
  "turkiye": "Turkey",
  "congo dr": "DR Congo",
  "korea republic": "South Korea",
  "cote d'ivoire": "Ivory Coast",
  "cabo verde": "Cape Verde",
  "usa": "United States",
  "ir iran": "Iran",
};

/* Skade-/avstängningsord per språk – läggs till lagets ordinarie sökfråga så
   att Google Nyheter bara ger rubriker som handlar om tillgänglighet. */
const KW_QUERY = {
  sv: ["skadad", "skada", "missar", "osäker", "avstängd"],
  en: ["injury", "injured", "doubt", '"ruled out"', "suspended"],
  es: ["lesión", "lesionado", "baja", "duda", "sancionado"],
  "pt-BR": ["lesão", "lesionado", "desfalque", "dúvida", "suspenso"],
  "pt-PT": ["lesão", "lesionado", "desfalque", "dúvida", "suspenso"],
  fr: ["blessé", "blessure", "forfait", "incertain", "suspendu"],
  de: ["verletzt", "Verletzung", '"fällt aus"', "fraglich", "gesperrt"],
  nl: ["geblesseerd", "blessure", "twijfelgeval", "onzeker", "geschorst"],
  cs: ["zranění", "zraněný", "nejistý"],
  bs: ["povreda", "povrijeđen", "upitan", "suspendovan"],
  hr: ["ozljeda", "ozlijeđen", "upitan"],
  tr: ["sakatlık", "sakat", '"kadro dışı"', "cezalı"],
  no: ["skadet", "skade", "usikker", "utestengt"],
  ko: ["부상", "결장", "징계"],
  ja: ["負傷", "怪我", "離脱", "欠場"],
  ar: ["إصابة", "يغيب", "مصاب", "إيقاف"],
  fa: ["مصدومیت", "مصدوم", "غایب"],
  uz: ["jarohat", "травма"],
};

/* Normalisera namn: gemener, utan diakritik och skiljetecken. */
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}

/* ---------- Trupp- och matchindex ---------- */

function buildSquads(playersData) {
  const byName = {};   // normaliserat lagnamn -> lag
  const byCode = {};   // fifa_code -> lag
  for (const team of playersData.teams || []) {
    byCode[team.fifa_code] = team;
    byName[norm(team.name)] = team;
    if (team.name_sv) byName[norm(team.name_sv)] = team;
  }
  for (const [alias, canon] of Object.entries(FIXTURE_ALIASES)) {
    const t = byName[norm(canon)];
    if (t && !byName[norm(alias)]) byName[norm(alias)] = t;
  }
  // Per lag: uppslag fullt namn -> spelare samt efternamn -> kandidater.
  // firstNames: alla förnamn i HELA turneringen – används för att avvisa
  // efternamnsmatchningar där rubriken egentligen nämner en annan spelare
  // (t.ex. Uruguays "Maxi Araújo" får inte träffa Portugals Tomás Araújo).
  const idx = {};
  const firstNames = new Set();
  for (const team of playersData.teams || []) {
    const byFull = {}, byLast = {};
    for (const p of team.players || []) {
      const n = norm(p.name);
      byFull[n] = p;
      const parts = n.split(" ");
      const last = parts.pop();
      (byLast[last] = byLast[last] || []).push(p);
      for (const part of parts) if (part.length >= 3) firstNames.add(part);
    }
    idx[team.fifa_code] = { byFull, byLast, players: team.players || [] };
  }
  return { byName, byCode, idx, firstNames };
}

/* Matcha ett ESPN-händelsenamn mot truppen (samma logik som assets/playerstats.js). */
function findSquadPlayer(squad, evName) {
  if (!squad) return null;
  const n = norm(evName);
  if (squad.byFull[n]) return squad.byFull[n];
  const parts = n.split(" ");
  const cands = squad.byLast[parts[parts.length - 1]] || [];
  if (cands.length === 1) return cands[0];
  if (cands.length > 1 && parts.length > 1) {
    const ini = parts[0].charAt(0);
    const hit = cands.filter((p) => norm(p.name).charAt(0) === ini);
    if (hit.length === 1) return hit[0];
  }
  return null;
}

/* Rundinfo för en resultatnyckel: svensk etikett + ordning (för gula kort-
   rensningen efter kvartsfinal). VM 2026: k:73–88 sextondelar, 89–96
   åttondelar, 97–100 kvartar, 101–102 semifinaler, 103 brons, 104 final. */
function roundOfKey(key) {
  if (/^g:/.test(key)) return { label: "gruppspelet", ord: 0 };
  const n = parseInt(String(key).slice(2), 10);
  if (n <= 88) return { label: "sextondelsfinalen", ord: 1 };
  if (n <= 96) return { label: "åttondelsfinalen", ord: 2 };
  if (n <= 100) return { label: "kvartsfinalen", ord: 3 };
  if (n <= 102) return { label: "semifinalen", ord: 4 };
  if (n === 103) return { label: "bronsmatchen", ord: 5 };
  return { label: "finalen", ord: 6 };
}

const FINISHED = { FINISHED: 1, AWARDED: 1 };

/* Lagets matcher (spelade + nästa) ur fixtures, kronologiskt. */
function teamFixtures(fixtures, teamName) {
  const rows = [];
  for (const [key, f] of Object.entries(fixtures)) {
    if (!f || (f.home !== teamName && f.away !== teamName)) continue;
    rows.push({
      key, side: f.home === teamName ? "h" : "a",
      oppName: f.home === teamName ? f.away : f.home,
      utc: Date.parse(f.utcDate) || 0,
      status: f.status || "",
    });
  }
  rows.sort((a, b) => a.utc - b.utc);
  return rows;
}

/* ---------- 1) Avstängningar ur matchdatan ---------- */

function computeSuspensions({ fixtures, details, squads, log }) {
  const out = {}; // pid -> statuspost
  const unmatched = new Set();

  for (const team of Object.values(squads.byCode)) {
    const rows = teamFixtures(fixtures, findFixtureName(fixtures, team, squads));
    const played = rows.filter((r) => FINISHED[r.status]);
    const next = rows.find((r) => !FINISHED[r.status]);
    if (!played.length || !next) continue;
    const last = played[played.length - 1];
    const squad = squads.idx[team.fifa_code];
    const nextRound = roundOfKey(next.key);

    // Kortläge per spelare och match, kronologiskt.
    const perMatch = played.map((m) => {
      const det = details[m.key];
      const cards = {}; // pid -> {y, r}
      for (const b of (det && det.bookings) || []) {
        if (b.team !== m.side || !b.player) continue;
        const p = findSquadPlayer(squad, b.player);
        if (!p) { unmatched.add(team.fifa_code + ": " + b.player); continue; }
        const c = cards[p.id] || (cards[p.id] = { y: 0, r: 0 });
        if (b.card === "RED") c.r++;
        else if (b.card === "YELLOW_RED") { c.r++; c.y += 2; }
        else if (b.card === "YELLOW") c.y++;
      }
      return { m, det, cards };
    });

    // Ackumulerade gula: räknas per spelare; matcher med utvisning räknas
    // inte in (FIFA stryker de gula), och enstaka gula nollställs efter
    // kvartsfinalerna (gäller när nästa match är semifinal eller senare).
    const cum = {};     // pid -> { n, matches: [perMatch-post] }
    const banned = {};  // pid -> { type, at: perMatch-post, viaMatches? }
    for (const pm of perMatch) {
      const round = roundOfKey(pm.m.key);
      for (const [pid, c] of Object.entries(pm.cards)) {
        const sentOff = c.r > 0 || c.y >= 2;
        if (sentOff) {
          banned[pid] = { type: c.r > 0 && c.y >= 2 ? "yellowred" : (c.y >= 2 ? "yellowred" : "red"), at: pm };
          if (cum[pid]) cum[pid] = { n: 0, matches: [] }; // gula i utvisningsmatchen stryks
          continue;
        }
        if (c.y === 1) {
          if (nextRound.ord >= 4 && round.ord < 4) continue; // rensade efter kvartsfinal
          const acc = cum[pid] || (cum[pid] = { n: 0, matches: [] });
          acc.n++; acc.matches.push(pm);
          if (acc.n >= 2) {
            banned[pid] = { type: "accumulated", at: pm, viaMatches: acc.matches.slice(-2) };
            cum[pid] = { n: 0, matches: [] };
          }
        }
      }
    }

    for (const [pid, ban] of Object.entries(banned)) {
      // Bara aktiv om förseelsen kom i lagets senast spelade match –
      // annars är enmatchsavstängningen redan avtjänad.
      if (ban.at.m.key !== last.key) continue;
      const oppTeam = squads.byName[norm(ban.at.m.oppName)];
      const oppSv = oppTeam ? oppTeam.name_sv : ban.at.m.oppName;
      const round = roundOfKey(ban.at.m.key);
      let detail;
      if (ban.type === "red") detail = `Rött kort i ${round.label} mot ${oppSv}`;
      else if (ban.type === "yellowred") detail = `Två gula kort i ${round.label} mot ${oppSv}`;
      else {
        const opps = ban.viaMatches.map((pm) => {
          const t = squads.byName[norm(pm.m.oppName)];
          return t ? t.name_sv : pm.m.oppName;
        });
        detail = `Andra gula kortet i turneringen (mot ${opps.join(" och ")})`;
      }
      const espnId = ban.at.det && ban.at.det.espnId;
      out[pid] = {
        availability: "out",
        kind: "suspension",
        label: "Avstängd",
        detail,
        updated: new Date(ban.at.m.utc).toISOString().slice(0, 10),
        source: {
          name: "Matchfakta (ESPN)",
          url: espnId ? `https://www.espn.com/soccer/match/_/gameId/${espnId}` : null,
        },
        origin: "cards",
      };
    }
  }
  if (unmatched.size) {
    log(`[avail] ${unmatched.size} kortnamn utan truppmatchning: ${[...unmatched].slice(0, 8).join(" · ")}`);
  }
  return out;
}

/* Fixture-namnet (ESPN) för ett trupplag – testa Wikipedianamnet och alias. */
function findFixtureName(fixtures, team, squads) {
  const names = new Set();
  for (const f of Object.values(fixtures)) { names.add(f.home); names.add(f.away); }
  if (names.has(team.name)) return team.name;
  for (const [alias, canon] of Object.entries(FIXTURE_ALIASES)) {
    if (norm(canon) === norm(team.name)) {
      const hit = [...names].find((n) => norm(n) === norm(alias));
      if (hit) return hit;
    }
  }
  return team.name; // ger tom matchlista → laget hoppas över
}

/* ---------- 2) Skador/frågetecken ur ländernas medier ---------- */

function injuryQueryUrl(cfg, ceid, kws) {
  const q = encodeURIComponent(`${cfg.q} (${kws.join(" OR ")}) when:${NEWS_MAX_AGE_DAYS}d`);
  return `https://news.google.com/rss/search?q=${q}&hl=${encodeURIComponent(cfg.hl)}` +
    `&gl=${encodeURIComponent(cfg.gl)}&ceid=${encodeURIComponent(ceid)}`;
}

/* Hitta truppspelare vars namn förekommer i rubriken. Fullt namn räcker
   alltid; enbart efternamn kräver ≥ 4 tecken, att det är unikt i truppen och
   att ordet före inte är en ANNAN spelares förnamn (annars är rubriken
   sannolikt om någon annan med samma efternamn). */
function playersInTitle(squad, firstNames, title) {
  const text = " " + norm(title) + " ";
  const hits = [];
  for (const p of squad.players) {
    const full = norm(p.name);
    if (text.includes(" " + full + " ")) { hits.push(p); continue; }
    const parts = full.split(" ");
    const last = parts.pop();
    const pos = last.length >= 4 && (squad.byLast[last] || []).length === 1
      ? text.indexOf(" " + last + " ") : -1;
    if (pos === -1) continue;
    // Ordet före efternamnet får inte vara någon ANNAN spelares förnamn –
    // inte heller ett smeknamnsprefix av ett ("Maxi" för "Maximiliano").
    const before = text.slice(0, pos).trim().split(" ").pop() || "";
    if (before.length >= 3 && !parts.includes(before) && !parts.some((fn) => fn.startsWith(before))) {
      let alien = firstNames.has(before);
      if (!alien && before.length >= 4) {
        for (const fn of firstNames) { if (fn.startsWith(before)) { alien = true; break; } }
      }
      if (alien) continue;
    }
    hits.push(p);
  }
  return hits;
}

/* Klassning på den SVENSKA översättningen – ett nyckelordsset för alla språk.
   relevant=false betyder att rubriken inte handlar om tillgänglighet alls
   (spelarnamnet råkade bara stå i en rubrik som sökfrågan fångade). */
function classifySwedish(svText) {
  const t = " " + norm(svText) + " ";
  // Förturneringsinnehåll (vänskapsmatcher) som återpubliceras är inaktuellt.
  if (/vanskaps|traningsmatch|traningslandskamp/.test(t)) {
    return { availability: "doubtful", kind: "other", relevant: false };
  }
  const out = /\bmissar\b|\bavstangd\b|\bopererad\b|\bopereras\b|ute ur (vm|turneringen|resten)|utanfor truppen|lamnar vm|\bbryter\b|borta resten|missar resten|over for|\bforfait\b/.test(t);
  let kind = "other";
  if (/avstangd|avstangning|rott kort|gula kort/.test(t)) kind = "suspension";
  else if (/\bsjuk\w*|\bfeber|magsjuk|infektion/.test(t)) kind = "illness";
  else if (/\bskad\w*|blessyr|\bkanning|muskelbesvar|ljumsk|hamstring|fotled\w*|stukning|fraktur|\bbruten\b|opererad|opereras|smartor|\bkramp\w*/.test(t)) kind = "injury";
  // Tveksamhetsord som gör rubriken relevant även utan uttrycklig skada.
  const doubtWords = /\bosaker\b|\bosakert\b|\btveksam\w*|fragetecken|\boro\b|\boroar\w*|\boroande\b|\bfranvaro\b|kamp mot klockan|race mot klockan|\butgick\b|\bhaltade\b|tranade (inte|separat)|\bvilade\b|aterhamtning|\baterkomst\b|\batervander\b|narmar sig|\bfitness\b|\bkondition\w*|kommer han att (anlanda|hinna|spela)|sista minuten/.test(t);
  return { availability: out ? "out" : "doubtful", kind, relevant: out || kind !== "other" || doubtWords };
}

/* Har spelaren spelat (start eller inhopp) i en match efter tidpunkten ts? */
function playedAfter(pid, ts, playedRows, details, squad) {
  for (const m of playedRows) {
    if (m.utc <= ts) continue;
    const det = details[m.key];
    const lu = det && det.lineups && det.lineups[m.side];
    if (!lu) continue;
    const names = [...(lu.starters || []), ...((lu.bench || []).filter((b) => b.in))]
      .map((x) => x && x.name).filter(Boolean);
    for (const n of names) {
      const p = findSquadPlayer(squad, n);
      if (p && p.id === pid) return true;
    }
  }
  return false;
}

async function collectNewsStatuses({ fixtures, details, squads, log }) {
  const out = {}; // pid -> statuspost
  const cutoff = Date.now() - NEWS_MAX_AGE_DAYS * 86400000;
  let scanned = 0, matched = 0, dropped = 0;

  for (const [iso, cfg] of Object.entries(TEAMS)) {
    const code = ISO_TO_CODE[iso];
    const team = code && squads.byCode[code];
    const squad = code && squads.idx[code];
    if (!team || !squad) continue;

    const rows = teamFixtures(fixtures, findFixtureName(fixtures, team, squads));
    const playedRows = rows.filter((r) => FINISHED[r.status]);
    const next = rows.find((r) => !FINISHED[r.status]);
    if (!next) continue; // laget är färdigspelat – inga "inför matchen"-poster

    const lang = cfg.hl.split("-")[0];
    const kws = KW_QUERY[cfg.hl] || KW_QUERY[lang] || KW_QUERY.en;
    let items = [];
    try {
      items = parseItems(await fetchRss(injuryQueryUrl(cfg, cfg.ceid, kws)), lang);
      const fallback = FALLBACK_CEID[cfg.hl] || FALLBACK_CEID[lang];
      if (!items.length && fallback && fallback !== cfg.ceid) {
        await sleep(DELAY_MS);
        items = parseItems(await fetchRss(injuryQueryUrl(cfg, fallback, kws)), lang);
      }
    } catch (e) {
      log(`[avail] ${iso}: nyhetshämtning misslyckades (${e.message})`);
    }
    items = items
      .filter((it) => it.published && Date.parse(it.published) >= cutoff)
      .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
      .slice(0, NEWS_MAX_ITEMS);
    scanned += items.length;

    for (const it of items) {
      // Matcha på originalrubriken; för icke-latinska språk på översättningen.
      let hits = playersInTitle(squad, squads.firstNames, it.title);
      let sv = null;
      if (!hits.length && /[^\0-ɏḀ-ỿ\s\p{P}\p{N}]/u.test(it.title)) {
        sv = await translateToSwedish(it.title);
        await sleep(DELAY_MS);
        if (sv) hits = playersInTitle(squad, squads.firstNames, sv);
      }
      if (!hits.length) continue;
      if (!sv) { sv = await translateToSwedish(it.title); await sleep(DELAY_MS); }
      const svShort = tightenSummary(sv || it.title);
      const cls = classifySwedish(sv || it.title);
      if (!cls.relevant) continue; // rubriken handlar inte om tillgänglighet
      const ts = Date.parse(it.published);

      for (const p of hits) {
        // Spelade spelaren en match EFTER artikeln är uppgiften överspelad.
        if (playedAfter(p.id, ts, playedRows, details, squad)) { dropped++; continue; }
        const entry = {
          availability: cls.availability,
          kind: cls.kind,
          detail: svShort,
          updated: it.published.slice(0, 10),
          source: { name: it.source || "Nyhetskälla", url: it.url },
          origin: "news",
        };
        const prev = out[p.id];
        const rank = (e) => (e.availability === "out" ? 1 : 0);
        if (!prev || rank(entry) > rank(prev) ||
            (rank(entry) === rank(prev) && String(entry.updated) > String(prev.updated))) {
          out[p.id] = entry;
        }
        matched++;
      }
    }
    await sleep(DELAY_MS);
  }
  log(`[avail] nyheter: ${scanned} rubriker skannade, ${matched} spelarträffar, ${dropped} överspelade rykten kastade`);
  return out;
}

/* ---------- Ihopvägning + skrivning ---------- */

export async function syncAvailability({ log = console.log } = {}) {
  const playersData = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
  const results = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
  const detailsData = JSON.parse(fs.readFileSync(DETAILS_FILE, "utf8"));
  const fixtures = results.fixtures || {};
  const details = detailsData.details || {};
  const squads = buildSquads(playersData);

  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(OUT_FILE, "utf8")).statuses || {}; } catch {}

  const suspensions = computeSuspensions({ fixtures, details, squads, log });
  const news = await collectNewsStatuses({ fixtures, details, squads, log });

  // Prioritet: manuellt > avstängning (officiell matchdata) > nyhets-"out" > "doubtful".
  const statuses = {};
  for (const [pid, s] of Object.entries(news)) statuses[pid] = s;
  for (const [pid, s] of Object.entries(suspensions)) statuses[pid] = s;
  for (const [pid, s] of Object.entries(previous)) {
    if (s && s.manual) statuses[pid] = s;
  }

  const out = {
    tournament: "FIFA World Cup 2026",
    source: "Officiell matchdata (ESPN) för avstängningar + respektive lands medier via Google Nyheter för skador/frågetecken",
    updated: new Date().toISOString(),
    note:
      "Spelartillgänglighet inför lagets nästa match, per spelar-id (samma id som data/wc2026_players.json). " +
      "availability: 'out' (spelar inte) eller 'doubtful' (osäker). kind: 'injury' | 'suspension' | 'illness' | 'other'. " +
      "source: {name, url} – ESPN-matchsidan för avstängningar, nyhetsartikeln för skador. " +
      "Genereras av server/scripts/syncAvailability.js; poster med manual: true bevaras alltid.",
    statuses,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");

  const nOut = Object.values(statuses).filter((s) => s.availability === "out").length;
  log(`[avail] klart: ${Object.keys(statuses).length} spelare med status ` +
    `(${nOut} spelar inte, ${Object.keys(statuses).length - nOut} frågetecken; ` +
    `${Object.keys(suspensions).length} avstängningar ur matchdata) → ${path.relative(process.cwd(), OUT_FILE)}`);
  return { count: Object.keys(statuses).length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  syncAvailability().catch((e) => {
    console.error("[avail] fatal:", e);
    process.exit(1);
  });
}
