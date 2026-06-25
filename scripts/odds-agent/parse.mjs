// Stänger cookie/geo-popups som blockerar oddsrutnätet.
export const DISMISS_JS = `(() => {
  let n = 0;
  function click(el) {
    if (el && typeof el.click === "function") { el.click(); n++; return true; }
    return false;
  }
  const txt = (document.body && document.body.innerText) || "";
  if (/accessing from outside uk/i.test(txt)) {
    const close = document.querySelector(
      '[aria-label="Close"], [aria-label="close"], .close, .modal-close, button.close, .popup-close, [class*="close"]'
    );
    if (click(close)) return { dismissed: n, kind: "geo_close" };
  }
  if (/want to be kept in the loop/i.test(txt)) {
    for (const el of document.querySelectorAll("button, a, [role='button']")) {
      const t = (el.textContent || "").trim();
      if (/^not now$/i.test(t)) {
        if (click(el)) return { dismissed: n, kind: "notify_not_now" };
      }
    }
    const x = document.querySelector('[aria-label="Close"], .close, button.close');
    if (click(x)) return { dismissed: n, kind: "notify_close" };
  }
  for (const el of document.querySelectorAll("button, a, [role='button']")) {
    const t = (el.textContent || "").trim();
    if (/^not now$/i.test(t)) {
      if (click(el)) return { dismissed: n, kind: "not_now" };
    }
  }
  for (const sel of [
    "#onetrust-accept-btn-handler",
    "button[id*='accept']",
    "[data-testid='accept-all']",
    ".cookie-accept",
  ]) {
    if (click(document.querySelector(sel))) return { dismissed: n, kind: "cookies" };
  }
  return { dismissed: n, kind: "none" };
})()`;

// Stegvis aktivering: flik -> accordion -> show more. Anropas flera gånger.
export const ACTIVATE_CORRECT_SCORE_JS = `(() => {
  function click(el) {
    if (!el || typeof el.click !== "function") return false;
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch {}
    el.click();
    return true;
  }
  function norm(s) { return (s || "").replace(/\\s+/g, " ").trim(); }
  function findCsHeader() {
    for (const h of document.querySelectorAll('h2[class*="AccordionHeader"], h2[id*="market_header"]')) {
      if (norm(h.textContent) === "Correct Score") return h;
    }
    return null;
  }
  function findCsSection() {
    const h = findCsHeader();
    if (!h) return null;
    return h.closest("section") || h.closest("article") || h.parentElement;
  }
  function hasTable() {
    return !!document.querySelector("tbody#t1 td[data-odig], tbody#t1 td[data-o]");
  }
  function scoreRowCount(section) {
    if (!section) return 0;
    let n = 0;
    for (const w of section.querySelectorAll('[class*="MarketExpanderBetWrapper"]')) {
      const label = norm(w.querySelector('[class*="MarketExpanderBetName"]')?.textContent);
      if (/^\\d+\\s*[-–]\\s*\\d+$/.test(label)) n++;
    }
    return n;
  }

  if (hasTable()) return { done: true, reason: "table_visible" };

  let section = findCsSection();
  if (!section) {
    const tab = document.querySelector("#market_filters_Score-Betting_Score-Betting")
      || [...document.querySelectorAll('button[class*="tabNav"], [role="tab"]')]
        .find((b) => /^score betting$/i.test(norm(b.textContent)));
    if (tab && !String(tab.className).includes("pillActive")) {
      if (click(tab)) return { done: false, step: "score_betting_tab" };
    }
    const popTab = document.querySelector("#market_filters_Popular-Markets_Popular-Markets")
      || [...document.querySelectorAll('button[class*="tabNav"], [role="tab"]')]
        .find((b) => /^popular markets$/i.test(norm(b.textContent)));
    if (popTab && !String(popTab.className).includes("pillActive")) {
      if (click(popTab)) return { done: false, step: "popular_markets_tab" };
    }
    section = findCsSection();
  }

  const hdr = findCsHeader();
  if (hdr) {
    const panel = hdr.getAttribute("aria-controls");
    const body = panel ? document.getElementById(panel) : null;
    const hidden = hdr.getAttribute("aria-expanded") === "false"
      || (body && (body.hidden || body.style.display === "none"));
    if (hidden) {
      if (click(hdr)) return { done: false, step: "expand_accordion" };
    }
  }

  section = findCsSection();
  const rows = scoreRowCount(section);

  if (section && rows > 0) {
    const showMore = section.querySelector('[class*="ShowMoreText"]');
    if (showMore) {
      const box = showMore.closest('[class*="ShowMoreContainer"]') || showMore;
      if (click(box)) return { done: false, step: "show_more", rows };
    }
    const compare = section.querySelector('button[aria-label*="Compare All Odds"], [class*="GridToggler"]');
    if (compare && compare.getAttribute("aria-expanded") === "false") {
      if (click(compare)) return { done: false, step: "compare_all", rows };
    }
    if (rows >= 18) return { done: true, reason: "accordion_visible", rows };
    return { done: true, reason: "accordion_partial", rows };
  }

  return { done: false, step: "waiting", hasHeader: !!hdr, hasSection: !!section };
})()`;

