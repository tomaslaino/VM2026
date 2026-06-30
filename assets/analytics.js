/* Integritetsvänlig besöksmätning – skickar beacons till backend, ingen tredjepart. */
(function () {
  var lastTrackedView = null;
  var viewSince = Date.now();

  function cfg() { return window.VM_CONFIG || {}; }

  function baseUrl() {
    var c = cfg();
    if (c.analytics === false) return null;
    var b = c.backend ? String(c.backend).replace(/\/$/, "") : "";
    return b || null;
  }

  function getVisitorId() {
    try {
      var k = "vm2026:vid";
      var v = localStorage.getItem(k);
      if (!v) {
        v = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return null;
    }
  }

  function getSessionId() {
    try {
      var k = "vm2026:sid";
      var v = sessionStorage.getItem(k);
      if (!v) {
        v = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return null;
    }
  }

  function send(payload) {
    var url = baseUrl();
    if (!url) return;
    try {
      var body = JSON.stringify(Object.assign({
        visitor: getVisitorId(),
        session: getSessionId(),
        ref: document.referrer || "",
      }, payload));
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url + "/api/track", body);
      } else {
        fetch(url + "/api/track", {
          method: "POST", body: body, keepalive: true,
          headers: { "Content-Type": "text/plain" },
        }).catch(function () {});
      }
    } catch (e) { /* mätning får aldrig störa sidan */ }
  }

  function trackView(view) {
    if (!view || view === lastTrackedView) return;
    var dur = null;
    if (lastTrackedView) {
      dur = Math.min(Math.max(0, Math.round((Date.now() - viewSince) / 1000)), 86400);
    }
    send({ kind: "view", view: view, duration: dur });
    lastTrackedView = view;
    viewSince = Date.now();
  }

  function trackEvent(kind, detail) {
    if (!kind || !detail) return;
    send({ kind: kind, detail: String(detail).slice(0, 120) });
  }

  window.VMAnalytics = { trackView: trackView, trackEvent: trackEvent };
})();
