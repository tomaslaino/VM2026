/*
  Bygger data/wc2026_player_metrics.json: betting-relevant spelardata som INTE
  finns någon annanstans på sidan, per spelar-id (samma id som
  data/wc2026_players.json).

  Två gratiskällor, ingen API-nyckel:

  1) Transfermarkt (profilsidan) → marknadsvärde (kvalitetsproxy), nuvarande
     klubb och ett spelarporträtt. Spelaren slås upp via TM:s snabbsök och
     verifieras på nationalitet (landets namn måste finnas bland medborgar-
     flaggorna) innan datan används – annars provas nästa sökträff.

  2) Wikipedia (spelarens artikel, "Career statistics"-tabellen) → klubbform
     innevarande säsong (2025/26): matcher och MÅL i ligan och totalt över alla
     turneringar. Målform är den enskilt viktigaste betting-signalen för
     målskytt-/anytime-scorer-marknaderna. Assist/minuter/skott finns inte
     robust gratis (kräver betal-API eller Cloudflare-skyddade sajter) och tas
     därför inte med – se noten i utfilen.

  Uppslagen (TM-id, Wikipedia-titel) CACHEAS i utfilen så att efterföljande
  körningar hoppar över sökstegen. Skriptet skriver inkrementellt och är
  resumbart: en avbruten körning (t.ex. TM-strypning) tappar ingen tidigare
  hämtad spelare. Poster med manual: true bevaras alltid.

  Körs av .github/workflows/sync-player-metrics.yml. Manuellt:
    node server/scripts/syncPlayerMetrics.js            # alla lag
    node server/scripts/syncPlayerMetrics.js --limit 20 # snabb validering
    node server/scripts/syncPlayerMetrics.js --refresh  # tvinga om-hämtning
    node server/scripts/syncPlayerMetrics.js --team SWE  # bara ett lag
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, "../..");
const PLAYERS_FILE = path.join(ROOT, "data", "wc2026_players.json");
const OUT_FILE = path.join(ROOT, "data", "wc2026_player_metrics.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TM = "https://www.transfermarkt.com";
const FETCH_TIMEOUT = 15000;
const DELAY_MS = 550;        // paus mellan anropen – snällt mot källorna
const SEASON = "2025/26";    // klubbsäsongen vi rapporterar (Wikipedia: "2025–26")
const WRITE_EVERY = 8;       // inkrementell skrivning var N:e spelare
const MAX_TM_HITS = 3;       // hur många sökträffar vi provar för nationalitet

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const flagVal = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
const LIMIT = flagVal("--limit") ? parseInt(flagVal("--limit"), 10) : Infinity;
const REFRESH = hasFlag("--refresh");
const ONLY_TEAM = flagVal("--team");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wikipedia ber om en beskrivande User-Agent med kontakt (Wikimedia-policyn).
const WIKI_UA = "VM2026-gravergrav.se player-metrics sync (contact: tomaslaino@gmail.com)";

async function httpOnce(url, ua) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return { status: res.status, text: null };
    return { status: res.status, text: await res.text() };
  } catch {
    return { status: 0, text: null };
  } finally {
    clearTimeout(t);
  }
}

// Hämta med några återförsök + backoff. Skiljer på hårt fel (text:null efter
// alla försök → låt anroparen försöka igen nästa körning) och lyckad hämtning.
async function httpGet(url, { ua = UA, retries = 2 } = {}) {
  let r;
  for (let i = 0; i <= retries; i++) {
    r = await httpOnce(url, ua);
    if (r.text != null) return r;
    // 429/5xx/nätfel → vänta lite längre och prova igen
    await sleep(DELAY_MS * (i + 2));
  }
  return r;
}

/* ---------- Hjälpare ---------- */