// Extraherar correct-score-rader – klassisk tabell (tbody#t1) eller accordion-grid.
export const EXTRACT_JS = `(() => {
  function blocked() {
    const t = (document.title || "").toLowerCase();
    const b = (document.body && document.body.innerText || "").toLowerCase();
    return t.includes("just a moment") || t.includes("attention required")
      || b.includes("verify you are human") || b.includes("cloudflare");
  }
  function norm(s) { return (s || "").replace(/\\s+/g, " ").trim(); }
  function parseFractional(raw) {
    const s = norm(raw);
    if (!s) return 0;
    if (s.includes("/")) {
      const parts = s.split("/");
      const n = parseFloat(parts[0]);
      const d = parseFloat(parts[1]);
      if (isFinite(n) && isFinite(d) && d > 0) return Math.round((n / d + 1) * 100) / 100;
    }
    const v = parseFloat(s);
    return isFinite(v) ? v : 0;
  }
  function pageTeams(pageTitle) {
    const m = String(pageTitle || "").match(/(.+?)\\s+v\\s+(.+?)(?:\\s|$|-|correct|odds)/i);
    if (!m) return { pageHome: "", pageAway: "" };
    return { pageHome: norm(m[1]), pageAway: norm(m[2]) };
  }
  function findCsSection() {
    for (const h of document.querySelectorAll('h2[class*="AccordionHeader"], h2[id*="market_header"]')) {
      if (norm(h.textContent) === "Correct Score") {
        return h.closest("section") || h.closest("article") || h.parentElement;
      }
    }
    return null;
  }
  function parseTable(tbody) {
    const rows = [];
    for (const tr of tbody.querySelectorAll("tr")) {
      const link = tr.querySelector("a.popup, a.bet-name, td.bet-name a, td:first-child a");
      const label = norm(link?.textContent || tr.querySelector(".bet-name")?.textContent);
      const m = label.match(/^(\\d+)\\s*[-–]\\s*(\\d+)$/);
      if (!m) continue;
      const h = parseInt(m[1], 10);
      const a = parseInt(m[2], 10);
      let bestOdds = 0;
      let bestBk = null;
      for (const td of tr.querySelectorAll("td[data-odig], td[data-o]")) {
        const raw = td.getAttribute("data-odig") || td.getAttribute("data-o");
        const o = parseFloat(raw);
        const bk = td.getAttribute("data-bk") || td.getAttribute("data-b");
        if (!isFinite(o) || o <= 1) continue;
        if (o > bestOdds) { bestOdds = o; bestBk = bk || null; }
      }
      if (bestOdds > 0) {
        rows.push({ score: h + "-" + a, h, a, odds: Math.round(bestOdds * 100) / 100, bookmaker: bestBk });
      }
    }
    return rows;
  }
  function parseAccordion(section) {
    const rows = [];
    const seen = new Set();
    for (const w of section.querySelectorAll('[class*="MarketExpanderBetWrapper"]')) {
      const label = norm(w.querySelector('[class*="MarketExpanderBetName"]')?.textContent);
      const m = label.match(/^(\\d+)\\s*[-–]\\s*(\\d+)$/);
      if (!m) continue;
      const left = parseInt(m[1], 10);
      const right = parseInt(m[2], 10);
      const style = w.getAttribute("style") || "";
      const colMatch = style.match(/--maljog0-0:\\s*(\\d+)\\s*\\//);
      const col = colMatch ? parseInt(colMatch[1], 10) : 0;
      let pageHomeGoals = left;
      let pageAwayGoals = right;
      if (col === 3) {
        pageHomeGoals = right;
        pageAwayGoals = left;
      }
      const odds = parseFractional(w.querySelector("button")?.textContent);
      if (odds <= 1) continue;
      const key = pageHomeGoals + "-" + pageAwayGoals;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        score: key,
        pageHomeGoals,
        pageAwayGoals,
        odds,
        bookmaker: null,
      });
    }
    return rows;
  }

  if (blocked()) return { error: "cloudflare" };
  const body = (document.body && document.body.innerText) || "";
  if (/page not found/i.test(body) || /could not locate the page/i.test(body)) {
    return { error: "404" };
  }

  const pageTitle = norm((document.querySelector("h1") || {}).textContent || document.title);
  const teams = pageTeams(pageTitle);

  const tbody = document.querySelector("tbody#t1")
    || document.querySelector("table.eventTable tbody")
    || document.querySelector("[data-market-name*='Correct Score'] tbody");
  if (tbody) {
    const rows = parseTable(tbody);
    if (rows.length) return { pageTitle, ...teams, rows, format: "table" };
  }

  const section = findCsSection();
  if (section) {
    const rows = parseAccordion(section);
    if (rows.length) return { pageTitle, ...teams, rows, format: "accordion" };
  }

  if (!tbody && !section) return { error: "no_table" };
  return { error: "empty_table", pageTitle };
})()`;

