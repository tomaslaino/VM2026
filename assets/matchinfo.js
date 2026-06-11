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
    return m;
  }

  function open(key) {
    if (!window.VMApp || typeof window.VMApp.describeMatch !== "function") return;
    openKey = key;
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

  var CARD_ICON = { YELLOW: "🟨", RED: "🟥", YELLOW_RED: "🟨🟥" };
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
      var what = g.type === "OWN" ? "Självmål" : (g.type === "PENALTY" ? "Mål (straff)" : "Mål");
      var txt = "<b>" + esc(g.scorer || "Okänd målskytt") + "</b>";
      if (g.assist) txt += ' <span class="mi-ev-sub">(assist: ' + esc(g.assist) + ")</span>";
      if (g.score) txt += ' <span class="mi-ev-score">' + g.score.h + "–" + g.score.a + "</span>";
      ev.push({ minute: g.minute, injuryTime: g.injuryTime, team: g.team, icon: "⚽", what: what, txt: txt });
    });
    (det.bookings || []).forEach(function (b) {
      ev.push({
        minute: b.minute, injuryTime: null, team: b.team,
        icon: CARD_ICON[b.card] || "🟨",
        what: CARD_TXT[b.card] || "Kort",
        txt: "<b>" + esc(b.player || "Okänd spelare") + "</b>"
      });
    });
    (det.subs || []).forEach(function (s) {
      ev.push({
        minute: s.minute, injuryTime: null, team: s.team, icon: "🔄", what: "Byte",
        txt: '<span class="mi-ev-sub">In:</span> <b>' + esc(s.in || "?") + '</b> ' +
          '<span class="mi-ev-sub">· Ut: ' + esc(s.out || "?") + "</span>"
      });
    });
    ev.sort(function (a, b) {
      var am = (a.minute == null ? 9999 : a.minute) + (a.injuryTime ? a.injuryTime / 100 : 0);
      var bm = (b.minute == null ? 9999 : b.minute) + (b.injuryTime ? b.injuryTime / 100 : 0);
      return am - bm;
    });
    return ev;
  }

  function timelineHtml(info, det) {
    var ev = buildTimeline(det);
    if (!ev.length) return "";
    var h = '<div class="mi-section-title">Matchhändelser</div><div class="mi-timeline">';
    ev.forEach(function (e) {
      var iso = e.team === "h" ? (info.home && info.home.iso) : e.team === "a" ? (info.away && info.away.iso) : null;
      h += '<div class="mi-ev' + (e.team === "a" ? " away" : "") + '">' +
        '<span class="mi-ev-min">' + esc(minuteLabel(e.minute, e.injuryTime)) + '</span>' +
        '<span class="mi-ev-ic">' + e.icon + '</span>' +
        '<span class="mi-ev-body"><span class="mi-ev-what">' + esc(e.what) + (iso ? " · " : "") +
          (iso ? flagImg(iso) : "") + '</span> ' + e.txt + '</span>' +
        '</div>';
    });
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

  function statsHtml(det) {
    var stats = (det && det.stats) || [];
    if (!stats.length) return "";
    var h = '<div class="mi-section-title">Statistik</div><div class="mi-stats">';
    stats.forEach(function (s) {
      var label = STAT_LABELS[s.key];
      if (!label) return;
      var hv = parseFloat(s.h);
      var av = parseFloat(s.a);
      if (!isFinite(hv)) hv = 0;
      if (!isFinite(av)) av = 0;
      var pct = hv + av > 0 ? Math.round((hv / (hv + av)) * 100) : 50;
      h += '<div class="mi-stat">' +
        '<div class="mi-stat-row">' +
          '<span class="mi-stat-val">' + esc(s.h) + '</span>' +
          '<span class="mi-stat-lbl">' + esc(label) + '</span>' +
          '<span class="mi-stat-val">' + esc(s.a) + '</span>' +
        '</div>' +
        '<div class="mi-stat-bar"><span class="home" style="width:' + pct + '%"></span></div>' +
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

  function factsHtml(info, det) {
    var rows = "";
    var venue = (det && det.venue) || (info.venue ? info.venue.stadium + ", " + info.venue.city : null);
    rows += infoRow("Arena", venue ? esc(venue) : null);
    rows += infoRow("Domare", det && det.referee ? esc(det.referee) : null);
    rows += infoRow("Publik", det && det.attendance ? esc(Number(det.attendance).toLocaleString("sv-SE")) : null);
    if (info.channel) {
      rows += infoRow("TV", '<span class="cal-tv ' + (info.channel === "SVT" ? "svt" : "tv4") + '">' +
        esc(info.channel) + "</span>");
    }
    if (!rows) return "";
    return '<div class="mi-section-title">Om matchen</div><div class="mi-facts">' + rows + "</div>";
  }

  function emptyHint(info) {
    if (info.live) {
      return '<div class="mi-empty">Mål, kort och byten hämtas automatiskt och dyker upp här inom ett par minuter.</div>';
    }
    if (info.played) {
      return '<div class="mi-empty">Detaljerad statistik för den här matchen är inte tillgänglig ännu.</div>';
    }
    return '<div class="mi-empty">Matchen har inte startat ännu.</div>';
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

    var h = '<button class="mi-close" title="Stäng">×</button>';
    h += '<div class="mi-head"><span class="mi-label">' + esc(info.label) + '</span>' +
      statusChip(info, det) + '</div>';

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

    var hasEvents = det && ((det.goals || []).length || (det.bookings || []).length || (det.subs || []).length);
    if (hasEvents) h += timelineHtml(info, det);
    else if (detailsLoaded || !det) h += emptyHint(info);

    h += statsHtml(det);
    h += factsHtml(info, det);

    h += '<div class="mi-note">Matchdata: ESPN' +
      (info.live ? " · uppdateras automatiskt" : "") +
      (det && det.updatedAt ? " · hämtad " + esc(new Date(det.updatedAt).toLocaleString("sv-SE")) : "") +
      '</div>';

    card.innerHTML = h;
    card.querySelector(".mi-close").addEventListener("click", close);
  }

  /* ---------- Init ---------- */

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openKey) { close(); return; }
    if ((e.key === "Enter" || e.key === " ") && e.target && e.target.getAttribute &&
        e.target.getAttribute("data-match-open")) {
      e.preventDefault();
      open(e.target.getAttribute("data-match-open"));
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