// Ta bort taggar + Wikipedia-referenser ([12]) och normalisera whitespace.
function stripTags(html) {
  return html
    .replace(/<sup[^>]*>.*?<\/sup>/gis, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/* ---------- Transfermarkt ---------- */

// Snabbsök → {ok, hits:[{id,slug}]}. ok=false: hämtningen misslyckades.
async function tmSearchHits(name) {
  const url = `${TM}/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(name)}`;
  const { text } = await httpGet(url);
  if (!text) return { ok: false, hits: [] };
  const hits = [];
  const seen = new Set();
  const re = /\/([a-z0-9-]+)\/profil\/spieler\/(\d+)/g;
  let m;
  while ((m = re.exec(text)) && hits.length < MAX_TM_HITS) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    hits.push({ slug: m[1], id: m[2] });
  }
  return { ok: true, hits };
}

// Profilsidan → {mv, mvEur, mvDate, photo, club, nats:[landsnamn]}.
async function tmProfile(hit) {
  const url = `${TM}/${hit.slug}/profil/spieler/${hit.id}`;
  const { text: h } = await httpGet(url);
  if (!h) return null;

  const og = h.match(/og:image"\s+content="([^"]+)"/);
  let photo = og ? og[1] : null;
  if (photo && /portrait\/(big|medium)\/\d+/.test(photo)) {
    // ok – riktigt porträtt; annars (default-silhuett) släng
  } else if (photo && !/portrait\//.test(photo)) {
    photo = null;
  }

  const club = (h.match(/Current club:[\s\S]*?title="([^"]+)"/) || [])[1] || null;

  // Medborgarskap: flaggornas title-attribut i data-headern.
  const nats = [];
  const natRe = /\/flagge\/[^"]*"\s+title="([^"]+)"/g;
  let nm;
  while ((nm = natRe.exec(h))) nats.push(nm[1]);

  // Marknadsvärde ur data-headern: "€ 65.00 m Last update: 03/06/2026".
  let mvEur = null, mv = null, mvDate = null;
  const mvBlock = h.match(/data-header__market-value-wrapper"[^>]*>([\s\S]*?)<\/a>/);
  if (mvBlock) {
    const txt = stripTags(mvBlock[1]);
    const num = txt.match(/([€$£])\s*([\d.,]+)\s*(bn|m|k|th\.?)?/i);
    if (num) {
      let v = parseFloat(num[2].replace(/,/g, ""));
      const unit = (num[3] || "").toLowerCase();
      if (unit.startsWith("bn")) v *= 1e9;
      else if (unit === "m") v *= 1e6;
      else if (unit === "k" || unit.startsWith("th")) v *= 1e3;
      mvEur = Math.round(v);
      mv = tmLabel(mvEur);
    }
    const d = txt.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (d) mvDate = `${d[3]}-${d[2]}-${d[1]}`;
  }
  return { photo, club, nats, mvEur, mv, mvDate };
}

function tmLabel(eur) {
  if (eur == null) return null;
  if (eur >= 1e6) return "€" + (eur / 1e6).toFixed(eur % 1e6 === 0 ? 0 : 1) + "m";
  if (eur >= 1e3) return "€" + Math.round(eur / 1e3) + "k";
  return "€" + eur;
}

// Slå upp spelaren på TM och verifiera nationalitet mot landet.
// → {ok, match:{hit,prof}|null}. ok=false: något nätanrop dog helt (prova igen).
async function resolveTm(name, countryEn, cache) {
  let hits, searchOk = true;
  if (cache && cache.tm_id) {
    hits = [{ id: cache.tm_id, slug: cache.tm_slug || name.toLowerCase().replace(/\s+/g, "-") }];
  } else {
    const r = await tmSearchHits(name);
    searchOk = r.ok;
    hits = r.hits;
    await sleep(DELAY_MS);
  }
  if (!searchOk) return { ok: false, match: null };
  const wantCountry = normName(countryEn);
  let anyFetchFail = false;
  for (const hit of hits) {
    const prof = await tmProfile(hit);
    await sleep(DELAY_MS);
    if (!prof) { anyFetchFail = true; continue; }
    const natOk =
      cache && cache.tm_id // redan verifierad tidigare körning
        ? true
        : prof.nats.some((n) => normName(n) === wantCountry);
    if (natOk) return { ok: true, match: { hit, prof } };
  }
  // Inga träffar verifierades. Om något anrop dog → prova igen nästa körning.
  return { ok: !anyFetchFail, match: null };
}

/* ---------- Wikipedia ---------- */

// → {ok, title}. ok=false: hämtningen misslyckades (prova igen). ok=true:
// vi fick svar (title kan vara null om ingen artikel hittades).
async function wikiTitle(name, countryEn) {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=" +
    encodeURIComponent(`${name} ${countryEn} footballer`);
  const { text } = await httpGet(url, { ua: WIKI_UA });
  if (!text) return { ok: false, title: null };
  try {
    const d = JSON.parse(text);
    const hit = d?.query?.search?.[0];
    return { ok: true, title: hit ? hit.title : null };
  } catch {
    return { ok: true, title: null };
  }
}

// Career statistics-tabellen → innevarande säsong (matcher/mål liga + totalt).
// → {ok, season}. ok=false: hämtningen misslyckades. ok=true: parsad (season
// kan vara null om ingen 2025/26-rad finns i tabellen).
async function wikiSeason(title, clubHint) {
  const url =
    "https://en.wikipedia.org/w/api.php?action=parse&prop=text&format=json&formatversion=2&page=" +
    encodeURIComponent(title);
  const { text } = await httpGet(url, { ua: WIKI_UA });
  if (!text) return { ok: false, season: null };
  let html;
  try {
    html = JSON.parse(text)?.parse?.text;
  } catch {
    return { ok: true, season: null };
  }
  if (!html) return { ok: true, season: null };

  const tables = html.match(/<table[^>]*wikitable[\s\S]*?<\/table>/gi) || [];
  const clubN = normName(clubHint || "");
  const candidates = [];
  for (const tbl of tables) {
    const rows = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    let curClub = "";
    for (const row of rows) {
      const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) => ({
        raw: c,
        txt: stripTags(c),
      }));
      if (!cells.length) continue;
      // Klubbceller kan ha rowspan – kom ihåg senaste klubbnamn i tabellen.
      const clubCell = cells.find((c) => /\/wiki\/[^"]*(F\.?C\.?|Club|United|City|Sporting|Arsenal)/i.test(c.raw) || (c.txt && /[A-Za-z]{3,}/.test(c.txt) && !/^\d/.test(c.txt) && !/^(20\d\d|19\d\d)/.test(c.txt)));
      const seasonCell = cells.find((c) => /^(20\d\d)(?:[–\-–/](\d\d))?$/.test(c.txt.replace(/\s/g, "")));
      if (clubCell && /wiki/.test(clubCell.raw)) curClub = clubCell.txt;
      if (!seasonCell) continue;
      const s = seasonCell.txt.replace(/\s/g, "");
      if (!/^2025[–\-–/]?26?$/.test(s) && s !== "2025–26" && s !== "2025-26" && s !== "202526") {
        // matcha "2025–26" i olika streckvarianter
        if (!/2025[–\-–/]26/.test(s)) continue;
      }
      // Numeriska celler i ordning: [ligaApps, ligaGoals, ... , totApps, totGoals]
      const nums = cells
        .map((c) => c.txt.replace(/[,\s]/g, ""))
        .filter((t) => /^\d+$/.test(t))
        .map((t) => parseInt(t, 10));
      if (nums.length < 2) continue;
      const compName = (() => {
        // första icke-numeriska cellen efter säsongen som ser ut som turnering
        const idx = cells.indexOf(seasonCell);
        for (let i = idx + 1; i < cells.length; i++) {
          const t = cells[i].txt;
          if (t && /[A-Za-z]/.test(t) && !/^\d+$/.test(t)) return t;
        }
        return null;
      })();
      candidates.push({
        club: curClub,
        comp: compName,
        leagueApps: nums[0],
        leagueGoals: nums[1],
        totalApps: nums[nums.length - 2],
        totalGoals: nums[nums.length - 1],
      });
    }
  }
  if (!candidates.length) return { ok: true, season: null };
  // Föredra raden vars klubb matchar TM:s nuvarande klubb; annars flest matcher.
  let best = null;
  if (clubN) {
    best = candidates.find((c) => normName(c.club) && (normName(c.club).includes(clubN) || clubN.includes(normName(c.club))));
  }
  if (!best) best = candidates.slice().sort((a, b) => b.totalApps - a.totalApps)[0];
  return {
    ok: true,
    season: {
      season: SEASON,
      club: best.club || null,
      league: { comp: best.comp, apps: best.leagueApps, goals: best.leagueGoals },
      total: { apps: best.totalApps, goals: best.totalGoals },
      gpa: best.totalApps ? Math.round((best.totalGoals / best.totalApps) * 100) / 100 : null,
    },
  };
}

/* ---------- Huvudflöde ---------- */

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeOut(out) {
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n");
}

async function main() {
  const squads = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
  const prev = loadExisting();
  const prevStatuses = (prev && prev.players) || {};

  const out = {
    tournament: "FIFA World Cup 2026",
    source:
      "Marknadsvärde/klubb/porträtt från Transfermarkt (spelarprofilen); " +
      "klubbform (matcher och mål, liga + totalt) för säsongen 2025/26 från " +
      "spelarens Wikipedia-artikel (Career statistics). Ingen API-nyckel.",
    note:
      "Betting-relevant spelardata som saknas i övriga datalager. " +
      "market_value_eur = Transfermarkts marknadsvärde (proxy för kvalitet). " +
      "season = klubbform 2025/26: league/total {apps, goals} + gpa (mål per match). " +
      "Assist, minuter och skott ingår inte (finns inte robust gratis). " +
      "tm_id/wiki_title cachas för att slippa söka om. Poster med manual: true bevaras.",
    updated: new Date().toISOString(),
    players: {},
  };

  // Behåll manuella poster.
  for (const [id, rec] of Object.entries(prevStatuses)) {
    if (rec && rec.manual) out.players[id] = rec;
  }

  let processed = 0;
  let n = 0;
  const total = squads.teams.reduce((a, t) => a + (t.players ? t.players.length : 0), 0);

  for (const team of squads.teams) {
    if (ONLY_TEAM && team.fifa_code !== ONLY_TEAM) continue;
    for (const p of team.players || []) {
      if (processed >= LIMIT) break;
      n++;
      const cache = prevStatuses[p.id];
      // Bygg vidare på cachen; behåll allt vi redan har.
      const rec = Object.assign(
        { name: p.name, team: team.fifa_code },
        cache && !cache.manual ? cache : {}
      );

      // Två oberoende källor med var sin "checked"-flagga. En källa som är klar
      // (verifierad träff ELLER definitivt ingen data) hämtas inte om. En källa
      // vars anrop dog lämnas ocheckad så nästa körning försöker igen.
      const needTm = REFRESH || !rec.tm_checked;
      const needWiki = REFRESH || !rec.wiki_checked;
      if (!needTm && !needWiki) {
        out.players[p.id] = rec;
        continue;
      }
      processed++;
      rec.updated = new Date().toISOString().slice(0, 10);

      if (needTm) {
        const tm = await resolveTm(p.name, team.name, cache);
        if (tm.ok) {
          rec.tm_checked = true;
          if (tm.match) {
            rec.tm_id = tm.match.hit.id;
            rec.tm_slug = tm.match.hit.slug;
            rec.club = tm.match.prof.club;
            if (tm.match.prof.mvEur != null) {
              rec.market_value_eur = tm.match.prof.mvEur;
              rec.market_value = tm.match.prof.mv;
              rec.mv_date = tm.match.prof.mvDate;
            }
            if (tm.match.prof.photo) rec.photo = tm.match.prof.photo;
          }
        }
      }

      if (needWiki) {
        let title = rec.wiki_title;
        if (!title) {
          const wt = await wikiTitle(p.name, team.name);
          await sleep(DELAY_MS);
          if (wt.ok) title = wt.title || null;
          if (wt.ok && !title) rec.wiki_checked = true; // ingen artikel finns
        }
        if (title) {
          rec.wiki_title = title;
          const ws = await wikiSeason(title, rec.club || null);
          await sleep(DELAY_MS);
          if (ws.ok) {
            rec.wiki_checked = true;
            if (ws.season) rec.season = ws.season;
          }
        }
      }

      out.players[p.id] = rec;

      const tag = [
        rec.market_value || "–",
        rec.season ? `${rec.season.total.goals}m/${rec.season.total.apps}` : "ingen form",
      ].join(" · ");
      console.log(`[${n}/${total}] ${team.fifa_code} ${p.name} → ${tag}`);

      if (processed % WRITE_EVERY === 0) {
        out.updated = new Date().toISOString();
        writeOut(out);
      }
    }
    if (processed >= LIMIT) break;
  }

  out.updated = new Date().toISOString();
  writeOut(out);
  const withMv = Object.values(out.players).filter((r) => r.market_value_eur != null).length;
  const withForm = Object.values(out.players).filter((r) => r.season).length;
  console.log(
    `\nKlart. ${Object.keys(out.players).length} spelare i filen ` +
      `(${withMv} med marknadsvärde, ${withForm} med klubbform).`
  );
}

main().catch((e) => {
  console.error("Fel:", e);
  process.exit(1);
});