/**
 * @param {unknown} raw
 * @returns {{ rows: object[], pageTitle: string, pageHome?: string, pageAway?: string } | { error: string }}
 */
export function normalizeExtract(raw) {
  if (!raw || typeof raw !== "object") return { error: "bad_payload" };
  if (raw.error) return { error: String(raw.error) };
  if (!Array.isArray(raw.rows) || !raw.rows.length) return { error: "empty_table" };
  return {
    rows: raw.rows,
    pageTitle: String(raw.pageTitle || ""),
    pageHome: raw.pageHome ? String(raw.pageHome) : undefined,
    pageAway: raw.pageAway ? String(raw.pageAway) : undefined,
  };
}

/**
 * @param {object[]} rows
 * @param {object} fx
 * @param {string} [pageHome]
 * @param {string} [pageAway]
 * @param {string} [sourceUrl]
 */
export function remapScoresToFixture(rows, fx, pageHome, pageAway, sourceUrl) {
  let swap = false;
  if (pageHome && pageAway) {
    swap =
      !sameTeam(pageHome, fx.home) &&
      (sameTeam(pageHome, fx.away) || sameTeam(pageAway, fx.home));
  }
  if (!swap && sourceUrl) {
    const m = String(sourceUrl).match(/\/([a-z0-9-]+)-v-([a-z0-9-]+)\//i);
    if (m) {
      swap = slugMatchesTeam(m[1], fx.away) && slugMatchesTeam(m[2], fx.home);
    }
  }

  return rows.map((r) => {
    let h = r.h;
    let a = r.a;
    if (r.pageHomeGoals != null && r.pageAwayGoals != null) {
      h = swap ? r.pageAwayGoals : r.pageHomeGoals;
      a = swap ? r.pageHomeGoals : r.pageAwayGoals;
    }
    return {
      score: `${h}-${a}`,
      h,
      a,
      odds: r.odds,
      bookmaker: r.bookmaker ?? null,
    };
  });
}

function slugMatchesTeam(slug, team) {
  const s = String(slug || "").toLowerCase();
  const t = String(team || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s === t || s.includes(t) || t.includes(s.replace(/-/g, ""));
}

function sameTeam(a, b) {
  const x = String(a || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const y = String(b || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return x === y || x.includes(y) || y.includes(x);
}
