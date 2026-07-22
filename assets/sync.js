/*
  Synkar matchresultat till app.js och uppdaterar grupper, slutspelsträd
  och kalender automatiskt.

  Två lägen:
   1. Backend-läge: VM_CONFIG.backend är satt (t.ex. en Render-server).
      Hämtar /api/results och lyssnar på WebSocket för direktuppdatering.
   2. Statiskt läge (standard, GitHub Pages): ingen backend behövs.
      Läser en statisk results.json som GitHub Actions uppdaterar
      automatiskt. Pollar oftare runt matcher, sällan däremellan.
*/
(function () {
  "use strict";

  var CFG = window.VM_CONFIG || {};
  var API = (CFG.backend || "").replace(/\/$/, "");
  var STATIC_URL = CFG.staticResults || "data/results.json";
  var USE_BACKEND = !!API;
  var pollTimer = null;
  var lastPayload = null;

  function setStatus(status) {
    if (window.VMApp && typeof window.VMApp.setSyncStatus === "function") {
      window.VMApp.setSyncStatus(status);
    }
  }

  function apply(payload) {
    if (payload) lastPayload = payload;
    if (window.VMApp && typeof window.VMApp.mergeRemoteResults === "function") {
      window.VMApp.mergeRemoteResults(payload);
    }
  }

  function pollIntervalMs() {
    // Arkivläge: turneringen är färdigspelad och datafilerna fryser – polla
    // mycket glest (en omladdning hämtar ändå alltid färskt underlag).
    if (Date.now() > Date.parse("2026-07-20T12:00:00Z")) return 1800000;
    if (USE_BACKEND) {
      var now = new Date();
      var start = new Date("2026-06-11T00:00:00Z");
      var end = new Date("2026-07-20T00:00:00Z");
      if (now >= start && now <= end) return 60000;
      return 180000;
    }

    if (window.VMSyncSchedule && lastPayload) {
      var plan = window.VMSyncSchedule.getSyncUrgency(lastPayload);
      return plan.pollSec * 1000;
    }

    return 180000;
  }

  function staticUrl() {
    return STATIC_URL + (STATIC_URL.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
  }

  function resultsUrl() {
    if (USE_BACKEND) return API + "/api/results";
    return staticUrl();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      pull().finally(schedulePoll);
    }, pollIntervalMs());
  }

  function fetchJson(url) {
    return fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return (r && r.ok) ? r.json() : null; });
  }

  // Backend nere/i viloläge → läs den statiska filen så sidan aldrig blir tom.
  function fallbackStatic() {
    return fetchJson(staticUrl())
      .then(function (data) {
        if (data) { apply(data); setStatus("ok"); }
        else setStatus("error");
      })
      .catch(function () { setStatus("error"); });
  }

  function pull() {
    setStatus("pending");
    return fetchJson(resultsUrl())
      .then(function (data) {
        if (data) {
          apply(data);
          setStatus("ok");
          return;
        }
        if (USE_BACKEND) return fallbackStatic();
        setStatus("error");
      })
      .catch(function () {
        if (USE_BACKEND) return fallbackStatic();
        setStatus("error");
      });
  }

  // --- WebSocket (endast i backend-läge) ---
  var ws = null;
  var reconnectTimer = null;

  function wsUrl() {
    return API.replace(/^http/, "ws") + "/ws";
  }

  function connect() {
    try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleReconnect(); return; }

    ws.addEventListener("open", function () { pull(); });
    ws.addEventListener("message", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === "results:updated") {
        apply(msg.payload || msg);
        setStatus("ok");
      }
    });
    ws.addEventListener("close", function () { scheduleReconnect(); });
    ws.addEventListener("error", function () { try { ws.close(); } catch (e) {} });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  }

  function start() {
    pull();
    if (USE_BACKEND) connect();
    schedulePoll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
