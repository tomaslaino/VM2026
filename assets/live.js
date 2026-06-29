/*
  VM 2026 – spelar- & live-modul (frontend).

  Trupp/spelarprofil bygger på STATISK data via window.VMPlayers
  (data/wc2026_players.json). Inga runtime-anrop mot Wikipedia eller någon
  spelar-API sker här – datan uppdateras enbart av GitHub Actions.

  - Injicerar truppen i lag-lådan (hook från app.js: window.VMLive.onTeamDrawer),
    indelad i Målvakter / Försvarare / Mittfältare / Anfallare.
  - Öppnar en spelarprofil (modal) vid klick på en spelare.
  - Lyssnar på WebSocket och visar mål-notiser i realtid (live-data, separat).

  Backend-URL (endast för live-notiser via WebSocket):
    Körs sidan från Node-servern → samma origin (inget att konfigurera).
    GitHub Pages → sätt window.VM_CONFIG = { backend: "https://din-backend.exempel.com" }
    före denna fil i index.html.
*/
(function () {
  "use strict";

  var CFG = window.VM_CONFIG || {};
  var BACKEND = (CFG.backend || "").replace(/\/$/, ""); // tom = samma origin

  function wsUrl() {
    if (BACKEND) return BACKEND.replace(/^http/, "ws") + "/ws";
    var proto = location.protocol === "https:" ? "wss" : "ws";
    return proto + "://" + location.host + "/ws";
  }

  var lastTeam = null;  // senaste lag som visades i lådan (för uppdatering)

  var SV_MONTHS = ["januari", "februari", "mars", "april", "maj", "juni",
    "juli", "augusti", "september", "oktober", "november", "december"];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /** Visar "–" istället för tomt/null. */
  function dash(v) {
    return (v === null || v === undefined || v === "") ? "–" : esc(v);
  }

  /** "1992-05-13" -> "13 maj 1992" (svensk form). */
  function fmtDate(iso) {
    if (!iso) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    return parseInt(m[3], 10) + " " + SV_MONTHS[parseInt(m[2], 10) - 1] + " " + m[1];
  }

  /* ---------- Trupp i lag-lådan (statisk data) ---------- */

  function onTeamDrawer(team, group, drawer) {
    lastTeam = { team: team, group: group, drawer: drawer };
    var body = drawer.querySelector(".drawer-body");
    if (!body) return;

    var card = document.createElement("div");
    card.className = "drawer-card players-card";
    card.innerHTML = '<div class="dc-title">Trupp</div>' +
      '<p class="squad-source">Landslagsstatistik från Wikipedia, inhämtad före VM-slutspelet.</p>' +
      '<div class="players-status">Laddar trupp …</div>';
    body.appendChild(card);

    if (!window.VMPlayers) {
      card.querySelector(".players-status").innerHTML = errHint();
      return;
    }

    window.VMPlayers.load()
      .then(function () { renderSquad(card, team); })
      .catch(function () {
        var s = card.querySelector(".players-status");
        if (s) s.innerHTML = errHint();
      });
  }

  function errHint() {
    return '<div class="players-empty">Kunde inte ladda truppdatan.' +
      '<br><span class="muted">Kontrollera att <code>data/wc2026_players.json</code> finns och är giltig.</span></div>';
  }

  /** Högerkolumn: ålder om den finns, annars klubb. */
  function squadMeta(p) {
    if (p.age != null) return esc(p.age) + " år";
    if (p.club) return esc(p.club);
    return "–";
  }

  /** Presentationsklar status för ett spelar-id (skada/avstängning/osäker), eller null. */
  function statusOf(id) {
    return (window.VMPlayers && VMPlayers.getPlayerStatus) ? VMPlayers.getPlayerStatus(id) : null;
  }

  /** Liten statuspill (prick + etikett) för trupplistan. */
  function statusPill(st) {
    if (!st) return "";
    return '<span class="pstat pstat--' + st.cls + '" title="' + esc(st.text) + '">' +
      '<span class="pstat-dot"></span>' + esc(st.label) + '</span>';
  }

  function squadRow(p) {
    var meta = squadMeta(p);
    var metaTitle = p.club && p.age == null ? ' title="' + esc(p.club) + '"' : "";
    var st = statusOf(p.id);
    return '<button class="player-row' + (st ? " has-pstat" : "") + '" data-pid="' + esc(p.id) + '">' +
      '<span class="pr-name">' + esc(p.name) +
        (p.captain ? '<span class="pr-cap" title="Lagkapten">C</span>' : "") +
        statusPill(st) +
      '</span>' +
      '<span class="pr-meta"' + metaTitle + '>' + meta + '</span>' +
      '</button>';
  }

  function renderSquad(card, team) {
    var groups = window.VMPlayers.getPlayersByTeam(team.iso);
    var status = card.querySelector(".players-status");
    if (!groups.length) {
      if (status) status.innerHTML =
        '<div class="players-empty">Truppen är ännu inte tillgänglig för det här laget.</div>';
      return;
    }

    var html = "";
    groups.forEach(function (g) {
      html += '<div class="squad-group">' +
        '<div class="squad-group-head">' + esc(g.label) +
          '<span class="squad-count">' + g.players.length + '</span></div>' +
        '<div class="player-list">' +
          g.players.map(squadRow).join("") +
        '</div></div>';
    });

    var fetched = window.VMPlayers.getFetchedDate();
    if (fetched) {
      html += '<div class="squad-updated">Wikipedia · uppdaterad ' +
        esc(fmtDate(fetched) || fetched) + ' · statistik före VM-slutspelet</div>';
    }

    if (status) status.outerHTML = '<div class="squad">' + html + '</div>';

    card.querySelectorAll(".player-row").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var p = window.VMPlayers.getPlayerById(btn.getAttribute("data-pid"));
        if (p) openPlayer(p, team);
      });
    });
  }

  /* ---------- Spelarprofil (modal, statiska fält) ---------- */

  function ensureModal() {
    var m = document.getElementById("playerModal");
    if (m) return m;
    m = document.createElement("div");
    m.id = "playerModal";
    m.className = "player-modal";
    m.innerHTML = '<div class="pm-backdrop"></div><div class="pm-card" role="dialog" aria-modal="true"></div>';
    document.body.appendChild(m);
    m.querySelector(".pm-backdrop").addEventListener("click", closePlayer);
    m.querySelector(".pm-card").addEventListener("click", onModalClick);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePlayer(); });
    return m;
  }

  function statCell(val, label) {
    return '<div class="pm-stat"><span class="pm-val">' + dash(val) + '</span>' +
      '<span class="pm-lbl">' + esc(label) + '</span></div>';
  }

  /** Statruta där Wikipedia-bastalet (base) summeras med det spelaren samlat
      på sig i VM 2026 (add). Det stora talet är totalen (base + add); en liten
      rad under etiketten visar uppdelningen "<före> + <VM>" så att totalen inte
      kan förväxlas med en summa som ännu inte är gjord (t.ex. "31 +1" = totalt
      31, inte 32). */
  function statCellPlus(base, add, label) {
    add = add || 0;
    var total = base == null ? (add > 0 ? add : null) : base + add;
    var split = "";
    if (add > 0 && base != null) {
      split = '<span class="pm-split" title="' + base + ' före VM-slutspelet + ' +
        add + ' i VM 2026 = ' + total + ' totalt">' + esc(base) +
        ' <span class="pm-split-plus">+' + add + '</span></span>';
    } else if (add > 0) {
      split = '<span class="pm-split"><span class="pm-split-plus">+' + add +
        '</span> i VM 2026</span>';
    }
    return '<div class="pm-stat"><span class="pm-val">' +
      (total == null ? "–" : esc(total)) + '</span>' +
      '<span class="pm-lbl">' + esc(label) + '</span>' + split + '</div>';
  }

  function infoRow(label, val) {
    return '<div class="pm-row"><span class="pm-row-lbl">' + esc(label) + '</span>' +
      '<span class="pm-row-val">' + dash(val) + '</span></div>';
  }

  /** VM 2026-statistik för en spelare (från assets/playerstats.js), eller null. */
  function wcStatsFor(playerId) {
    var ps = window.VMPlayerStats;
    if (!ps || typeof ps.getPlayerStats !== "function" || playerId == null) return null;
    try { return ps.getPlayerStats(playerId); } catch (e) { return null; }
  }

  /** Profilfliken: Wikipedia-bas + VM-tillskott på landskamper/landslagsmål. */
  function profilPanelHtml(player, wc) {
    return '<div class="pm-stats">' +
        statCell(player.age, "Ålder") +
        statCellPlus(player.caps, wc ? wc.apps : 0, "Landskamper") +
        statCellPlus(player.goals, wc ? wc.goals : 0, "Landslagsmål") +
      '</div>' +
      '<div class="pm-info">' +
        infoRow("Tröjnummer", player.shirt_number) +
        infoRow("Position", player.position_sv) +
        infoRow("Födelsedatum", fmtDate(player.date_of_birth)) +
        infoRow("Klubb", player.club) +
        infoRow("Klubbland", player.club_country) +
      '</div>' +
      '<div class="pm-note">Stora talet är totalen. Raden under visar antalet ' +
        'före VM-slutspelet (från Wikipedia) + grönt tillägg ' +
        '<span class="pm-plus pm-plus-inline">+N</span> under VM 2026.</div>';
  }

  /** VM 2026-fliken: enbart det spelaren gjort under detta VM. */
  function vmPanelHtml(wc) {
    if (!wc || !wc.played) {
      return '<div class="pm-empty-vm">Har inte spelat någon match i VM 2026 ännu.</div>';
    }
    var goalsTitle = [];
    if (wc.pens) goalsTitle.push(wc.pens + " på straff");
    if (wc.og) goalsTitle.push(wc.og + " självmål (räknas ej)");
    var cards = "";
    if (wc.y) cards += '<span class="pm-card-pill y">' + wc.y + ' gul' + (wc.y === 1 ? "t" : "a") + '</span>';
    if (wc.r) cards += '<span class="pm-card-pill r">' + wc.r + ' röd' + (wc.r === 1 ? "tt" : "a") + '</span>';
    return '<div class="pm-stats pm-stats-vm">' +
        statCell(wc.apps, "Matcher") +
        statCell(wc.min ? wc.min + "'" : 0, "Minuter") +
        statCell(wc.goals, "Mål") +
        statCell(wc.assists, "Assist") +
      '</div>' +
      '<div class="pm-info">' +
        (goalsTitle.length ? infoRow("Varav", goalsTitle.join(" · ")) : "") +
        '<div class="pm-row"><span class="pm-row-lbl">Kort</span>' +
          '<span class="pm-row-val">' + (cards || "–") + '</span></div>' +
      '</div>' +
      '<div class="pm-note">Samlas in automatiskt från matchrapporterna (ESPN) under VM 2026.</div>';
  }

  function openPlayer(player, team) {
    var m = ensureModal();
    var sub = [];
    if (player.shirt_number != null) sub.push("#" + player.shirt_number);
    sub.push(player.position_sv || "");

    var wc = wcStatsFor(player.id);
    var hasWc = !!(wc && wc.played);
    var st = statusOf(player.id);

    var avatar = '<div class="pm-photo placeholder">' +
      esc((player.name || "?").charAt(0)) + '</div>';

    m.querySelector(".pm-card").innerHTML =
      '<button class="pm-close" title="Stäng">×</button>' +
      '<div class="pm-head">' + avatar +
        '<div class="pm-id">' +
          '<h3>' + esc(player.name) +
            (player.captain ? '<span class="pm-cap" title="Lagkapten">C</span>' : "") +
          '</h3>' +
          '<span class="pm-sub">' + esc(team.sv || team.name) + ' · ' +
            esc(sub.filter(Boolean).join(" · ")) + '</span>' +
        '</div></div>' +
      (st ? '<div class="pm-status pm-status--' + st.cls + '">' +
          '<span class="pm-status-dot"></span>' +
          '<span class="pm-status-txt"><strong>' + esc(st.label) + '</strong>' +
          (st.text !== st.label ? '<span class="pm-status-sub">' + esc(st.text) + '</span>' : "") +
          '</span></div>' : "") +
      '<div class="pm-tabs" role="tablist">' +
        '<button type="button" class="pm-tab active" data-pm-tab="profil">Profil</button>' +
        '<button type="button" class="pm-tab" data-pm-tab="vm">VM 2026' +
          (hasWc ? '<span class="pm-tab-badge">' + (wc.points || wc.apps) + '</span>' : "") +
        '</button>' +
      '</div>' +
      '<div class="pm-tab-panels">' +
        '<div class="pm-tab-panel active" data-pm-panel="profil">' + profilPanelHtml(player, wc) + '</div>' +
        '<div class="pm-tab-panel" data-pm-panel="vm">' + vmPanelHtml(wc) + '</div>' +
      '</div>';

    m.querySelector(".pm-close").addEventListener("click", closePlayer);
    m.classList.add("open");
  }

  /** Flikbyte i spelarmodalen (delegerat). */
  function onModalClick(e) {
    var tab = e.target.closest && e.target.closest("[data-pm-tab]");
    if (!tab) return;
    var card = tab.closest(".pm-card");
    if (!card) return;
    var name = tab.getAttribute("data-pm-tab");
    card.querySelectorAll("[data-pm-tab]").forEach(function (b) {
      b.classList.toggle("active", b === tab);
    });
    card.querySelectorAll("[data-pm-panel]").forEach(function (p) {
      p.classList.toggle("active", p.getAttribute("data-pm-panel") === name);
    });
  }

  function closePlayer() {
    var m = document.getElementById("playerModal");
    if (m) m.classList.remove("open");
  }

  /* ---------- WebSocket: realtid (live-data, separat) ---------- */

  var ws = null;
  var reconnectTimer = null;

  function connect() {
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", function () { setLiveStatus(true); });
    ws.addEventListener("message", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleMessage(msg);
    });
    ws.addEventListener("close", function () { setLiveStatus(false); scheduleReconnect(); });
    ws.addEventListener("error", function () { try { ws.close(); } catch (e) {} });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  }

  function handleMessage(msg) {
    if (msg.type === "live:goal") {
      var p = msg.payload || {};
      var scorer = (p.goals && p.goals.length) ? p.goals[p.goals.length - 1].player : null;
      goalToast((p.home && p.home.name) + " " + (p.score || "") + " " + (p.away && p.away.name),
        scorer ? "Mål: " + scorer : "");
    }
  }

  /* ---------- Notiser & status ---------- */

  function goalToast(title, sub) {
    var wrap = document.getElementById("liveToasts");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "liveToasts";
      document.body.appendChild(wrap);
    }
    var t = document.createElement("div");
    t.className = "live-toast";
    t.innerHTML = '<span class="lt-ic">⚽</span><div><div class="lt-title">' + esc(title) + '</div>' +
      (sub ? '<div class="lt-sub">' + esc(sub) + '</div>' : "") + '</div>';
    wrap.appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 20);
    setTimeout(function () { t.classList.remove("show"); setTimeout(function () { t.remove(); }, 400); }, 8000);
  }

  function setLiveStatus(on) {
    var badge = document.getElementById("syncBadge");
    if (badge) badge.classList.toggle("ws-on", !!on);
  }

  /* ---------- Init ---------- */

  window.VMLive = { onTeamDrawer: onTeamDrawer, openPlayer: openPlayer };

  // Anslut WebSocket när sidan laddats (för live-notiser; misslyckas tyst utan backend).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect);
  } else {
    connect();
  }
})();
