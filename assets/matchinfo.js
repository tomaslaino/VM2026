/*
  VM 2026 – matchinfo-modal (frontend).

  Klick på en pågående eller spelad match öppnar en modal med ställning,
  status, mål, kort, byten, domare, publik m.m.

  Datakälla: data/matchdetails.json (skrivs av GitHub Actions-synken) eller
  /api/matchdetails i backend-läge. Pågående matcher uppdateras automatiskt
  medan modalen är öppen; avslutade matcher är sparade permanent och kan
  öppnas när som helst i efterhand.
*/
(function () {
  "use strict";

  var CFG = window.VM_CONFIG || {};
  var BACKEND = (CFG.backend || "").replace(/\/$/, "");
  var STATIC_URL = CFG.staticDetails || "data/matchdetails.json";
  var HIGHLIGHTS_URL = CFG.staticHighlights || "data/highlights.json";
  var NEWS_URL = CFG.staticTeamNews || "data/team_news.json";
  var SUMMARY_URL = CFG.staticNewsSummaries || "data/news_summaries.json";
  var PRELIM_URL = CFG.staticLineups || "data/lineups_prelim.json";
  var REVIEWS_URL = CFG.staticMatchReviews || "data/match_reviews.json";
  var POLL_MS = 45000;

  var details = {};        // key -> detaljobjekt
  var detailsLoaded = false;
  var highlights = {};     // key -> { SVT?: {full,long,short}, TV4?: {...} }
  var highlightsLast = 0;
  var teamNews = null;     // iso -> { items: [...] } (data/team_news.json)
  var teamNewsLast = 0;
  var newsSummaries = null; // key -> { paragraphs, references, prediction, written } (data/news_summaries.json)
  var newsSummariesLast = 0;
  var prelimLineups = null; // key -> trolig/bekräftad elva (data/lineups_prelim.json)
  var prelimLast = 0;
  var matchReviews = null;  // key -> facit-post (data/match_reviews.json)
  var reviewsAccuracy = null; // { graded, winner, score } – redaktionens träffsäkerhet
  var reviewsLast = 0;
  var openKey = null;      // öppen match (resultatnyckel) eller null
  var pollTimer = null;
  var pvRetryTimer = null; // inför-snacket: rita om när odds/motor blir klara
  var pvRetryCount = 0;
  var activeTab = "events";
  var revealed = {};       // nyckel -> true: spoilern är manuellt "visad ändå"

  var TABS = [
    { id: "events", label: "Händelser" },
    { id: "lineups", label: "Laguppställning" },
    { id: "stats", label: "Statistik" }
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function flagImg(iso) {
    if (!iso) return '<span class="mi-flag-ph"></span>';
    return '<img class="flag" loading="lazy" src="https://flagcdn.com/' + iso + '.svg" alt="" ' +
      'onerror="this.style.visibility=\'hidden\'">';
  }

  /* ---------- Datahämtning ---------- */

  function detailsUrl() {
    if (BACKEND) return BACKEND + "/api/matchdetails";
    return STATIC_URL + (STATIC_URL.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
  }

  function notifyApp() {
    // Ge app.js detaljerna så att fair play (kort) kan räknas in i tabellerna.
    if (window.VMApp && typeof window.VMApp.setMatchDetails === "function") {
      try { window.VMApp.setMatchDetails(details); } catch (e) {}
    }
  }

  function fetchDetails() {
    return fetch(detailsUrl(), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.details) {
          details = data.details;
          detailsLoaded = true;
          notifyApp();
        }
        return details;
      })
      .catch(function () { return details; });
  }

  /* Höjdpunkter/repriser (SVT Play + TV4 Play) skrivs av GitHub Actions till
     data/highlights.json. Läses alltid från den statiska filen (det finns ingen
     server-endpoint för detta) och cachas en stund mellan öppningar. */
  function highlightsUrl() {
    return HIGHLIGHTS_URL + (HIGHLIGHTS_URL.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
  }

  function fetchHighlights() {
    var now = Date.now();
    if (highlightsLast && now - highlightsLast < 120000) return Promise.resolve(highlights);
    highlightsLast = now;
    return fetch(highlightsUrl(), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.byKey) highlights = data.byKey;
        return highlights;
      })
      .catch(function () { return highlights; });
  }

  /* Landsnyheter (data/team_news.json, skrivs av GitHub Actions): nyheter om
     varje landslag från respektive lands egna medier via Google Nyheter.
     Cachas en stund mellan öppningar – nyheter uppdateras inte sekundsnabbt. */
  function fetchTeamNews() {
    var now = Date.now();
    if (teamNews && now - teamNewsLast < 600000) return Promise.resolve(teamNews);
    teamNewsLast = now;
    return fetch(NEWS_URL + (NEWS_URL.indexOf("?") === -1 ? "?" : "&") + "t=" + now,
      { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.teams) teamNews = data.teams;
        return teamNews;
      })
      .catch(function () { return teamNews; });
  }

  /* Matchsammanfattningar (data/news_summaries.json): handskriven svensk
     löptext per kommande match – de viktigaste nyheterna och diskussionerna
     i båda ländernas medier, med källreferenser. Saknas en match faller
     nyhetsfliken tillbaka till rubriklistan ur team_news.json. */
  function fetchNewsSummaries() {
    var now = Date.now();
    if (newsSummaries && now - newsSummariesLast < 600000) return Promise.resolve(newsSummaries);
    newsSummariesLast = now;
    return fetch(SUMMARY_URL + (SUMMARY_URL.indexOf("?") === -1 ? "?" : "&") + "t=" + now,
      { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.matches) newsSummaries = data.matches;
        else if (newsSummaries == null) newsSummaries = {};
        return newsSummaries;
      })
      .catch(function () {
        if (newsSummaries == null) newsSummaries = {};
        return newsSummaries;
      });
  }

  /* Sammanfattning för en match, om den finns och inte är för gammal (en
     kvarglömd fil från en tidigare omgång ska inte visas som färsk). */
  function summaryOf(key) {
    var s = newsSummaries && key ? newsSummaries[key] : null;
    if (!s || !s.paragraphs || !s.paragraphs.length) return null;
    var t = s.written ? new Date(s.written).getTime() : NaN;
    if (isFinite(t) && Date.now() - t > 5 * 86400000) return null;
    return s;
  }

  /* Troliga startelvor (data/lineups_prelim.json, skrivs av GitHub Actions):
     365Scores publicerar en trolig elva ofta redan dagen före match och samma
     data slår om till "bekräftad" när de officiella elvorna släpps (~1 h före
     avspark). Kort cache – nära avspark vill man se bekräftelsen snabbt. */
  function fetchPrelimLineups() {
    var now = Date.now();
    if (prelimLineups && now - prelimLast < 180000) return Promise.resolve(prelimLineups);
    prelimLast = now;
    return fetch(PRELIM_URL + (PRELIM_URL.indexOf("?") === -1 ? "?" : "&") + "t=" + now,
      { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.lineups) prelimLineups = data.lineups;
        return prelimLineups;
      })
      .catch(function () { return prelimLineups; });
  }

  function prelimFor(key) {
    var e = key && prelimLineups ? prelimLineups[key] : null;
    return e && e.h && e.a ? e : null;
  }

  /* Facit (data/match_reviews.json, skrivs av GitHub Actions): efteranalys per
     spelad slutspelsmatch som jämför förhandsprognosen med utfallet. Cachas en
     stund mellan öppningar. reviewsAccuracy = redaktionens totala träffsäkerhet. */
  function fetchMatchReviews() {
    var now = Date.now();
    if (matchReviews && now - reviewsLast < 300000) return Promise.resolve(matchReviews);
    reviewsLast = now;
    return fetch(REVIEWS_URL + (REVIEWS_URL.indexOf("?") === -1 ? "?" : "&") + "t=" + now,
      { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.matches) { matchReviews = data.matches; reviewsAccuracy = data.accuracy || null; }
        else if (matchReviews == null) matchReviews = {};
        return matchReviews;
      })
      .catch(function () { if (matchReviews == null) matchReviews = {}; return matchReviews; });
  }

  function reviewOf(key) {
    var r = matchReviews && key ? matchReviews[key] : null;
    return r && r.paragraphs && r.paragraphs.length ? r : null;
  }

  /* Hämta om detaljerna (anropas av app.js när nya resultat kommit in).
     Lätt strypt så att täta resultatuppdateringar inte spammar nätverket. */
  var lastRefresh = 0;
  function refreshDetails() {
    var now = Date.now();
    if (now - lastRefresh < 20000) return;
    lastRefresh = now;
    fetchDetails();
  }

  /* ---------- Poll medan modalen är öppen ---------- */

  function needsPolling(info, det) {
    if (!info) return false;
    if (info.live) return true;
    // Spelad men detaljer saknas/inte slutgiltiga ännu → fortsätt kolla.
    if (info.played && (!det || (det.status !== "FINISHED" && det.status !== "AWARDED"))) return true;
    return false;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!openKey) return;
    pollTimer = setTimeout(function () {
      if (!openKey) return;
      fetchDetails().then(function () {
        renderModal();
        schedulePoll();
      });
    }, POLL_MS);
  }

  /* ---------- Modal ---------- */

  function ensureModal() {
    var m = document.getElementById("matchModal");
    if (m) return m;
    m = document.createElement("div");
    m.id = "matchModal";
    m.className = "match-modal";
    m.innerHTML = '<div class="mi-backdrop"></div>' +
      '<div class="mi-card" role="dialog" aria-modal="true" aria-label="Matchinformation"></div>';
    document.body.appendChild(m);
    m.querySelector(".mi-backdrop").addEventListener("click", close);
    // Delegerat på kortet (som lever mellan omrenderingar) – öppnar spelarprofil
    // när en klickbar uppställningsrad väljs.
    m.querySelector(".mi-card").addEventListener("click", onCardClick);
    return m;
  }

  function onCardClick(e) {
    // Källänkarna i avbräckslistan ligger inne i klickbara spelarrader –
    // låt länken vinna över spelarprofilen.
    if (e.target.closest && e.target.closest("a.mi-avail-src")) return;
    var row = e.target.closest && e.target.closest("[data-mi-player]");
    if (row) { openLineupPlayer(row.getAttribute("data-mi-player"), row.getAttribute("data-mi-side")); return; }
    // Klick på ett lag i modalhuvudet → stäng matchinfo och låt klicket bubbla
    // vidare till appens globala klickhanterare, som öppnar lag-lådan (samma
    // som klick på ett lag ute på sajten).
    if (e.target.closest && e.target.closest("[data-team-open]")) close();
  }

  /* Öppnar samma spelarmodal som statistiksidan (assets/live.js) för en spelare
     i uppställningen. sideCode ("h"/"a") avgör vilket lag spelaren tillhör. */
  function openLineupPlayer(pid, sideCode) {
    if (!openKey || !window.VMPlayers || !window.VMLive || typeof window.VMLive.openPlayer !== "function") return;
    var p = window.VMPlayers.getPlayerById(pid);
    if (!p) return;
    var info = window.VMApp.describeMatch(openKey);
    if (!info) return;
    var teamObj = sideCode === "h" ? info.home : info.away;
    window.VMLive.openPlayer(p, teamObj || {});
  }

  function open(key) {
    if (!window.VMApp || typeof window.VMApp.describeMatch !== "function") return;
    openKey = key;
    var info = window.VMApp.describeMatch(key);
    if (window.VMAnalytics && info && info.home && info.away) {
      VMAnalytics.trackEvent("match",
        (info.home.sv || info.home.name) + "–" + (info.away.sv || info.away.name));
    }
    // Ej påbörjade matcher landar på redaktionens analys; övriga på händelserna.
    var upcoming = info && !info.live && !info.played && !info.spoiler;
    activeTab = upcoming ? "news" : "events";
    pvRetryCount = 0;
    if (upcoming) {
      // Ladda underlaget till inför-snacket: odds/motor + landsnyheter.
      if (window.VMApp && typeof window.VMApp.ensurePreviewData === "function") {
        try { window.VMApp.ensurePreviewData(function () { if (openKey) renderModal(); }); } catch (e) {}
      }
      fetchTeamNews().then(function () { if (openKey) renderModal(); });
      fetchNewsSummaries().then(function () { if (openKey) renderModal(); });
    }
    if (!info || !info.played) {
      // Trolig/bekräftad startelva för matcher som inte är färdigspelade –
      // täcker även livematcher där ESPN:s officiella lineups dröjer.
      fetchPrelimLineups().then(function () { if (openKey) renderModal(); });
    }
    if (info && info.played) {
      // Facit (efteranalys som jämför prognos med utfall) för spelade slutspelsmatcher.
      fetchMatchReviews().then(function () { if (openKey) renderModal(); });
    }
    var m = ensureModal();
    m.classList.add("open");
    renderModal();
    fetchHighlights().then(function () { if (openKey) renderModal(); });
    fetchDetails().then(function () {
      renderModal();
      schedulePoll();
    });
  }

  function close() {
    openKey = null;
    clearTimeout(pollTimer);
    clearTimeout(pvRetryTimer);
    var m = document.getElementById("matchModal");
    if (m) m.classList.remove("open");
  }

  function onDataUpdated() {
    if (openKey) renderModal();
  }

  /* Spoilerläget slogs på/av i headern – nollställ ev. "visa ändå" och rita om
     den öppna modalen så den speglar det nya läget direkt. */
  function onSpoilerChange() {
    revealed = {};
    if (openKey) renderModal();
  }

  /* ---------- Rendering ---------- */

  var CARD_CLS = { YELLOW: "yellow", RED: "red", YELLOW_RED: "yellow-red" };
  var CARD_TXT = { YELLOW: "Gult kort", RED: "Rött kort", YELLOW_RED: "Andra gula → rött" };

  function minuteLabel(minute, injuryTime) {
    if (minute == null) return "–";
    return minute + (injuryTime ? "+" + injuryTime : "") + "'";
  }

  function statusChip(info, det) {
    if (info.live) {
      // Status från results/fixtures är färskast – detaljfilen kan släpa efter.
      var paused = (info.fixture && info.fixture.status === "PAUSED") ||
        (info.r && info.r.status === "PAUSED") ||
        (det && det.status === "PAUSED");
      if (paused) {
        return '<span class="mi-status live"><span class="live-dot"></span>Halvtid</span>';
      }
      var min = det && det.minute != null ? det.minute : null;
      return '<span class="mi-status live"><span class="live-dot"></span>LIVE' +
        (min != null ? ' · ' + esc(min) + "'" : "") + '</span>';
    }
    if (info.played) {
      var suffix = "";
      if (det && det.duration === "EXTRA_TIME") suffix = " · efter förlängning";
      else if (det && det.duration === "PENALTY_SHOOTOUT") suffix = " · efter straffar";
      else if (!det && info.r && info.r.pw) suffix = " · efter straffar";
      return '<span class="mi-status done">Avslutad' + suffix + '</span>';
    }
    return '<span class="mi-status upcoming">' + esc(info.when.dateLabel + " · " + info.when.time) + '</span>';
  }

  function teamName(team, fallback) {
    if (team && team.sv) return team.sv;
    return fallback || "?";
  }

  /* Lag i modalens huvud – klickbart (öppnar samma lag-låda som på sajten)
     om laget är känt (har iso). Platshållare ("Vinnare Grupp A" etc) förblir
     oklickbara span:ar. */
  function miTeamBox(team, name, side) {
    var body = flagImg(team && team.iso) + '<span class="mi-team-name">' + esc(name) + '</span>';
    if (team && team.iso) {
      return '<button type="button" class="mi-team team-open ' + side + '" data-team-open="' +
        team.iso + '">' + body + '</button>';
    }
    return '<span class="mi-team ' + side + '">' + body + '</span>';
  }

  function scoreOf(info, det) {
    if (info.r && info.r.h !== undefined) return { h: info.r.h, a: info.r.a };
    if (det && det.score && det.score.ft) return det.score.ft;
    return null;
  }

  /** Mål/kort/byten → en kronologisk händelselista. */
  function buildTimeline(det) {
    var ev = [];
    (det.goals || []).forEach(function (g) {
      var sub = [];
      if (g.type === "OWN") sub.push("Självmål");
      if (g.type === "PENALTY") sub.push("Straffmål");
      if (g.assist) sub.push("Assist: " + g.assist);
      ev.push({
        minute: g.minute, injuryTime: g.injuryTime, team: g.team, goal: true,
        icon: '<span class="mi-ic-goal' + (g.type === "OWN" ? " own" : "") + '">⚽</span>',
        main: esc(g.scorer || "Okänd målskytt"),
        detail: esc(sub.join(" · ")),
        score: g.score ? g.score.h + "–" + g.score.a : null
      });
    });
    (det.bookings || []).forEach(function (b) {
      ev.push({
        minute: b.minute, injuryTime: null, team: b.team,
        icon: '<span class="mi-ic-card ' + (CARD_CLS[b.card] || "yellow") + '"></span>',
        main: esc(b.player || "Okänd spelare"),
        detail: esc(CARD_TXT[b.card] || "Kort")
      });
    });
    (det.subs || []).forEach(function (s) {
      ev.push({
        minute: s.minute, injuryTime: null, team: s.team,
        icon: '<span class="mi-ic-sub"><span class="in">▲</span><span class="out">▼</span></span>',
        main: esc(s.in || "?"),
        detail: "Ut: " + esc(s.out || "?")
      });
    });
    ev.sort(function (a, b) {
      var am = (a.minute == null ? 9999 : a.minute) + (a.injuryTime ? a.injuryTime / 100 : 0);
      var bm = (b.minute == null ? 9999 : b.minute) + (b.injuryTime ? b.injuryTime / 100 : 0);
      return am - bm;
    });
    return ev;
  }

  function timelineHtml(info, det, noTitle) {
    var ev = buildTimeline(det);
    if (!ev.length) return "";
    var h = noTitle ? '<div class="mi-timeline">' :
      '<div class="mi-section-title">Matchhändelser</div><div class="mi-timeline">';
    var divs = [{ min: 45, label: "Halvtid" }, { min: 90, label: "Full tid" }];
    ev.forEach(function (e, i) {
      while (divs.length && e.minute != null && e.minute > divs[0].min) {
        var d = divs.shift();
        if (i > 0) {
          var ds = d.min === 45 && det.score && det.score.ht ?
            " " + det.score.ht.h + "–" + det.score.ht.a : "";
          h += '<div class="mi-ev-divider"><span>' + esc(d.label + ds) + '</span></div>';
        }
      }
      // Sidoindelad tidslinje: hemmalagets händelser till vänster, bortalagets
      // speglade till höger, med minuten i mitten. Tydliggör vilket lag varje
      // händelse hör till (annars ser allt ut att hända på ett lags sida).
      var side = e.team === "a" ? "away" : "home";
      var iso = side === "away" ? (info.away && info.away.iso) : (info.home && info.home.iso);
      var flag = iso ? flagImg(iso) : '<span class="mi-ev-flag-ph"></span>';
      var icon = '<span class="mi-ev-ic">' + e.icon + '</span>';
      var body = '<span class="mi-ev-body"><span class="mi-ev-main">' + e.main + '</span>' +
        (e.detail ? '<span class="mi-ev-detail">' + e.detail + '</span>' : '') + '</span>';
      var score = e.score ? '<span class="mi-ev-score">' + esc(e.score) + '</span>' : '';
      var content = side === "away"
        ? score + body + icon + flag
        : flag + icon + body + score;
      h += '<div class="mi-ev ' + side + (e.goal ? " goal" : "") + '">' +
        '<span class="mi-ev-side">' + content + '</span>' +
        '<span class="mi-ev-min">' + esc(minuteLabel(e.minute, e.injuryTime)) + '</span>' +
        '</div>';
    });
    h += "</div>";
    return h;
  }

  /* ---------- Laguppställning (översiktsvy) ---------- */

  function normName(s) {
    if (!s) return "";
    return String(s).toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  /* Namn -> ord (beh\u00e5ller mellanslag) f\u00f6r efternamnsmatchning mot truppen. */
  function normWords(s) {
    return String(s || "").toLowerCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  /* ---------- Lagf\u00e4rger till nummerbrickorna ---------- */

  var DEFAULT_TEAM_COLOR = ["#c41e3a", "#3d6db5"];
  var BG_COLOR = "#122238";                             // --card, d\u00e4r statistik och uppst\u00e4llning visas
  var COLOR_MIN_DIST = 96;                              // min RGB-avst\u00e5nd mellan lagens f\u00e4rger
  var BG_MIN_DIST = 58;                                 // min RGB-avst\u00e5nd fr\u00e5n m\u00f6rk bakgrund
  var COLOR_FALLBACKS = ["#3f8edb", "#e8b400", "#9fb2c4", "#e0212e", "#4a93d4"];

  function teamColors(iso) {
    var m = window.WC && WC.teamColors;
    return (m && iso && m[iso]) || DEFAULT_TEAM_COLOR;
  }
  function hexRgb(hex) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16) || 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function colorDist(a, b) {
    var x = hexRgb(a), y = hexRgb(b);
    var dr = x.r - y.r, dg = x.g - y.g, db = x.b - y.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }
  /* Vit eller m\u00f6rk text beroende p\u00e5 brickans ljushet (YIQ-upplevd ljusstyrka).
     Tr\u00f6skeln 150 ger m\u00f6rk text p\u00e5 ljusa flaggf\u00e4rger (guld, ljusgr\u00e5tt, sand) och
     vit text p\u00e5 de m\u00f6rkare/m\u00e4ttade. */
  function textOn(hex) {
    var c = hexRgb(hex);
    var brightness = (c.r * 299 + c.g * 587 + c.b * 114) / 1000;
    return brightness >= 150 ? "#0a1628" : "#fff";
  }
  function farthest(from, cands) {
    var best = cands[0], bestD = -1;
    cands.forEach(function (c) {
      var d = colorDist(from, c);
      if (d > bestD) { bestD = d; best = c; }
    });
    return { color: best, dist: bestD };
  }
  /* V\u00e4lj en f\u00e4rg som syns mot den m\u00f6rka modalbakgrunden \u2013 annars lagets alternativ
     eller den mest avvikande reservf\u00e4rgen. */
  function visibleOrAlt(color, iso) {
    if (colorDist(color, BG_COLOR) >= BG_MIN_DIST) return color;
    var pair = teamColors(iso);
    if (pair[1] && colorDist(pair[1], BG_COLOR) >= BG_MIN_DIST) return pair[1];
    return farthest(BG_COLOR, pair.concat(COLOR_FALLBACKS)).color;
  }
  /* Hemma f\u00e5r sin prim\u00e4rf\u00e4rg; borta sin prim\u00e4r om den \u00e4r tydligt skild, annars
     sitt alternativ (eller en garanterat avvikande reservf\u00e4rg) s\u00e5 lagen syns is\u00e4r. */
  function matchColors(hIso, aIso) {
    var hc = visibleOrAlt(teamColors(hIso)[0], hIso);
    var aPair = teamColors(aIso);
    var a0 = visibleOrAlt(aPair[0], aIso);
    var a1 = aPair[1] ? visibleOrAlt(aPair[1], aIso) : a0;
    var pick = farthest(hc, [a0, a1]);
    if (pick.dist < COLOR_MIN_DIST) {
      var visibleFallbacks = COLOR_FALLBACKS.filter(function (c) {
        return colorDist(c, BG_COLOR) >= BG_MIN_DIST;
      });
      var fb = farthest(hc, visibleFallbacks.length ? visibleFallbacks : COLOR_FALLBACKS);
      if (fb.dist > pick.dist) pick = fb;
    }
    return { home: hc, away: pick.color };
  }

  /* ---------- Koppla uppst\u00e4llningens spelare till truppen (klickbar profil) ----------
     Uppst\u00e4llningsraderna har bara namn + tr\u00f6jnummer. F\u00f6r att kunna \u00f6ppna samma
     spelarprofil som p\u00e5 statistiksidan matchas de mot truppen (window.VMPlayers)
     p\u00e5 normaliserat namn, sedan efternamn och till sist tr\u00f6jnummer. */

  function squadIndexFor(iso) {
    var idx = { byJersey: {}, byFull: {}, byLast: {} };
    var vp = window.VMPlayers;
    var team = vp && vp.isLoaded() ? vp.getTeamByIso(iso) : null;
    if (!team) return idx;
    (team.players || []).forEach(function (p) {
      if (p.shirt_number != null) idx.byJersey[String(p.shirt_number)] = p;
      var n = normWords(p.name);
      idx.byFull[n] = p;
      var parts = n.split(" ");
      var last = parts[parts.length - 1];
      (idx.byLast[last] = idx.byLast[last] || []).push(p);
    });
    return idx;
  }

  function resolveSquadPlayer(idx, name, jersey) {
    var n = normWords(name);
    if (idx.byFull[n]) return idx.byFull[n];
    var parts = n.split(" ");
    var last = parts[parts.length - 1];
    var cands = idx.byLast[last] || [];
    if (cands.length === 1) return cands[0];
    if (cands.length > 1 && parts.length > 1) {
      var ini = parts[0].charAt(0);
      var hit = cands.filter(function (p) { return normWords(p.name).charAt(0) === ini; });
      if (hit.length === 1) return hit[0];
    }
    if (jersey != null && jersey !== "" && idx.byJersey[String(jersey)]) return idx.byJersey[String(jersey)];
    return null;
  }

  function buildPlayerEvents(det) {
    var map = {};
    function ensure(name) {
      var k = normName(name);
      if (!map[k]) map[k] = { goals: 0, cards: [], subOut: false, subIn: false };
      return map[k];
    }
    (det.goals || []).forEach(function (g) {
      if (g.scorer) ensure(g.scorer).goals++;
    });
    (det.bookings || []).forEach(function (b) {
      if (b.player) ensure(b.player).cards.push(b.card);
    });
    (det.subs || []).forEach(function (s) {
      if (s.out) ensure(s.out).subOut = true;
      if (s.in) ensure(s.in).subIn = true;
    });
    return map;
  }

  /* ---------- Gräsplanen (samma placeringslogik som assets/teamlineups.js) ----------
     Hemmalaget upptar planens nedre halva och anfaller uppåt mot mitten;
     bortalaget speglas i den övre halvan och anfaller nedåt – lagen möts vid
     mittlinjen precis som i vanlig laguppställningsgrafik. */

  var PITCH_BAND_Y = { 0: 90, 1: 72, 2: 59, 3: 45, 4: 31, 5: 14 };

  function pitchBandOf(pos) {
    var p = String(pos || "").toUpperCase();
    if (p === "G" || p === "GK") return 0;
    if (p === "F" || p === "ST" || p.indexOf("CF") >= 0 || p === "LF" || p === "RF") return 5;
    if (p.indexOf("AM") >= 0) return 4;
    if (p.indexOf("DM") >= 0) return 2;
    if (p === "M" || p === "LM" || p === "RM" || p.indexOf("CM") >= 0) return 3;
    if (p === "SW" || p === "LB" || p === "RB" || p.indexOf("CD") >= 0 || p.indexOf("CB") >= 0 || p === "D") return 1;
    return 3;
  }

  function pitchSideOf(pos) {
    var p = String(pos || "").toUpperCase();
    if (p.indexOf("-L") >= 0) return -1;
    if (p.indexOf("-R") >= 0) return 1;
    var c = p.charAt(0);
    if (c === "L") return -2;
    if (c === "R") return 2;
    return 0;
  }

  /* Startelvan → [{p, x, y}] i procent av planens bredd/höjd. mirror=true för
     bortalaget speglar planhalvan så lagen möts vid mittlinjen. */
  function pitchLayout(starters, mirror) {
    var bands = {};
    starters.forEach(function (p, i) {
      var b = pitchBandOf(p.pos);
      (bands[b] = bands[b] || []).push({ p: p, i: i });
    });
    var out = [];
    Object.keys(bands).forEach(function (b) {
      var row = bands[b];
      row.sort(function (a, c) {
        var sa = pitchSideOf(a.p.pos), sc = pitchSideOf(c.p.pos);
        return sa - sc || a.i - c.i;
      });
      var n = row.length;
      var y0 = PITCH_BAND_Y[b] / 100 * 48;
      var y = mirror ? (50 - y0) : (50 + y0);
      row.forEach(function (item, idx) {
        out.push({ p: item.p, x: ((idx + 1) / (n + 1)) * 100, y: y });
      });
    });
    return out;
  }

  function pitchShortName(name) {
    var parts = String(name || "").trim().split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : (parts[0] || "");
  }

  function pitchMarkersHtml(starters, mirror, ctx, evMap) {
    var spots = pitchLayout(starters || [], mirror);
    return spots.map(function (s) {
      var p = s.p;
      var sp = resolveSquadPlayer(ctx.idx, p.name, p.jersey);
      var openAttr = sp ? ' data-mi-player="' + esc(sp.id) + '" data-mi-side="' + ctx.sideCode +
        '" role="button" tabindex="0" title="Visa spelarprofil"' : ' title="' + esc(p.name) + '"';
      var cls = "mi-pitch-marker" + (sp ? " mi-pitch-openable" : "");
      return '<div class="' + cls + '" style="left:' + s.x.toFixed(1) + '%;top:' + s.y.toFixed(1) + '%"' + openAttr + '>' +
        '<span class="mi-pitch-dot" style="background:' + ctx.color + ';color:' + textOn(ctx.color) + '">' +
          esc(p.jersey || "") +
        '</span>' +
        playerBadgesHtml(evMap[normName(p.name)]) +
        '<span class="mi-pitch-name">' + esc(pitchShortName(p.name)) + '</span>' +
      '</div>';
    }).join("");
  }

  function pitchHtml(lu, evMap, hCtx, aCtx) {
    var markers = pitchMarkersHtml(lu.h.starters, false, hCtx, evMap) +
      pitchMarkersHtml(lu.a.starters, true, aCtx, evMap);
    return '<div class="mi-pitch"><div class="mi-pitch-lines" aria-hidden="true"></div>' + markers + '</div>';
  }

  function playerBadgesHtml(events) {
    if (!events) return "";
    var parts = [];
    if (events.warn) {
      parts.push('<span class="mi-pl-ic warn ' + esc(events.warn.cls) +
        '" title="' + esc(events.warn.text) + '">!</span>');
    }
    var g;
    for (g = 0; g < events.goals; g++) {
      parts.push('<span class="mi-pl-ic goal" title="Mål">⚽</span>');
    }
    events.cards.forEach(function (c) {
      var cls = CARD_CLS[c] || "yellow";
      parts.push('<span class="mi-pl-ic card ' + cls + '" title="' + esc(CARD_TXT[c] || "Kort") + '"></span>');
    });
    if (events.subOut) parts.push('<span class="mi-pl-ic sub out" title="Utbytt">▼</span>');
    if (events.subIn) parts.push('<span class="mi-pl-ic sub in" title="Inbytt">▲</span>');
    if (!parts.length) return "";
    return '<span class="mi-pl-badges">' + parts.join("") + "</span>";
  }

  function lineupPlayerRow(p, home, evMap, ctx) {
    var ev = evMap[normName(p.name)];
    var badges = playerBadgesHtml(ev);
    var sp = resolveSquadPlayer(ctx.idx, p.name, p.jersey);
    var openAttr = sp ? ' data-mi-player="' + esc(sp.id) + '" data-mi-side="' + ctx.sideCode +
      '" role="button" tabindex="0" title="Visa spelarprofil"' : "";
    var cls = "mi-pl-row " + (home ? "home" : "away") + (sp ? " mi-pl-openable" : "");
    var nr = '<span class="mi-pl-nr" style="background:' + ctx.color + ";color:" + textOn(ctx.color) + '">' +
      esc(p.jersey || "") + "</span>";
    var name = '<span class="mi-pl-name">' + esc(p.name) + "</span>";
    var body = home ? (nr + name + badges) : (badges + name + nr);
    return '<div class="' + cls + '"' + openAttr + ">" + body + "</div>";
  }

  function lineupPairRows(hPlayers, aPlayers, evMap, hCtx, aCtx) {
    var max = Math.max(hPlayers.length, aPlayers.length);
    var h = "";
    var i;
    for (i = 0; i < max; i++) {
      h += '<div class="mi-pl-pair">';
      if (i < hPlayers.length) h += lineupPlayerRow(hPlayers[i], true, evMap, hCtx);
      else h += '<div class="mi-pl-row home empty"></div>';
      if (i < aPlayers.length) h += lineupPlayerRow(aPlayers[i], false, evMap, aCtx);
      else h += '<div class="mi-pl-row away empty"></div>';
      h += "</div>";
    }
    return h;
  }

  function coachOf(teamObj) {
    if (!teamObj || !teamObj.iso || !window.VMPlayers) return null;
    if (!window.VMPlayers.isLoaded()) {
      // Truppdatan förladdas normalt – men säkra omrendering om den dröjer.
      window.VMPlayers.load().then(function () {
        if (openKey) renderModal();
      }).catch(function () {});
      return null;
    }
    var t = window.VMPlayers.getTeamByIso(teamObj.iso);
    return t && t.coach ? t.coach : null;
  }

  /* I prelim-läge (trolig elva före avspark) finns inga matchhändelser att
     visa – i stället märks spelare med skade-/avstängningsstatus (ur
     window.VMPlayers, data/wc2026_player_status.json) med en varningsprick. */
  function buildStatusWarns(lu, hCtx, aCtx) {
    var map = {};
    if (!window.VMPlayers || !window.VMPlayers.isLoaded()) return map;
    function addSide(side, ctx) {
      (side.starters || []).concat(side.bench || []).forEach(function (p) {
        var sp = resolveSquadPlayer(ctx.idx, p.name, p.jersey);
        var st = sp ? window.VMPlayers.getPlayerStatus(sp.id) : null;
        if (st) {
          map[normName(p.name)] = { goals: 0, cards: [], subOut: false, subIn: false, warn: st };
        }
      });
    }
    addSide(lu.h, hCtx);
    addSide(lu.a, aCtx);
    return map;
  }

  function lineupsOverviewHtml(info, det, prelimMode) {
    var lu = det && det.lineups;
    if (!lu || !lu.h || !lu.a) return "";
    var hIso = info.home && info.home.iso;
    var aIso = info.away && info.away.iso;
    var cols = matchColors(hIso, aIso);
    var hCtx = { color: cols.home, sideCode: "h", idx: squadIndexFor(hIso) };
    var aCtx = { color: cols.away, sideCode: "a", idx: squadIndexFor(aIso) };
    var evMap = prelimMode ? buildStatusWarns(lu, hCtx, aCtx) : buildPlayerEvents(det);
    var hCoach = coachOf(info.home);
    var aCoach = coachOf(info.away);
    var h = '<div class="mi-lineups-overview">';
    h += '<div class="mi-pl-form-row">' +
      '<span class="mi-pl-col-head home">' + flagImg(info.home && info.home.iso) +
        '<span>' + esc(teamName(info.home, info.homeLabel)) + "</span>" +
        (lu.h.formation ? '<span class="mi-pl-form">' + esc(lu.h.formation) + "</span>" : "") +
      "</span>" +
      '<span class="mi-pl-col-head away">' +
        (lu.a.formation ? '<span class="mi-pl-form">' + esc(lu.a.formation) + "</span>" : "") +
        "<span>" + esc(teamName(info.away, info.awayLabel)) + "</span>" +
        flagImg(info.away && info.away.iso) +
      "</span></div>";
    h += pitchHtml(lu, evMap, hCtx, aCtx);
    h += '<div class="mi-pl-pair coaches">' +
      '<div class="mi-pl-coach home">' +
        '<span class="mi-pl-coach-tag">FK</span>' +
        '<span class="mi-pl-coach-name">' + esc(hCoach || "–") + "</span>" +
      "</div>" +
      '<div class="mi-pl-coach away">' +
        '<span class="mi-pl-coach-name">' + esc(aCoach || "–") + "</span>" +
        '<span class="mi-pl-coach-tag">FK</span>' +
      "</div></div>";
    var benchH = lu.h.bench || [];
    var benchA = lu.a.bench || [];
    if (benchH.length || benchA.length) {
      h += '<div class="mi-pl-section-label">Avbytare</div>';
      h += lineupPairRows(benchH, benchA, evMap, hCtx, aCtx);
    }
    h += "</div>";
    return h;
  }

  /* Trolig/bekräftad startelva före avspark (data/lineups_prelim.json).
     Återanvänder gräsplans-renderingen ovan med en tydlig banner om att
     elvan är preliminär tills den officiella laguppställningen släpps. */
  function prelimLineupsHtml(info, pre) {
    var confirmed = pre.status === "confirmed";
    var det = { lineups: { h: pre.h, a: pre.a }, goals: [], bookings: [], subs: [] };
    var body = lineupsOverviewHtml(info, det, !confirmed);
    if (!body) return emptyHintForTab("lineups", info);
    var upd = pre.updatedAt ? pvTimeAgo(pre.updatedAt) : "";
    var h = '<div class="mi-prelim">';
    h += '<div class="mi-prelim-note' + (confirmed ? " confirmed" : "") + '">' +
      '<span class="mi-prelim-chip">' + (confirmed ? "Bekräftade elvor" : "Troliga elvor") + '</span>' +
      '<span class="mi-prelim-text">' +
        (confirmed
          ? "De officiella startelvorna är inrapporterade."
          : "Preliminär bedömning – de officiella elvorna släpps ungefär en timme före avspark.") +
        (upd ? ' <span class="mi-prelim-upd">Uppdaterad ' + esc(upd) + ".</span>" : "") +
      '</span></div>';
    h += body;
    h += '<div class="mi-note">Källa: 365Scores.' +
      (confirmed ? "" : " Spelare med skade- eller avstängningsstatus markeras med en varningsprick.") +
      '</div>';
    h += "</div>";
    return h;
  }

  /* ---------- Matchstatistik ---------- */

  var STAT_LABELS = {
    possessionPct: "Bollinnehav",
    totalShots: "Skott",
    shotsOnTarget: "Skott på mål",
    wonCorners: "Hörnor",
    foulsCommitted: "Fouls",
    offsides: "Offside",
    saves: "Räddningar",
    totalPasses: "Passningar",
    passPct: "Passningssäkerhet",
    yellowCards: "Gula kort",
    redCards: "Röda kort"
  };

  function statsHtml(det, info, noTitle) {
    var stats = (det && det.stats) || [];
    if (!stats.length) return "";
    var hIso = info && info.home && info.home.iso;
    var aIso = info && info.away && info.away.iso;
    var cols = matchColors(hIso, aIso);
    var h = noTitle ? '<div class="mi-stats">' :
      '<div class="mi-section-title">Statistik</div><div class="mi-stats">';
    stats.forEach(function (s) {
      var label = STAT_LABELS[s.key];
      if (!label) return;
      var hv = parseFloat(s.h);
      var av = parseFloat(s.a);
      if (!isFinite(hv)) hv = 0;
      if (!isFinite(av)) av = 0;
      var pct = hv + av > 0 ? Math.round((hv / (hv + av)) * 100) : 50;
      var awayPct = 100 - pct;
      h += '<div class="mi-stat">' +
        '<div class="mi-stat-row">' +
          '<span class="mi-stat-val">' + esc(s.h) + '</span>' +
          '<span class="mi-stat-lbl">' + esc(label) + '</span>' +
          '<span class="mi-stat-val">' + esc(s.a) + '</span>' +
        '</div>' +
        '<div class="mi-stat-bar">' +
          '<span class="home" style="width:' + pct + '%;background:' + cols.home + '"></span>' +
          '<span class="away" style="width:' + awayPct + '%;background:' + cols.away + '"></span>' +
        '</div>' +
        '</div>';
    });
    h += "</div>";
    return h;
  }

  function infoRow(label, val) {
    if (val === null || val === undefined || val === "") return "";
    return '<div class="mi-row"><span class="mi-row-lbl">' + esc(label) + '</span>' +
      '<span class="mi-row-val">' + val + '</span></div>';
  }

  function pendingVal(text) {
    return '<span class="mi-row-pending">' + esc(text) + "</span>";
  }

  function factsHtml(info, det) {
    var notStarted = !info.live && !info.played;
    var rows = "";
    var venue = (det && det.venue) || (info.venue ? info.venue.stadium + ", " + info.venue.city : null);
    var referee = det && det.referee ? esc(det.referee) : null;
    var attendance = det && det.attendance ? esc(Number(det.attendance).toLocaleString("sv-SE")) : null;

    if (notStarted) {
      // Visa samma rader som för spelade matcher, men förklara kort vad som
      // ännu inte är känt så det inte ser tomt ut före avspark.
      rows += infoRow("Avspark", esc(info.when.dateLabel + " · " + info.when.time));
      rows += infoRow("Arena", venue ? esc(venue) : pendingVal("Meddelas närmare avspark"));
      rows += infoRow("Domare", referee || pendingVal("Tillsätts inför avspark"));
      rows += infoRow("Publik", attendance || pendingVal("Klar efter avspark"));
    } else {
      rows += infoRow("Arena", venue ? esc(venue) : null);
      rows += infoRow("Domare", referee);
      rows += infoRow("Publik", attendance);
    }
    if (info.channel) {
      rows += infoRow("TV", '<span class="cal-tv ' + (info.channel === "SVT" ? "svt" : "tv4") + '">' +
        esc(info.channel) + "</span>");
    }
    if (!rows) return "";
    return '<div class="mi-section-title">Om matchen</div><div class="mi-facts">' + rows + "</div>";
  }

  /* ====================================================================
     INFÖR-SNACK (fliken "Inför" för matcher som ännu inte spelats)
     Dataunderlaget kommer från app.js (VMApp.matchPreview): marknadens 1X2,
     vinstchans, form, tabelläge, FIFA-rank och VM-vinstchanser ur samma
     motor som slutspelsträdet. Nyheterna från lägren (data/team_news.json –
     respektive lands egna medier via Google Nyheter, svenska sammanfattningar
     i title_sv) driver den egna fliken "Redaktionens analys"; Inför visar bara en teaser.
  ==================================================================== */

  function fmtPctSv(p, decimals) {
    if (p == null || !isFinite(p)) return "–";
    var v = p * 100;
    if (decimals == null) decimals = v < 9.95 && v > 0 ? 1 : 0;
    var s = v.toFixed(decimals).replace(".", ",");
    // "0,0 %" för en liten men existerande chans ser död ut – visa "<0,1 %".
    if (parseFloat(s.replace(",", ".")) === 0 && p > 0) return "<0,1 %";
    return s + " %";
  }

  function pvNum(n) { return n == null ? "–" : String(n); }

  /* Rita om inför-snacket när asynkron data (odds/motor/trupp) blivit klar.
     Kapat antal försök så en trasig datakälla inte pollar för evigt. */
  function schedulePreviewRetry() {
    clearTimeout(pvRetryTimer);
    if (!openKey || pvRetryCount >= 12) return;
    pvRetryTimer = setTimeout(function () {
      if (!openKey || activeTab !== "preview") return;
      pvRetryCount++;
      renderModal();
    }, 1200);
  }

  /* ---------- Favoritbanner ---------- */

  function pvVerdictHtml(info, pv) {
    var hName = teamName(info.home, info.homeLabel);
    var aName = teamName(info.away, info.awayLabel);
    var pH = null, pA = null, sub = "";
    if (pv.winP != null) {                       // slutspel: chans att gå vidare
      pH = pv.winP; pA = 1 - pv.winP;
      sub = "chans att gå vidare";
    } else if (pv.rp) {                          // gruppspel: chans att vinna matchen
      pH = pv.rp.h; pA = pv.rp.a;
      sub = "chans att vinna matchen";
    }
    if (pH == null) return "";
    var even = Math.abs(pH - pA) < 0.07;
    var favHome = pH >= pA;
    var fav = favHome ? info.home : info.away;
    var favName = favHome ? hName : aName;
    var p = Math.max(pH, pA);
    var main, subTxt;
    if (even) {
      main = flagImg(info.home && info.home.iso) + '<span>Jämn match</span>' + flagImg(info.away && info.away.iso);
      subTxt = esc(hName) + " " + fmtPctSv(pH) + " · " + esc(aName) + " " + fmtPctSv(pA) + " – " + sub;
    } else {
      main = flagImg(fav && fav.iso) + '<span>' + esc(favName) + ' är favorit</span>';
      subTxt = fmtPctSv(p) + " " + sub + " enligt spelmarknaden";
    }
    return '<div class="mi-pv-verdict">' +
      '<span class="mi-pv-eyebrow">Inför matchen</span>' +
      '<div class="mi-pv-verdict-main">' + main + '</div>' +
      '<div class="mi-pv-verdict-sub">' + subTxt + '</div>' +
      '</div>';
  }

  /* ---------- Oddsbar (1 / X / 2) ---------- */

  function pvOddsHtml(info, pv) {
    if (!pv.rp) return "";
    var cols = matchColors(info.home && info.home.iso, info.away && info.away.iso);
    var hName = teamName(info.home, info.homeLabel);
    var aName = teamName(info.away, info.awayLabel);
    var tot = pv.rp.h + pv.rp.x + pv.rp.a;
    if (!(tot > 0)) return "";
    var wh = pv.rp.h / tot * 100, wx = pv.rp.x / tot * 100, wa = pv.rp.a / tot * 100;
    var h = '<div class="mi-section-title">Så tippar spelmarknaden</div>' +
      '<div class="mi-pv-odds">' +
      '<div class="mi-pv-odds-labels">' +
        '<span class="mi-pv-odds-lb home"><span class="mi-pv-dot" style="background:' + cols.home + '"></span>' +
          esc(hName) + ' <strong>' + fmtPctSv(pv.rp.h, 0) + '</strong></span>' +
        '<span class="mi-pv-odds-lb draw">Oavgjort <strong>' + fmtPctSv(pv.rp.x, 0) + '</strong></span>' +
        '<span class="mi-pv-odds-lb away"><strong>' + fmtPctSv(pv.rp.a, 0) + '</strong> ' + esc(aName) +
          '<span class="mi-pv-dot" style="background:' + cols.away + '"></span></span>' +
      '</div>' +
      '<div class="mi-pv-odds-bar">' +
        '<span style="width:' + wh.toFixed(1) + '%;background:' + cols.home + '"></span>' +
        '<span class="draw" style="width:' + wx.toFixed(1) + '%"></span>' +
        '<span style="width:' + wa.toFixed(1) + '%;background:' + cols.away + '"></span>' +
      '</div>';
    if (pv.winP != null) {
      h += '<div class="mi-pv-odds-note">Oavgjort efter 90 minuter avgörs med förlängning och straffar – ' +
        'total chans att gå vidare: ' + esc(hName) + ' <strong>' + fmtPctSv(pv.winP, 0) + '</strong> · ' +
        esc(aName) + ' <strong>' + fmtPctSv(1 - pv.winP, 0) + '</strong></div>';
    }
    h += '</div>';
    return h;
  }

  /* ---------- Form (senaste VM-matcherna) ---------- */

  function pvFormPills(side) {
    var items = (side && side.form) || [];
    if (!items.length) return '<span class="mi-pv-form-empty">Första VM-matchen</span>';
    return items.slice(-5).map(function (it) {
      var cls = it.res === "V" ? "v" : it.res === "F" ? "f" : "o";
      var tip = it.res + " " + it.gf + "–" + it.ga + (it.pen ? " (straffar)" : "") +
        " mot " + (it.opp ? it.opp.sv : "?") + " · " + it.label;
      return '<span class="mi-pv-pill ' + cls + '" title="' + esc(tip) + '">' + it.res + '</span>';
    }).join("");
  }

  function pvFormRecent(side) {
    var items = (side && side.form) || [];
    return items.slice(-3).reverse().map(function (it) {
      return '<span class="mi-pv-form-line">' +
        '<span class="mi-pv-form-score ' + (it.res === "V" ? "v" : it.res === "F" ? "f" : "o") + '">' +
          it.gf + "–" + it.ga + '</span> ' +
        flagImg(it.opp && it.opp.iso) + '<span class="mi-pv-form-opp">' + esc(it.opp ? it.opp.sv : "?") + '</span>' +
        (it.pen ? '<span class="mi-pv-form-pen">straffar</span>' : '') +
        '</span>';
    }).join("");
  }

  function pvFormHtml(info, pv) {
    if (!pv.home && !pv.away) return "";
    return '<div class="mi-section-title">Formen i VM</div>' +
      '<div class="mi-pv-form">' +
      '<div class="mi-pv-form-col home">' +
        '<div class="mi-pv-form-head">' + flagImg(info.home && info.home.iso) +
          '<span>' + esc(teamName(info.home, info.homeLabel)) + '</span></div>' +
        '<div class="mi-pv-pills">' + pvFormPills(pv.home) + '</div>' +
        '<div class="mi-pv-form-list">' + pvFormRecent(pv.home) + '</div>' +
      '</div>' +
      '<div class="mi-pv-form-col away">' +
        '<div class="mi-pv-form-head">' + flagImg(info.away && info.away.iso) +
          '<span>' + esc(teamName(info.away, info.awayLabel)) + '</span></div>' +
        '<div class="mi-pv-pills">' + pvFormPills(pv.away) + '</div>' +
        '<div class="mi-pv-form-list">' + pvFormRecent(pv.away) + '</div>' +
      '</div>' +
      '</div>';
  }

  /* ---------- Lagen i siffror (speglade jämförelserader) ----------
     Stapellängd = styrka: för "lägre är bättre"-mått (FIFA-rank, insläppta)
     viktas staplarna inverterat så att längre alltid betyder bättre. */

  function pvCmpRow(label, hTxt, aTxt, hW, aW, cols) {
    var tot = (hW || 0) + (aW || 0);
    var pct = tot > 0 ? Math.round((hW / tot) * 100) : 50;
    return '<div class="mi-stat">' +
      '<div class="mi-stat-row">' +
        '<span class="mi-stat-val">' + hTxt + '</span>' +
        '<span class="mi-stat-lbl">' + esc(label) + '</span>' +
        '<span class="mi-stat-val">' + aTxt + '</span>' +
      '</div>' +
      '<div class="mi-stat-bar">' +
        '<span class="home" style="width:' + pct + '%;background:' + cols.home + '"></span>' +
        '<span class="away" style="width:' + (100 - pct) + '%;background:' + cols.away + '"></span>' +
      '</div>' +
      '</div>';
  }

  function pvGoalsOf(side) {
    var gf = 0, ga = 0;
    ((side && side.form) || []).forEach(function (it) { gf += it.gf; ga += it.ga; });
    return { gf: gf, ga: ga, n: ((side && side.form) || []).length };
  }

  function pvCompareHtml(info, pv) {
    if (!pv.home || !pv.away) return "";
    var cols = matchColors(info.home && info.home.iso, info.away && info.away.iso);
    var H = pv.home, A = pv.away;
    var rows = "";
    rows += pvCmpRow("FIFA-ranking",
      H.fifa < 999 ? "#" + H.fifa : "–", A.fifa < 999 ? "#" + A.fifa : "–",
      H.fifa < 999 ? 1 / H.fifa : 0, A.fifa < 999 ? 1 / A.fifa : 0, cols);
    if (H.rounds && A.rounds) {
      rows += pvCmpRow("Chans att vinna VM",
        fmtPctSv(H.rounds.win), fmtPctSv(A.rounds.win),
        H.rounds.win, A.rounds.win, cols);
      if (pv.kind === "group" && ((H.rounds.r32 || 0) < 0.999 || (A.rounds.r32 || 0) < 0.999)) {
        rows += pvCmpRow("Chans att nå slutspel",
          fmtPctSv(H.rounds.r32), fmtPctSv(A.rounds.r32),
          H.rounds.r32, A.rounds.r32, cols);
      }
    }
    var hg = pvGoalsOf(H), ag = pvGoalsOf(A);
    if (hg.n || ag.n) {
      rows += pvCmpRow("Gjorda mål i VM", pvNum(hg.gf), pvNum(ag.gf), hg.gf, ag.gf, cols);
      rows += pvCmpRow("Insläppta mål", pvNum(hg.ga), pvNum(ag.ga),
        1 / (1 + hg.ga), 1 / (1 + ag.ga), cols);
    }
    if (pv.kind === "group" && H.group && A.group) {
      rows += pvCmpRow("Poäng i gruppen", pvNum(H.group.pts), pvNum(A.group.pts),
        H.group.pts, A.group.pts, cols);
    }
    if (!rows) return "";
    var posLine = "";
    if (H.group && A.group) {
      posLine = '<div class="mi-pv-posline">' +
        flagImg(info.home && info.home.iso) + '<span>' + H.group.rank + ':a i grupp ' + H.group.letter +
          ' (' + H.group.pts + ' p, ' + (H.group.gd >= 0 ? "+" : "−") + Math.abs(H.group.gd) + ')</span>' +
        '<span class="mi-pv-posline-sep">·</span>' +
        flagImg(info.away && info.away.iso) + '<span>' + A.group.rank + ':a i grupp ' + A.group.letter +
          ' (' + A.group.pts + ' p, ' + (A.group.gd >= 0 ? "+" : "−") + Math.abs(A.group.gd) + ')</span>' +
        '</div>';
    }
    return '<div class="mi-section-title">Lagen i siffror</div>' +
      '<div class="mi-stats mi-pv-compare">' + rows + '</div>' + posLine;
  }

  /* ---------- "Vinnaren möter …" (slutspel) ---------- */

  function pvKoNextHtml(pv) {
    if (!pv.koNext) return "";
    var opp = pv.koNext.opp
      ? flagImg(pv.koNext.opp.iso) + '<strong>' + esc(pv.koNext.opp.sv) + '</strong>'
      : '<strong>' + esc(pv.koNext.oppLabel || "?") + '</strong>';
    return '<div class="mi-pv-konext">Vinnaren möter ' + opp +
      ' i ' + esc(String(pv.koNext.round).toLowerCase()) + '</div>';
  }

  /* ---------- Spelare att hålla ögonen på (VM-statistik) ---------- */

  function pvKeyPlayers(teamObj, sideCode) {
    var vp = window.VMPlayers, ps = window.VMPlayerStats;
    if (!teamObj || !teamObj.iso || !vp || !vp.isLoaded() || !ps || !ps.getPlayerStats) return [];
    var t = vp.getTeamByIso(teamObj.iso);
    if (!t) return [];
    var rows = [];
    (t.players || []).forEach(function (p) {
      var r = null;
      try { r = ps.getPlayerStats(p.id); } catch (e) {}
      if (r && r.played) rows.push({ p: p, r: r });
    });
    rows.sort(function (a, b) {
      return (b.r.points - a.r.points) ||
        ((b.r.rating || 0) - (a.r.rating || 0)) ||
        (b.r.min - a.r.min);
    });
    return rows.slice(0, 2).map(function (e) {
      var bits = [];
      if (e.r.goals) bits.push(e.r.goals + " mål");
      if (e.r.assists) bits.push(e.r.assists + " assist");
      if (e.r.rating != null && e.r.ratingQ) bits.push("betyg " + e.r.rating.toFixed(1).replace(".", ","));
      if (!bits.length) bits.push(Math.round(e.r.min) + " min spelade");
      return '<div class="mi-pv-item mi-pl-openable" data-mi-player="' + esc(e.p.id) +
        '" data-mi-side="' + sideCode + '" role="button" tabindex="0" title="Visa spelarprofil">' +
        '<span class="mi-pv-item-name">' +
          (e.p.shirt_number != null ? '<span class="mi-pv-nr">' + e.p.shirt_number + '</span>' : '') +
          esc(e.p.name) + '</span>' +
        '<span class="mi-pv-item-sub">' + esc(bits.join(" · ")) + '</span>' +
        '</div>';
    });
  }

  function pvKeyPlayersHtml(info) {
    var hi = pvKeyPlayers(info.home, "h");
    var ai = pvKeyPlayers(info.away, "a");
    if (!hi.length && !ai.length) return "";
    function col(items, teamObj, name) {
      return '<div class="mi-pv-col">' +
        '<div class="mi-pv-col-head">' + flagImg(teamObj && teamObj.iso) + '<span>' + esc(name) + '</span></div>' +
        (items.length ? items.join("") : '<div class="mi-pv-note">Ingen VM-statistik ännu.</div>') +
        '</div>';
    }
    return '<div class="mi-section-title">Spelare att hålla ögonen på</div>' +
      '<div class="mi-pv-cols">' +
      col(hi, info.home, teamName(info.home, info.homeLabel)) +
      col(ai, info.away, teamName(info.away, info.awayLabel)) +
      '</div>';
  }

  /* ---------- Nyheter från lägren (respektive lands medier) ---------- */

  var SV_MON = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

  function pvTimeAgo(iso) {
    var t = iso ? new Date(iso).getTime() : NaN;
    if (!isFinite(t)) return "";
    var diff = Date.now() - t;
    if (diff < 0) diff = 0;
    var min = Math.round(diff / 60000);
    if (min < 60) return "för " + Math.max(1, min) + " min sedan";
    var h = Math.round(min / 60);
    if (h < 24) return "för " + h + " tim sedan";
    var d = Math.round(h / 24);
    if (d === 1) return "i går";
    if (d < 7) return "för " + d + " dagar sedan";
    var dt = new Date(t);
    return dt.getDate() + " " + SV_MON[dt.getMonth()];
  }

  function newsItemsOf(teamObj) {
    var entry = teamObj && teamObj.iso && teamNews ? teamNews[teamObj.iso] : null;
    return (entry && entry.items) || [];
  }

  /* Ett nyhetskort: svensk sammanfattning + källchip (den inhemska tidningen)
     och tidsangivelse. Originalrubriken ligger som tooltip; saknas översättning
     visas originalet med dir="auto" (t.ex. arabiska/persiska rubriker). */
  function newsItemHtml(it, accent) {
    var sv = it.title_sv || "";
    var text = sv || it.title || "";
    var dirAttr = sv ? "" : ' dir="auto"';
    var tip = sv && it.title && it.title !== sv
      ? ' title="Originalrubrik' + (it.source ? " (" + esc(it.source) + ")" : "") + ": " + esc(it.title) + '"'
      : "";
    var ago = pvTimeAgo(it.published);
    return '<a class="mi-news-item" style="--news-accent:' + esc(accent) + '" href="' + esc(it.url) +
      '" target="_blank" rel="noopener noreferrer"' + tip + '>' +
      '<span class="mi-news-sum"' + dirAttr + '>' + esc(text) + '</span>' +
      '<span class="mi-news-meta">' +
        (it.source ? '<span class="mi-news-src">' + esc(it.source) + '</span>' : '') +
        (ago ? '<span class="mi-news-time">' + esc(ago) + '</span>' : '') +
        '<span class="mi-news-ext" aria-hidden="true">↗</span>' +
      '</span></a>';
  }

  function newsColHtml(teamObj, name, accent) {
    var items = newsItemsOf(teamObj);
    var body = items.length
      ? items.slice(0, 5).map(function (it) { return newsItemHtml(it, accent); }).join("")
      : '<div class="mi-pv-note">Inga färska nyheter från lägret just nu.</div>';
    return '<div class="mi-news-col">' +
      '<div class="mi-pv-col-head">' + flagImg(teamObj && teamObj.iso) + '<span>' + esc(name) + '</span></div>' +
      body + '</div>';
  }

  /* ---------- Avbräck i nyhetsfliken: vem spelar inte / är osäker? ---------- */

  /* Rader för ett lag: spelare med skade-/avstängningsstatus, "spelar inte"
     före frågetecken. Varje rad har orsak + källänk: ESPN-matchsidan för
     avstängningar (beräknade ur matchdatan), nyhetsartikeln för skador. */
  function availRowsHtml(teamObj, sideCode) {
    var vp = window.VMPlayers;
    if (!teamObj || !teamObj.iso || !vp || !vp.isLoaded()) return [];
    var t = vp.getTeamByIso(teamObj.iso);
    if (!t) return [];
    var rows = [];
    (t.players || []).forEach(function (p) {
      var st = vp.getPlayerStatus ? vp.getPlayerStatus(p.id) : null;
      if (st) rows.push({ p: p, st: st });
    });
    rows.sort(function (a, b) {
      var r = (a.st.availability === "out" ? 0 : 1) - (b.st.availability === "out" ? 0 : 1);
      return r || a.p.name.localeCompare(b.p.name, "sv");
    });
    return rows.map(function (e) {
      var p = e.p, st = e.st;
      var meta = "";
      if (st.source && st.source.url) {
        meta += '<a class="mi-avail-src" href="' + esc(st.source.url) +
          '" target="_blank" rel="noopener noreferrer" title="Öppna källan i ny flik">' +
          esc(st.source.name || "Källa") + ' <span aria-hidden="true">↗</span></a>';
      } else if (st.source && st.source.name) {
        meta += '<span class="mi-avail-src is-plain">' + esc(st.source.name) + '</span>';
      }
      var ago = pvTimeAgo(st.updated);
      if (ago) meta += '<span class="mi-avail-time">' + esc(ago) + '</span>';
      return '<div class="mi-avail-item mi-pl-openable" data-mi-player="' + esc(p.id) +
        '" data-mi-side="' + sideCode + '" role="button" tabindex="0" title="Visa spelarprofil">' +
        '<div class="mi-avail-head">' +
          '<span class="mi-pv-item-name">' +
            (p.shirt_number != null ? '<span class="mi-pv-nr">' + p.shirt_number + '</span>' : '') +
            esc(p.name) + '</span>' +
          '<span class="pstat pstat--' + esc(st.cls) + '"><span class="pstat-dot"></span>' + esc(st.label) + '</span>' +
        '</div>' +
        (st.detail ? '<div class="mi-avail-detail">' + esc(st.detail) + '</div>' : '') +
        (meta ? '<div class="mi-avail-meta">' + meta + '</div>' : '') +
        '</div>';
    });
  }

  function availSectionHtml(info) {
    var vp = window.VMPlayers;
    if (!vp) return "";
    if (!vp.isLoaded()) {
      vp.load().then(function () { if (openKey) renderModal(); }).catch(function () {});
      return "";
    }
    // Visa sektionen först när statusdata över huvud taget finns, så att en
    // trasig/ännu inte byggd statusfil inte ger ett falskt "alla spelar".
    if (!vp.statusCount || !vp.statusCount()) return "";
    var hi = availRowsHtml(info.home, "h");
    var ai = availRowsHtml(info.away, "a");
    var h = '<div class="mi-avail">' +
      '<div class="mi-section-title">Avbräck &amp; frågetecken inför matchen</div>';
    if (!hi.length && !ai.length) {
      h += '<div class="mi-pv-note">Inga kända avstängningar, skador eller frågetecken i något av lagen.</div>';
    } else {
      var col = function (items, teamObj, name) {
        return '<div class="mi-news-col">' +
          '<div class="mi-pv-col-head">' + flagImg(teamObj && teamObj.iso) + '<span>' + esc(name) + '</span></div>' +
          (items.length ? items.join("") : '<div class="mi-pv-note">Inga kända avbräck.</div>') +
          '</div>';
      };
      h += '<div class="mi-news-cols mi-avail-cols">' +
        col(hi, info.home, teamName(info.home, info.homeLabel)) +
        col(ai, info.away, teamName(info.away, info.awayLabel)) +
        '</div>';
    }
    h += '</div>';
    return h;
  }

  /* ---------- Fliken "Redaktionens analys" ---------- */

  /* Inline-markup i sammanfattningarna (artikelstil). Texten skrivs för hand
     med tre enkla markörer och renderas här:
       **fet**         → nyckelnamn/avgörande fakta
       *kursiv*        → direkta citat och smeknamn
       [[3]] / [[3,4]] → upphöjd källhänvisning à la forskningsartikel; siffran
                         länkar till referens nr 3 (respektive 3 och 4) i listan
                         längst ner och öppnar artikeln i ny flik.
     Escapar först (så handtexten aldrig kan injicera HTML), därefter appliceras
     markörerna – de överlever escapingen eftersom * och [ inte escapas. */
  function miInlineNews(text, refs) {
    refs = refs || [];
    var out = esc(text == null ? "" : String(text));
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    out = out.replace(/\[\[\s*([\d\s,]+?)\s*\]\]/g, function (m, nums) {
      var links = nums.split(",").map(function (s) {
        var i = parseInt(s, 10);
        var r = i && refs[i - 1];
        if (!r || !r.url) return null;
        return '<a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer" title="' +
          esc("Källa: " + (r.source || "")) + '">' + i + "</a>";
      }).filter(Boolean);
      return links.length ? '<sup class="mi-cite">' + links.join('<span class="mi-cite-sep">,</span>') + "</sup>" : "";
    });
    return out;
  }

  /* Redaktionens analys i artikelform: rubrik, ingress, fet/kursiv och upphöjda
     källhänvisningar som väger samman läget i båda lägren, följt av en tydlig
     prognos (troligt slutresultat + brasklapp) och den numrerade referenslistan
     längst ner (data/news_summaries.json). */
  function newsSummaryHtml(sum) {
    var refs = sum.references || [];
    var h = '<div class="mi-news-summary">';
    if (sum.headline) h += '<h3 class="mi-news-headline">' + esc(sum.headline) + "</h3>";
    if (sum.lead) h += '<p class="mi-news-lead">' + miInlineNews(sum.lead, refs) + "</p>";
    sum.paragraphs.forEach(function (p) { h += "<p>" + miInlineNews(p, refs) + "</p>"; });
    h += "</div>";
    if (sum.prediction) {
      h += '<div class="mi-news-verdict">' +
        '<div class="mi-news-verdict-lb">Redaktionens dom</div>' +
        '<div class="mi-news-verdict-score">' + esc(sum.prediction) + '</div>' +
        (sum.predictionNote
          ? '<div class="mi-news-verdict-note">' + esc(sum.predictionNote) + '</div>'
          : "") +
        '</div>';
    }
    if (refs.length) {
      h += '<div class="mi-news-refs">' +
        '<div class="mi-section-title">Referenser</div>' +
        '<div class="mi-news-ref-list">';
      refs.forEach(function (r, i) {
        if (!r || !r.url) return;
        h += '<a class="mi-ref" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="mi-ref-num">' + (i + 1) + '</span>' +
          '<span class="mi-ref-body">' +
            (r.source ? '<span class="mi-ref-src">' + esc(r.source) + '</span>' : '') +
            '<span class="mi-ref-title">' + esc(r.title || r.url) + '</span>' +
          '</span>' +
          '<span class="mi-news-ext" aria-hidden="true">↗</span></a>';
      });
      h += "</div></div>";
    }
    var ago = pvTimeAgo(sum.written);
    h += '<div class="mi-news-note">Redaktionens analys – automatgenererad utifrån läget i båda lägren ' +
      '(respektive lands egna och internationella medier)' + (ago ? ", uppdaterad " + esc(ago) : "") +
      ". Prognosen är en bedömning, inte en garanti. Referenserna öppnas i ny flik.</div>";
    return h;
  }

  function newsTabHtml(info) {
    if (!info.home || !info.away || (!info.home.iso && !info.away.iso)) {
      return '<div class="mi-empty">Nyheterna dyker upp när båda lagen är klara.</div>';
    }
    if (!teamNews || !newsSummaries) {
      Promise.all([fetchTeamNews(), fetchNewsSummaries()])
        .then(function () { if (openKey) renderModal(); });
      return '<div class="mi-pv-note mi-pv-loading">Hämtar nyheter från lägren …</div>';
    }
    var sum = summaryOf(info.key);
    if (sum) {
      return '<div class="mi-news">' +
        '<div class="mi-news-intro">Redaktionens analys · läget i båda lägren + vår prognos</div>' +
        newsSummaryHtml(sum) + '</div>';
    }
    if (!newsItemsOf(info.home).length && !newsItemsOf(info.away).length) {
      return '<div class="mi-empty">Inga färska nyheter om lagen hittades just nu.</div>';
    }
    var cols = matchColors(info.home && info.home.iso, info.away && info.away.iso);
    return '<div class="mi-news">' +
      '<div class="mi-news-intro">Ur ländernas egna medier · sammanfattat på svenska</div>' +
      '<div class="mi-news-cols">' +
      newsColHtml(info.home, teamName(info.home, info.homeLabel), cols.home) +
      newsColHtml(info.away, teamName(info.away, info.awayLabel), cols.away) +
      '</div>' +
      '<div class="mi-news-note">Maskinöversatta sammanfattningar av rubriker från respektive lands medier ' +
        'via Google Nyheter. Håll muspekaren över ett kort för originalrubriken – klick öppnar artikeln i ny flik.</div>' +
      '</div>';
  }

  /* ---------- Fliken "Facit" (efteranalys av spelade slutspelsmatcher) ----------
     Jämför redaktionens förhandsprognos med utfallet: prognos-vs-facit-kort med
     träff/miss, redaktionens självbetyg, efteranalys med källor, redaktionens
     löpande träffsäkerhet samt lärdomar (data/match_reviews.json). */

  function reviewScoreLine(o) {
    if (!o) return "–";
    var s = (o.h != null ? o.h : "–") + "–" + (o.a != null ? o.a : "–");
    if (o.viaPens && o.pen) s += " (" + o.pen.h + "–" + o.pen.a + " straff)";
    else if (o.viaEt) s += " (e.f.)";
    return s;
  }

  function reviewBadge(state, hitTxt, missTxt) {
    if (state === "hit") return '<span class="mi-fx-badge hit">✓ ' + esc(hitTxt) + "</span>";
    if (state === "miss") return '<span class="mi-fx-badge miss">✗ ' + esc(missTxt) + "</span>";
    return "";
  }

  function reviewCardHtml(info, rev) {
    var pred = rev.predicted || {}, act = rev.actual || {}, v = rev.verdict || {};
    var h = '<div class="mi-fx-scorecard">' +
      '<div class="mi-fx-col pred"><span class="mi-fx-lbl">Vår prognos</span>' +
        '<span class="mi-fx-score">' + esc(pred.text || "–") + "</span></div>" +
      '<span class="mi-fx-arrow" aria-hidden="true">→</span>' +
      '<div class="mi-fx-col fact"><span class="mi-fx-lbl">Facit</span>' +
        '<span class="mi-fx-score">' + esc(reviewScoreLine(act)) + "</span></div>" +
      "</div>";
    var badges = reviewBadge(v.winner, "Rätt vinnare", "Fel vinnare") +
      reviewBadge(v.score, "Rätt resultat", "Fel resultat");
    if (badges) h += '<div class="mi-fx-badges">' + badges + "</div>";
    return h;
  }

  function reviewAccuracyHtml() {
    var a = reviewsAccuracy;
    if (!a || !a.graded) return "";
    return '<div class="mi-fx-accuracy">Redaktionens träffsäkerhet hittills: ' +
      "<strong>rätt vinnare " + esc(a.winner) + "/" + esc(a.graded) + "</strong> · " +
      "<strong>rätt resultat " + esc(a.score) + "/" + esc(a.graded) + "</strong></div>";
  }

  function reviewGradeHtml(rev) {
    var g = rev.grade || {};
    if (!g.verdict && g.score == null) return "";
    var score = g.score != null
      ? '<span class="mi-fx-grade-score">' + esc(g.score) + '<span class="mi-fx-grade-max">/5</span></span>'
      : "";
    return '<div class="mi-fx-grade">' +
      '<div class="mi-fx-grade-lb">Redaktionens dom</div>' +
      (g.verdict ? '<div class="mi-fx-grade-verdict">' + esc(g.verdict) + "</div>" : "") +
      score + "</div>";
  }

  function reviewLessonsHtml(rev) {
    var ls = rev.lessons || [];
    if (!ls.length) return "";
    var items = ls.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("");
    return '<div class="mi-fx-lessons">' +
      '<div class="mi-section-title">Vad vi tar med oss</div>' +
      '<ul class="mi-fx-lesson-list">' + items + "</ul></div>";
  }

  function reviewSummaryHtml(rev) {
    var refs = rev.references || [];
    var h = '<div class="mi-news-summary">';
    if (rev.headline) h += '<h3 class="mi-news-headline">' + esc(rev.headline) + "</h3>";
    if (rev.lead) h += '<p class="mi-news-lead">' + miInlineNews(rev.lead, refs) + "</p>";
    rev.paragraphs.forEach(function (p) { h += "<p>" + miInlineNews(p, refs) + "</p>"; });
    h += "</div>";
    if (refs.length) {
      h += '<div class="mi-news-refs"><div class="mi-section-title">Referenser</div>' +
        '<div class="mi-news-ref-list">';
      refs.forEach(function (r, i) {
        if (!r || !r.url) return;
        h += '<a class="mi-ref" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="mi-ref-num">' + (i + 1) + "</span>" +
          '<span class="mi-ref-body">' +
            (r.source ? '<span class="mi-ref-src">' + esc(r.source) + "</span>" : "") +
            '<span class="mi-ref-title">' + esc(r.title || r.url) + "</span>" +
          "</span><span class=\"mi-news-ext\" aria-hidden=\"true\">↗</span></a>";
      });
      h += "</div></div>";
    }
    var ago = pvTimeAgo(rev.written);
    h += '<div class="mi-news-note">Facit – automatgenererad efteranalys som jämför redaktionens ' +
      "förhandsprognos med utfallet" + (ago ? ", uppdaterad " + esc(ago) : "") +
      ". Referenserna öppnas i ny flik.</div>";
    return h;
  }

  function reviewTabHtml(info) {
    var rev = reviewOf(info.key);
    if (!rev) {
      if (!matchReviews) {
        fetchMatchReviews().then(function () { if (openKey) renderModal(); });
        return '<div class="mi-pv-note mi-pv-loading">Hämtar facit …</div>';
      }
      return '<div class="mi-empty">Facit för den här matchen är inte klart ännu.</div>';
    }
    return '<div class="mi-news mi-facit">' +
      '<div class="mi-news-intro">Facit · vår prognos mot verkligheten</div>' +
      reviewCardHtml(info, rev) +
      reviewGradeHtml(rev) +
      reviewSummaryHtml(rev) +
      reviewLessonsHtml(rev) +
      reviewAccuracyHtml() +
      "</div>";
  }

  /* ---------- Hela inför-panelen ---------- */

  function previewHtml(info) {
    if (!info.home || !info.away) {
      return '<div class="mi-empty">Inför-snacket dyker upp när båda lagen är klara.</div>';
    }
    var pv = null;
    if (window.VMApp && typeof window.VMApp.matchPreview === "function") {
      try { pv = window.VMApp.matchPreview(info.key); } catch (e) {}
    }
    if (!pv) return '<div class="mi-empty">Inför-snacket är inte tillgängligt just nu.</div>';
    if (!pv.ready || !pv.probsReady) schedulePreviewRetry();

    var h = '<div class="mi-preview">';
    h += pvVerdictHtml(info, pv);
    if (!pv.ready && !pv.rp) {
      h += '<div class="mi-pv-note mi-pv-loading">Hämtar odds och sannolikheter …</div>';
    }
    h += pvOddsHtml(info, pv);
    h += pvKoNextHtml(pv);
    h += availSectionHtml(info);
    h += pvFormHtml(info, pv);
    h += pvCompareHtml(info, pv);
    h += pvKeyPlayersHtml(info);
    h += '</div>';
    return h;
  }

  function emptyHintForTab(tab, info) {
    if (tab === "events") {
      if (info.live) {
        return '<div class="mi-empty">Mål, kort och byten hämtas automatiskt och dyker upp här inom ett par minuter.</div>';
      }
      if (info.played) {
        return '<div class="mi-empty">Matchhändelser för den här matchen är inte tillgängliga ännu.</div>';
      }
      return '<div class="mi-empty">Matchen har inte startat ännu.</div>';
    }
    if (tab === "lineups") {
      if (info.live || info.played) {
        return '<div class="mi-empty">Laguppställningen för den här matchen är inte tillgänglig ännu.</div>';
      }
      return '<div class="mi-empty">Troliga startelvor dyker upp här dagen före match – ' +
        'de officiella elvorna släpps ungefär en timme före avspark.</div>';
    }
    if (info.live || info.played) {
      return '<div class="mi-empty">Statistik för den här matchen är inte tillgänglig ännu.</div>';
    }
    return '<div class="mi-empty">Statistik visas när matchen har startat.</div>';
  }

  function tabsHtml(info, det) {
    var gm = /^g:([A-L]):/.exec(info.key || "");
    var groupLetter = gm ? gm[1] : null;
    var upcoming = !info.live && !info.played;

    // Kommande matcher: Händelser/Statistik är garanterat tomma före avspark –
    // de ersätts av inför-snacket + nyheterna från lägren. Pågående/spelade
    // visar de vanliga flikarna.
    var tabs = upcoming
      ? [{ id: "news", label: "Redaktionens analys" },
         { id: "preview", label: "Fakta & odds" },
         { id: "lineups", label: "Laguppställning" }]
      : TABS.slice();
    // Spelade slutspelsmatcher med färdigt facit får en "Facit"-flik näst efter
    // Händelser (Händelser är kvar som default).
    if (!upcoming && reviewOf(info.key)) tabs.splice(1, 0, { id: "review", label: "Facit" });
    if (groupLetter) tabs.push({ id: "table", label: "Tabell" });
    // Säkerhetsnät: faller tillbaka till första fliken om aktiv flik saknas här
    // (t.ex. när en kommande match går igång medan modalen står på analysfliken).
    if (!tabs.some(function (t) { return t.id === activeTab; })) activeTab = tabs[0].id;

    var h = '<div class="mi-tabs" role="tablist">';
    tabs.forEach(function (t) {
      h += '<button type="button" class="mi-tab' + (activeTab === t.id ? " active" : "") +
        '" role="tab" aria-selected="' + (activeTab === t.id) + '" data-mi-tab="' + t.id + '">' +
        esc(t.label) + "</button>";
    });
    h += '</div><div class="mi-tab-panels">';

    if (upcoming) {
      h += '<div class="mi-tab-panel' + (activeTab === "news" ? " active" : "") + '" data-mi-panel="news">';
      h += newsTabHtml(info);
      h += "</div>";
      h += '<div class="mi-tab-panel' + (activeTab === "preview" ? " active" : "") + '" data-mi-panel="preview">';
      h += previewHtml(info);
      h += "</div>";
    } else {
      h += '<div class="mi-tab-panel' + (activeTab === "events" ? " active" : "") + '" data-mi-panel="events">';
      var hasEvents = det && ((det.goals || []).length || (det.bookings || []).length || (det.subs || []).length);
      if (hasEvents) h += timelineHtml(info, det, true);
      else h += emptyHintForTab("events", info);
      h += "</div>";
      if (reviewOf(info.key)) {
        h += '<div class="mi-tab-panel' + (activeTab === "review" ? " active" : "") + '" data-mi-panel="review">';
        h += reviewTabHtml(info);
        h += "</div>";
      }
    }

    h += '<div class="mi-tab-panel' + (activeTab === "lineups" ? " active" : "") + '" data-mi-panel="lineups">';
    if (det && det.lineups && det.lineups.h && det.lineups.a) {
      h += lineupsOverviewHtml(info, det);
    } else {
      // Före avspark (och tidigt i livematcher innan ESPN publicerat de
      // officiella elvorna): visa trolig/bekräftad startelva från 365Scores.
      var pre = !info.played ? prelimFor(info.key) : null;
      if (pre) h += prelimLineupsHtml(info, pre);
      else h += emptyHintForTab("lineups", info);
    }
    h += "</div>";

    if (!upcoming) {
      h += '<div class="mi-tab-panel' + (activeTab === "stats" ? " active" : "") + '" data-mi-panel="stats">';
      if (det && det.stats && det.stats.length) h += statsHtml(det, info, true);
      else h += emptyHintForTab("stats", info);
      h += "</div>";
    }

    if (groupLetter) {
      h += '<div class="mi-tab-panel' + (activeTab === "table" ? " active" : "") + '" data-mi-panel="table">';
      var isos = [info.home && info.home.iso, info.away && info.away.iso].filter(Boolean);
      var tbl = (window.VMApp && typeof window.VMApp.groupTableHtml === "function")
        ? window.VMApp.groupTableHtml(groupLetter, isos) : "";
      if (tbl) {
        h += '<div class="mi-section-title">Tabell · Grupp ' + esc(groupLetter) + '</div>' +
          '<div class="mi-standings-wrap">' + tbl + '</div>';
      } else {
        h += '<div class="mi-empty">Tabellen är inte tillgänglig ännu.</div>';
      }
      h += "</div>";
    }

    h += "</div>";
    return h;
  }

  /* ---------- Höjdpunkter / repriser (SVT Play + TV4 Play) ---------- */

  var HL_LABELS = { full: "Hela matchen", long: "Längre sammandrag", short: "Kortare sammandrag" };
  var HL_TYPES = ["full", "long", "short"];

  // Ett klipp räknas som tillgängligt om det har en url och inte hunnit gå ut.
  function watchAvailable(entry) {
    if (!entry || !entry.url) return false;
    return !(entry.until && new Date(entry.until).getTime() <= Date.now());
  }

  function watchLinkHtml(entry, label) {
    // Saknas reprislängden ritas en svag, ej klickbar platshållare i samma
    // storlek, så SVT- och TV4-kolumnen alltid har lika många rader och står
    // symmetriskt även när kanalerna har olika många klipp.
    if (!watchAvailable(entry)) {
      return '<span class="mi-watch-link is-empty" aria-hidden="true">' +
        '<span class="mi-watch-ico">▶</span>' + esc(label) + "</span>";
    }
    return '<a class="mi-watch-link" href="' + esc(entry.url) + '" target="_blank" rel="noopener noreferrer" ' +
      'title="' + esc(entry.title || label) + '"><span class="mi-watch-ico" aria-hidden="true">▶</span>' +
      esc(label) + "</a>";
  }

  function channelBlockHtml(chName, linksHtml) {
    if (!linksHtml) return "";
    return '<div class="mi-watch-ch">' +
      '<span class="cal-tv ' + (chName === "SVT" ? "svt" : "tv4") + '">' + esc(chName) + "</span>" +
      '<div class="mi-watch-links">' + linksHtml + "</div>" +
      "</div>";
  }

  function channelLinksHtml(chName, data) {
    if (!data) return "";
    var links = "", hasReal = false;
    HL_TYPES.forEach(function (t) {
      if (watchAvailable(data[t])) hasReal = true;
      links += watchLinkHtml(data[t], HL_LABELS[t]);
    });
    if (!hasReal) return ""; // ingen riktig repris för kanalen – visa ingen kolumn
    return channelBlockHtml(chName, links);
  }

  // Lägg .is-single när bara en kanal har innehåll, så det enda kortet inte
  // klistras mot vänsterkanten i tvåkolumnsrutnätet. Titeln ("Repriser" m.m.)
  // läggs på samma rad som kanalmärkena (SVT/TV4).
  function watchWrapHtml(title, groups, extraCls) {
    var count = (groups.match(/mi-watch-ch/g) || []).length;
    var cls = "mi-watch" + (extraCls ? " " + extraCls : "") + (count <= 1 ? " is-single" : "");
    var head = title ? '<div class="mi-watch-title">' + esc(title) + "</div>" : "";
    return '<div class="' + cls + '">' + head + groups + "</div>";
  }

  // Samma reprisikoner och ordning (kortare → längre → hela) som brickorna på
  // framsidan/kalendern, så igenkänningen är omedelbar även i modalen.
  var REPRIS_TYPES = ["short", "long", "full"];
  var REPRIS_ICONS = {
    full: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 8.5l5.5 3.5-5.5 3.5z" fill="currentColor"/></svg>',
    long: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="6" width="13" height="2.4" rx="1.2" fill="currentColor"/><rect x="4" y="10.8" width="16" height="2.4" rx="1.2" fill="currentColor"/><rect x="4" y="15.6" width="9" height="2.4" rx="1.2" fill="currentColor"/></svg>',
    short: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13 2L4 14h6l-1 8 9-12h-6z" fill="currentColor"/></svg>'
  };

  function reprisLinkHtml(entry, type, ch) {
    var chCls = ch === "SVT" ? "svt" : "tv4";
    var tip = HL_LABELS[type] + " · " + ch;
    return '<a class="cal-watch-link ' + chCls + '" href="' + esc(entry.url) + '" target="_blank" rel="noopener noreferrer" ' +
      'title="' + esc(tip) + '" aria-label="' + esc(HL_LABELS[type] + " på " + ch) + '">' + REPRIS_ICONS[type] + "</a>";
  }

  // SVT prioriteras per längd, inte per match: för varje reprislängd väljs SVT om
  // den finns, annars TV4. Då försvinner aldrig TV4:s "Hela matchen" bara för att
  // SVT lagt upp ett kort sammandrag, samtidigt som det aldrig blir dubbletter av
  // samma längd. Saknar SVT helt repriser visas TV4:s ikoner ensamma. Rubriken
  // ("Repriser") ligger på samma rad som ikonbrickorna, precis som på framsidan.
  function recordedWatchHtml(info) {
    var hl = info && highlights[info.key];
    if (!hl) return "";
    var svtLinks = "", tv4Links = "";
    REPRIS_TYPES.forEach(function (t) {
      if (hl.SVT && watchAvailable(hl.SVT[t])) svtLinks += reprisLinkHtml(hl.SVT[t], t, "SVT");
      else if (hl.TV4 && watchAvailable(hl.TV4[t])) tv4Links += reprisLinkHtml(hl.TV4[t], t, "TV4");
    });
    var groups = (svtLinks ? '<span class="cal-watch-ch">' + svtLinks + "</span>" : "") +
      (tv4Links ? '<span class="cal-watch-ch">' + tv4Links + "</span>" : "");
    if (!groups) return "";
    return '<div class="mi-watch mi-watch-repris"><div class="mi-watch-title">Repriser</div>' +
      '<span class="cal-watch">' + groups + "</span></div>";
  }

  /* ---------- Spoilerfritt läge ----------
     Matchen spelades det senaste dygnet men resultatet är dolt. Visa highlights/
     repriser (de avslöjar inget i sig) plus en "visa ändå"-knapp – men inte mål,
     ställning, statistik eller laguppställning (som skulle spoila resultatet). */
  function spoilerStatusChip() {
    return '<span class="mi-status spoiler"><span class="mi-spoiler-dot" aria-hidden="true"></span>Resultat dolt</span>';
  }

  function spoilerBodyHtml(info) {
    var h = '<div class="mi-spoiler-panel">' +
      '<span class="mi-spoiler-ic" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">' +
        '<path d="M9.9 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a18.6 18.6 0 0 1-3 3.9M6.2 6.3A18.5 18.5 0 0 0 2 12s3.6 7 10 7a10.4 10.4 0 0 0 4-.8"/>' +
        '<path d="M9.5 9.6A3 3 0 0 0 14.4 13.8"/><path d="M3 3l18 18"/></svg>' +
      '</span>' +
      '<div class="mi-spoiler-msg"><strong>Spoilerskyddet är på</strong>' +
        '<span>Resultat, mål, statistik och laguppställning är dolda för den här matchen – så att du kan se sammandrag eller hela matchen utan att veta hur det gick.</span></div>' +
      '<button type="button" class="mi-reveal" data-mi-reveal="' + esc(info.key) + '">Visa resultatet ändå</button>' +
      '</div>';
    var repris = recordedWatchHtml(info);
    if (repris) {
      h += repris;
    } else {
      h += '<div class="mi-empty">Sammandrag och repriser dyker upp här när de publicerats.</div>';
    }
    return h;
  }

  /* Livesändning / försnack: länk till SVT Play / TV4 Play där matchen visas
     live. Dyker upp för pågående matcher och inför avspark (när sändningen –
     ofta med försnack – blivit tillgänglig), men inte för spelade matcher. */
  function liveChannelHtml(chName, data, isLive) {
    if (!data || !data.live) return "";
    var label = isLive ? "Se live" : "Se sändning live";
    var entry = data.live;
    if (entry.until && new Date(entry.until).getTime() <= Date.now()) return "";
    var ico = isLive
      ? '<span class="live-dot" aria-hidden="true"></span>'
      : '<span class="mi-watch-ico" aria-hidden="true">▶</span>';
    var cls = "mi-watch-link " + (isLive ? "is-live" : "is-upcoming");
    var link = '<a class="' + cls + '" href="' + esc(entry.url) + '" target="_blank" rel="noopener noreferrer" ' +
      'title="' + esc(entry.title || label) + '">' + ico + esc(label) + "</a>";
    return channelBlockHtml(chName, link);
  }

  function liveBroadcastHtml(info) {
    // Endast pågående eller kommande matcher – aldrig spelade.
    if (!info || info.played) return "";
    var hl = highlights[info.key];
    if (!hl) return "";
    var groups = liveChannelHtml("SVT", hl.SVT, info.live) + liveChannelHtml("TV4", hl.TV4, info.live);
    if (!groups) return "";
    var title = info.live ? "Se matchen live" : "Se sändningen live";
    return watchWrapHtml(title, groups, "mi-watch-live");
  }

  /* Hela matchen i efterhand: när en match precis spelats men inget sammandrag
     publicerats ännu ligger ofta livesändningen kvar (går att spola till början).
     Den länken visas tills repriserna kommer eller sändningen tas bort. */
  function fullMatchChannelHtml(chName, data) {
    if (!data || !data.live) return "";
    var entry = data.live;
    if (entry.until && new Date(entry.until).getTime() <= Date.now()) return "";
    var link = '<a class="mi-watch-link is-full" href="' + esc(entry.url) + '" target="_blank" rel="noopener noreferrer" ' +
      'title="' + esc(entry.title || "Hela matchen") + '"><span class="mi-watch-ico" aria-hidden="true">▶</span>Hela matchen</a>';
    return channelBlockHtml(chName, link);
  }

  function postMatchLiveHtml(info) {
    var hl = highlights[info.key];
    if (!hl) return "";
    var groups = fullMatchChannelHtml("SVT", hl.SVT) + fullMatchChannelHtml("TV4", hl.TV4);
    if (!groups) return "";
    return watchWrapHtml("Se hela matchen", groups, "mi-watch-live");
  }

  /* Vad som visas i "titta"-delen av modalen: livesändning inför/under matchen,
     repriser efteråt, hela matchen i efterhand (innan sammandrag finns), eller –
     när inget av detta finns – en kort notis. */
  function watchSectionHtml(info) {
    if (!info) return "";
    if (!info.played) return liveBroadcastHtml(info);
    var recorded = recordedWatchHtml(info);
    if (recorded) return recorded;
    var post = postMatchLiveHtml(info);
    if (post) return post;
    return '<div class="mi-empty">Livesändningen är slut och ingen repris har publicerats ännu.</div>';
  }

  function renderModal() {
    if (!openKey) return;
    var card = document.querySelector("#matchModal .mi-card");
    if (!card) return;
    var info = window.VMApp.describeMatch(openKey);
    if (!info) { close(); return; }
    var det = details[openKey] || null;

    // Spoilerfritt läge: matchen är dold tills användaren valt "visa ändå".
    // Vid avslöjande speglas det verkliga utfallet (raw*) så modalen ritar som
    // vanligt med mål, ställning och statistik.
    var spoilerHidden = info.spoiler && !revealed[openKey];
    if (info.spoiler && revealed[openKey]) {
      info.played = info.rawPlayed;
      info.live = info.rawLive;
      info.r = info.rawR;
      info.spoiler = false;
    }

    if (spoilerHidden) {
      // Gruppmatcher: visa den färgade grupp-pillen; KO-matcher textetiketten.
      var gmHeadEarly = /^g:([A-L]):/.exec(info.key || "");
      var labelHtmlEarly = gmHeadEarly
        ? '<span class="group-pill grp-' + gmHeadEarly[1] + ' is-lg">' + esc(info.label) + '</span>'
        : '<span class="mi-label">' + esc(info.label) + '</span>';
      var hName0 = teamName(info.home, info.homeLabel);
      var aName0 = teamName(info.away, info.awayLabel);
      var sh = '<button class="mi-close" title="Stäng">×</button>';
      sh += '<div class="mi-head">' + labelHtmlEarly + spoilerStatusChip() + '</div>';
      sh += '<div class="mi-score-row">' +
        miTeamBox(info.home, hName0, "home") +
        '<span class="mi-score mi-score-hidden" title="Resultatet är dolt">' +
          '<span class="mi-hidden-pip"></span><span class="mi-dash">–</span><span class="mi-hidden-pip"></span></span>' +
        miTeamBox(info.away, aName0, "away") +
        '</div>';
      sh += spoilerBodyHtml(info);
      sh += '<div class="mi-note">Matchdata: ESPN · dold av spoilerskyddet</div>';
      card.innerHTML = sh;
      card.querySelector(".mi-close").addEventListener("click", close);
      var revealBtn = card.querySelector("[data-mi-reveal]");
      if (revealBtn) {
        revealBtn.addEventListener("click", function () {
          revealed[openKey] = true;
          activeTab = "events";
          renderModal();
        });
      }
      return;
    }

    var score = scoreOf(info, det);
    var hName = teamName(info.home, info.homeLabel);
    var aName = teamName(info.away, info.awayLabel);

    // Gruppmatcher: visa den färgade grupp-pillen (samma "grupplogga" som i
    // grupp-/kalendervyn) i stället för en grå textetikett. KO-matcher behåller
    // textetiketten ("Åttondelsfinal 3" osv – kronologisk ordning).
    var gmHead = /^g:([A-L]):/.exec(info.key || "");
    var labelHtml = gmHead
      ? '<span class="group-pill grp-' + gmHead[1] + ' is-lg">' + esc(info.label) + '</span>'
      : '<span class="mi-label">' + esc(info.label) + '</span>';

    var h = '<button class="mi-close" title="Stäng">×</button>';
    h += '<div class="mi-head">' + labelHtml + statusChip(info, det) + '</div>';

    h += '<div class="mi-score-row">' +
      miTeamBox(info.home, hName, "home") +
      '<span class="mi-score">' +
        (score ? score.h + '<span class="mi-dash">–</span>' + score.a : '<span class="mi-dash">–</span>') +
      '</span>' +
      miTeamBox(info.away, aName, "away") +
      '</div>';

    var subScore = [];
    if (det && det.score && det.score.ht) subScore.push("Halvtid " + det.score.ht.h + "–" + det.score.ht.a);
    if (det && det.score && det.score.et) subScore.push("Efter förlängning " + det.score.et.h + "–" + det.score.et.a);
    if (det && det.score && det.score.pen) subScore.push("Straffar " + det.score.pen.h + "–" + det.score.pen.a);
    if (subScore.length) h += '<div class="mi-subscore">' + esc(subScore.join(" · ")) + '</div>';

    h += watchSectionHtml(info);
    h += tabsHtml(info, det);
    h += factsHtml(info, det);

    h += '<div class="mi-note">Matchdata: ESPN' +
      (info.live ? " · uppdateras automatiskt" : "") +
      (det && det.updatedAt ? " · hämtad " + esc(new Date(det.updatedAt).toLocaleString("sv-SE")) : "") +
      '</div>';

    card.innerHTML = h;
    card.querySelector(".mi-close").addEventListener("click", close);
    card.querySelectorAll("[data-mi-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeTab = btn.getAttribute("data-mi-tab");
        // Nära avspark slår den troliga elvan om till bekräftad – kolla efter
        // färsk data när fliken öppnas (fetchen är cachad ett par minuter).
        if (activeTab === "lineups") {
          fetchPrelimLineups().then(function () { if (openKey) renderModal(); });
        }
        renderModal();
      });
    });
    // Genvägar in i en annan flik (t.ex. nyhetsteasern i Inför-snacket).
    card.querySelectorAll("[data-mi-goto]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeTab = btn.getAttribute("data-mi-goto");
        renderModal();
      });
    });
  }

  /* ---------- Init ---------- */

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openKey) {
      // Ligger spelarmodalen ovanpå? Låt den (assets/live.js) stänga först.
      var pm = document.getElementById("playerModal");
      if (pm && pm.classList.contains("open")) return;
      close();
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && e.target && e.target.getAttribute) {
      if (e.target.getAttribute("data-mi-player")) {
        e.preventDefault();
        openLineupPlayer(e.target.getAttribute("data-mi-player"), e.target.getAttribute("data-mi-side"));
        return;
      }
      if (e.target.getAttribute("data-match-open")) {
        e.preventDefault();
        open(e.target.getAttribute("data-match-open"));
      }
    }
  });

  // Förladda detaljerna så att första klicket öppnar direkt.
  function start() { fetchDetails(); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.VMMatchInfo = {
    open: open, close: close, onDataUpdated: onDataUpdated,
    onSpoilerChange: onSpoilerChange, refreshDetails: refreshDetails
  };
})();
