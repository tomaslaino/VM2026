import { setTimeout as sleep } from "node:timers/promises";
import { CdpBrowser } from "./cdp.mjs";
import { ACTIVATE_CORRECT_SCORE_JS, DISMISS_JS, EXTRACT_JS, normalizeExtract, remapScoresToFixture } from "./parse.mjs";
import { buildUrls } from "./urls.mjs";
import { validateMatch } from "./validate.mjs";

const PAGE_WAIT_MS = Number(process.env.ODDS_PAGE_WAIT_MS || 6000);
const BETWEEN_MS = Number(process.env.ODDS_BETWEEN_MS || 4000);

/**
 * @param {CdpBrowser} browser
 * @param {string} url
 */
async function scrapeUrl(browser, url) {
  await browser.goto(url, PAGE_WAIT_MS);
  await browser.eval(DISMISS_JS);
  await sleep(800);

  const probe = await browser.eval(`(() => {
    const body = (document.body && document.body.innerText || "").toLowerCase();
    if (/page not found|could not locate the page/.test(body)) return { error: "404" };
    return null;
  })()`);
  if (probe?.error) return normalizeExtract(probe);

  for (let i = 0; i < 20; i++) {
    await browser.eval(DISMISS_JS);
    const act = await browser.eval(ACTIVATE_CORRECT_SCORE_JS);
    if (act?.done) break;
    await sleep(900);
  }

  const raw = await browser.waitFor(EXTRACT_JS, 35000);
  return normalizeExtract(raw);
}

/**
 * @param {CdpBrowser} browser
 * @param {object} fx
 */
export async function scrapeMatch(browser, fx) {
  const urls = buildUrls(fx);
  let lastErr = "no_url";

  for (const url of urls) {
    try {
      const res = await scrapeUrl(browser, url);
      if (res.error) {
        lastErr = res.error;
        continue;
      }
      const scores = remapScoresToFixture(res.rows, fx, res.pageHome, res.pageAway, url);
      const errs = validateMatch(fx, scores);
      if (errs.length) {
        lastErr = errs.join("; ");
        continue;
      }
      return {
        ok: true,
        url,
        pageTitle: res.pageTitle,
        scores,
      };
    } catch (e) {
      lastErr = e.message || String(e);
    }
    await sleep(1500);
  }

  return { ok: false, error: lastErr, urls };
}

/**
 * @param {object[]} fixtures
 * @param {object} [opts]
 * @param {(ev:object)=>void} [opts.onProgress]
 */
export async function scrapeAll(fixtures, opts = {}) {
  const browser = new CdpBrowser();
  await browser.connect();

  /** @type {object[]} */
  const matches = [];
  /** @type {object[]} */
  const failures = [];

  try {
    for (let i = 0; i < fixtures.length; i++) {
      const fx = fixtures[i];
      opts.onProgress?.({ phase: "scrape", i: i + 1, total: fixtures.length, match: fx });

      const res = await scrapeMatch(browser, fx);
      if (res.ok) {
        matches.push(formatMatch(fx, res));
      } else {
        failures.push({
          key: fx.key,
          home: fx.home,
          away: fx.away,
          error: res.error,
          urls: res.urls,
        });
      }

      if (i < fixtures.length - 1) await sleep(BETWEEN_MS);
    }
  } finally {
    await browser.close();
  }

  return { matches, failures };
}

function formatMatch(fx, res) {
  return {
    match: `${fx.home} - ${fx.away}`,
    group: fx.group,
    home: fx.home,
    away: fx.away,
    home_idx: fx.home_idx,
    away_idx: fx.away_idx,
    raw_home: titleTeam(res.pageTitle, 0) || fx.home,
    raw_away: titleTeam(res.pageTitle, 1) || fx.away,
    source_url: res.url,
    scores: res.scores,
  };
}

function titleTeam(title, idx) {
  const m = String(title || "").match(/(.+?)\s+v\s+(.+?)(?:\s*-|\s*$)/i);
  if (!m) return null;
  return (idx === 0 ? m[1] : m[2]).trim();
}

export { BETWEEN_MS, PAGE_WAIT_MS };
