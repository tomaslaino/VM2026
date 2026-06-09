/*
  Synkar matchresultat från backend (football-data) till app.js.
  Uppdaterar grupper, slutspelsträd och kalender automatiskt.
*/
(function () {
  "use strict";

  var CFG = window.VM_CONFIG || {};
  var API = (CFG.backend || "").replace(/\/$/, "");

  function api(path) {
    return fetch(API + path, { headers: { Accept: "application/json" } }).catch(function () { return null; });
  }

  function wsUrl() {
    if (CFG.backend) return CFG.backend.replace(/^http/, "ws") + "/ws";
    var proto = location.protocol === "https:" ? "wss" : "ws";
    return proto + "://" + location.host + "/ws";
  }

  function apply(payload) {
    if (window.VMApp && typeof window.VMApp.mergeRemoteResults === "function") {
      window.VMApp.mergeRemoteResults(payload);
    }
  }

  function pull() {
    api("/api/results").then(function (r) {
      if (!r || !r.ok) return;
      return r.json();
    }).then(function (data) {
      if (data) apply(data);
    });
  }

  var ws = null;
  var reconnectTimer = null;

  function connect() {
    try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleReconnect(); return; }

    ws.addEventListener("open", function () { pull(); });
    ws.addEventListener("message", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === "results:updated") apply(msg.payload || msg);
    });
    ws.addEventListener("close", function () { scheduleReconnect(); });
    ws.addEventListener("error", function () { try { ws.close(); } catch (e) {} });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      pull();
      connect();
      setInterval(pull, 120000);
    });
  } else {
    pull();
    connect();
    setInterval(pull, 120000);
  }
})();
