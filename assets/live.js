/*
  VM 2026 – live-modul (frontend).
  Pratar med din egen backend ("mellanhanden"), aldrig direkt med sport-API:t.

  - Hämtar spelarlistor + statistik per lag (cachas lokalt i webbläsaren).
  - Injicerar en spelarlista i lag-lådan (hook från app.js: window.VMLive.onTeamDrawer).
  - Öppnar en spelarprofil när man klickar på en spelare.
  - Lyssnar på WebSocket och visar mål-notiser + uppdaterar live-ställning i realtid.

  Backend-URL:
    Körs sidan från Node-servern → samma origin (inget att konfigurera).
    Ligger sidan på GitHub Pages → sätt window.VM_CONFIG = { backend: "https://din-backend.exempel.com" }
    före denna fil i index.html.
*/
(function () {
  "use strict";

  var CFG = window.VM_CONFIG || {};
  var BACKEND = (CFG.backend || "").replace(/\/$/, ""); // tom = samma origin
  var API = BACKEND || "";

  function wsUrl() {
    if (BACKEND) return BACKEND.replace(/^http/, "ws") + "/ws";
    var proto = location.protocol === "https:" ? "wss" : "ws";
    return proto + "://" + location.host + "/ws";
  }

  var teamCache = {};   // normaliserat lagnamn -> team-objekt med spelare
  var available = null; // null=okänt, true/false = backend nås
  var lastTeam = null;  // senaste lag som visades i lådan (för uppdatering)

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function api(path) {
    return fetch(API + path, { headers: { Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  /* ---------- Spelarlista i lag-lådan ---------- */

  function onTeamDrawer(team, group, drawer) {
    lastTeam = { team: team, group: group, drawer: drawer };
    var body = drawer.querySelector(".drawer-body");
    if (!body) return;

    var card = document.createElement("div");
    card.className = "drawer-card players-card";
    card.innerHTML = '<div class="dc-title">Trupp & spelarstatistik</div>' +
      '<div class="players-status">Hämtar spelare …</div>';
    body.appendChild(card);

    // team.name = engelskt namn (matchar backend). Slå upp via namn.
    api("/api/teams/" + encodeURIComponent(team.name))
      .then(function (data) {
        available = true;
        teamCache[team.name] = data;
        renderPlayers(card, data);
      })
      .catch(function () {
        if (available === null) available = false;
        card.querySelector(".players-status").innerHTML = backendHint();
      });
  }

  function backendHint() {
    return '<div class="players-empty">Spelardata visas när backend-servern körs.' +
      '<br><span class="muted">Starta servern (<code>npm start</code>) och kör trupphämtningen, ' +
      'eller peka <code>window.VM_CONFIG.backend</code> mot din driftade server.</span></div>';
  }

  function posLabel(p) {
    return { Goalkeeper: "MV", Defender: "FB", Midfielder: "MF", Attacker: "FW" }[p] || (p || "");
  }

  function renderPlayers(card, team) {
    var players = (team.players || []).slice();
    if (!players.length) {
      card.querySelector(".players-status").innerHTML =
        '<div class="players-empty">Trupp ännu inte hämtad för det här laget.</div>';
      return;
    }
    var order = { Goalkeeper: 0, Defender: 1, Midfielder: 2, Attacker: 3 };
    players.sort(function (a, b) {
      var o = (order[a.position] ?? 9) - (order[b.position] ?? 9);
      return o || ((a.number || 99) - (b.number || 99));
    });

    var rows = players.map(function (p) {
      var s = p.stats || {};
      return '<button class="player-row" data-pid="' + esc(p.id) + '">' +
        '<span class="pr-num">' + (p.number != null ? esc(p.number) : "–") + '</span>' +
        '<span class="pr-name">' + esc(p.name) +
          '<span class="pr-pos">' + esc(posLabel(p.position)) + '</span></span>' +
        '<span class="pr-stat" title="Mål">⚽ ' + (s.goals || 0) + '</span>' +
        '<span class="pr-stat" title="Assist">🅰 ' + (s.assists || 0) + '</span>' +
        '<span class="pr-stat yc" title="Gula kort">▌ ' + (s.yellow || 0) + '</span>' +
        '</button>';
    }).join("");

    card.querySelector(".players-status").outerHTML = '<div class="player-list">' + rows + '</div>';

    card.querySelectorAll(".player-row").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var pid = btn.getAttribute("data-pid");
        var player = (team.players || []).filter(function (x) { return String(x.id) === String(pid); })[0];
        if (player) openPlayer(player, team);
      });
    });
  }

  /* ---------- Spelarprofil (modal) ---------- */

  function ensureModal() {
    var m = document.getElementById("playerModal");
    if (m) return m;
    m = document.createElement("div");
    m.id = "playerModal";
    m.className = "player-modal";
    m.innerHTML = '<div class="pm-backdrop"></div><div class="pm-card" role="dialog" aria-modal="true"></div>';
    document.body.appendChild(m);
    m.querySelector(".pm-backdrop").addEventListener("click", closePlayer);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePlayer(); });
    return m;
  }

  function statCell(val, label) {
    return '<div class="pm-stat"><span class="pm-val">' + esc(val) + '</span>' +
      '<span class="pm-lbl">' + esc(label) + '</span></div>';
  }

  function openPlayer(player, team) {
    var m = ensureModal();
    var s = player.stats || {};
    var photo = player.photo
      ? '<img class="pm-photo" src="' + esc(player.photo) + '" alt="" onerror="this.style.display=\'none\'">'
      : '<div class="pm-photo placeholder">' + esc((player.name || "?").charAt(0)) + '</div>';

    m.querySelector(".pm-card").innerHTML =
      '<button class="pm-close" title="Stäng">×</button>' +
      '<div class="pm-head">' + photo +
        '<div class="pm-id"><h3>' + esc(player.name) + '</h3>' +
        '<span class="pm-sub">' + esc(team.name) +
          (player.number != null ? ' · #' + esc(player.number) : "") +
          (player.position ? ' · ' + esc(player.position) : "") + '</span></div></div>' +
      '<div class="pm-stats">' +
        statCell(s.goals || 0, "Mål") +
        statCell(s.assists || 0, "Assist") +
        statCell(s.yellow || 0, "Gula") +
        statCell(s.red || 0, "Röda") +
        statCell(s.minutes || 0, "Minuter") +
        statCell(s.appearances || 0, "Matcher") +
      '</div>' +
      '<div class="pm-note">Statistik uppdateras automatiskt efter varje match.</div>';

    m.querySelector(".pm-close").addEventListener("click", closePlayer);
    m.classList.add("open");
  }

  function closePlayer() {
    var m = document.getElementById("playerModal");
    if (m) m.classList.remove("open");
  }

  /* ---------- WebSocket: realtid ---------- */

  var ws = null;
  var reconnectTimer = null;

  function connect() {
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", function () {
      available = true;
      setLiveStatus(true);
    });
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
    } else if (msg.type === "stats:updated") {
      // Statistik har slutkontrollerats – töm cache och uppdatera öppen låda.
      teamCache = {};
      if (lastTeam) refreshOpenDrawer();
    } else if (msg.type === "live:scores") {
      // Här kan live-ställning kopplas mot app.js vid behov.
    }
  }

  function refreshOpenDrawer() {
    var drawer = document.getElementById("teamDrawer");
    if (!drawer || !drawer.classList.contains("open") || !lastTeam) return;
    var existing = drawer.querySelector(".players-card");
    if (existing) existing.remove();
    onTeamDrawer(lastTeam.team, lastTeam.group, drawer);
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
    var dot = document.querySelector(".brand-mark");
    if (dot) dot.classList.toggle("ws-on", !!on);
  }

  /* ---------- Init ---------- */

  window.VMLive = { onTeamDrawer: onTeamDrawer };

  // Anslut WebSocket när sidan laddats.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect);
  } else {
    connect();
  }
})();
