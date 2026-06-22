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
  var POLL_MS = 45000;

  var details = {};        // key -> detaljobjekt
  var detailsLoaded = false;
  var openKey = null;      // öppen match (resultatnyckel) eller null
  var pollTimer = null;
  var activeTab = "events";

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
    var row = e.target.closest && e.target.closest("[data-mi-player]");
    if (row) openLineupPlayer(row.getAttribute("data-mi-player"), row.getAttribute("data-mi-side"));
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
    // Ej påbörjade matcher saknar händelser – landa på laguppställningen.
    var info = window.VMApp.describeMatch(key);
    activeTab = (info && !info.live && !info.played) ? "lineups" : "events";
    var m = ensureModal();
    m.classList.add("open");
    renderModal();
    fetchDetails().then(function () {
      renderModal();
      schedulePoll();
    });
  }

  function close() {
    openKey = null;
    clearTimeout(pollTimer);
    var m = document.getElementById("matchModal");
    if (m) m.classList.remove("open");
  }

  function onDataUpdated() {
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
      return '<span class="mi-status done">Slutspelad' + suffix + '</span>';
    }
    return '<span class="mi-status upcoming">' + esc(info.when.dateLabel + " · " + info.when.time) + '</span>';
  }

  function teamName(team, fallback) {
    if (team && team.sv) return team.sv;
    return fallback || "?";
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

  function playerBadgesHtml(events) {
    if (!events) return "";
    var parts = [];
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

  function lineupsOverviewHtml(info, det) {
    var lu = det && det.lineups;
    if (!lu || !lu.h || !lu.a) return "";
    var evMap = buildPlayerEvents(det);
    var hIso = info.home && info.home.iso;
    var aIso = info.away && info.away.iso;
    var cols = matchColors(hIso, aIso);
    var hCtx = { color: cols.home, sideCode: "h", idx: squadIndexFor(hIso) };
    var aCtx = { color: cols.away, sideCode: "a", idx: squadIndexFor(aIso) };
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
    h += '<div class="mi-pl-section-label">Startelva</div>';
    h += lineupPairRows(lu.h.starters || [], lu.a.starters || [], evMap, hCtx, aCtx);
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
      return '<div class="mi-empty">Startelvor publiceras närmare avspark.</div>';
    }
    if (info.live || info.played) {
      return '<div class="mi-empty">Statistik för den här matchen är inte tillgänglig ännu.</div>';
    }
    return '<div class="mi-empty">Statistik visas när matchen har startat.</div>';
  }

  function tabsHtml(info, det) {
    var gm = /^g:([A-L]):/.exec(info.key || "");
    var groupLetter = gm ? gm[1] : null;

    // Alla matcher – även ej påbörjade – visar samma flikar i samma ordning.
    // Tomma flikar förklarar i stället att innehållet kommer närmare avspark.
    var tabs = TABS.slice();
    if (groupLetter) tabs.push({ id: "table", label: "Tabell" });
    // Säkerhetsnät: faller tillbaka till Händelser om aktiv flik saknas här.
    if (!tabs.some(function (t) { return t.id === activeTab; })) activeTab = "events";

    var h = '<div class="mi-tabs" role="tablist">';
    tabs.forEach(function (t) {
      h += '<button type="button" class="mi-tab' + (activeTab === t.id ? " active" : "") +
        '" role="tab" aria-selected="' + (activeTab === t.id) + '" data-mi-tab="' + t.id + '">' +
        esc(t.label) + "</button>";
    });
    h += '</div><div class="mi-tab-panels">';

    h += '<div class="mi-tab-panel' + (activeTab === "events" ? " active" : "") + '" data-mi-panel="events">';
    var hasEvents = det && ((det.goals || []).length || (det.bookings || []).length || (det.subs || []).length);
    if (hasEvents) h += timelineHtml(info, det, true);
    else h += emptyHintForTab("events", info);
    h += "</div>";

    h += '<div class="mi-tab-panel' + (activeTab === "lineups" ? " active" : "") + '" data-mi-panel="lineups">';
    if (det && det.lineups && det.lineups.h && det.lineups.a) h += lineupsOverviewHtml(info, det);
    else h += emptyHintForTab("lineups", info);
    h += "</div>";

    h += '<div class="mi-tab-panel' + (activeTab === "stats" ? " active" : "") + '" data-mi-panel="stats">';
    if (det && det.stats && det.stats.length) h += statsHtml(det, info, true);
    else h += emptyHintForTab("stats", info);
    h += "</div>";

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

  function renderModal() {
    if (!openKey) return;
    var card = document.querySelector("#matchModal .mi-card");
    if (!card) return;
    var info = window.VMApp.describeMatch(openKey);
    if (!info) { close(); return; }
    var det = details[openKey] || null;

    var score = scoreOf(info, det);
    var hName = teamName(info.home, info.homeLabel);
    var aName = teamName(info.away, info.awayLabel);

    // Gruppmatcher: visa den färgade grupp-pillen (samma "grupplogga" som i
    // grupp-/kalendervyn) i stället för en grå textetikett. KO-matcher behåller
    // textetiketten ("Åttondelsfinal · M50" osv).
    var gmHead = /^g:([A-L]):/.exec(info.key || "");
    var labelHtml = gmHead
      ? '<span class="group-pill grp-' + gmHead[1] + ' is-lg">' + esc(info.label) + '</span>'
      : '<span class="mi-label">' + esc(info.label) + '</span>';

    var h = '<button class="mi-close" title="Stäng">×</button>';
    h += '<div class="mi-head">' + labelHtml + statusChip(info, det) + '</div>';

    h += '<div class="mi-score-row">' +
      '<span class="mi-team home">' + flagImg(info.home && info.home.iso) +
        '<span class="mi-team-name">' + esc(hName) + '</span></span>' +
      '<span class="mi-score">' +
        (score ? score.h + '<span class="mi-dash">–</span>' + score.a : '<span class="mi-dash">–</span>') +
      '</span>' +
      '<span class="mi-team away">' + flagImg(info.away && info.away.iso) +
        '<span class="mi-team-name">' + esc(aName) + '</span></span>' +
      '</div>';

    var subScore = [];
    if (det && det.score && det.score.ht) subScore.push("Halvtid " + det.score.ht.h + "–" + det.score.ht.a);
    if (det && det.score && det.score.et) subScore.push("Efter förlängning " + det.score.et.h + "–" + det.score.et.a);
    if (det && det.score && det.score.pen) subScore.push("Straffar " + det.score.pen.h + "–" + det.score.pen.a);
    if (subScore.length) h += '<div class="mi-subscore">' + esc(subScore.join(" · ")) + '</div>';

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
    refreshDetails: refreshDetails
  };
})();
