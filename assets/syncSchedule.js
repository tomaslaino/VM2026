/*
  Browser-version av server/syncSchedule.js – samma logik för poll-intervall.
*/
(function () {
  "use strict";

  var LIVE = { IN_PLAY: 1, PAUSED: 1, LIVE: 1, HALFTIME: 1 };
  var FINISHED = { FINISHED: 1, AWARDED: 1 };
  var TOURNAMENT_START = Date.parse("2026-06-11T00:00:00Z");
  var TOURNAMENT_END = Date.parse("2026-07-20T00:00:00Z");

  function swedishToday(now) {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Stockholm",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now || new Date());
  }

  function fixtureKickoffMs(fx) {
    if (!fx) return NaN;
    if (fx.utcDate) return Date.parse(fx.utcDate);
    if (fx.date && fx.time) {
      var p = fx.date.split("-").map(Number);
      var t = fx.time.split(":").map(Number);
      return Date.UTC(p[0], p[1] - 1, p[2], t[0] - 2, t[1]);
    }
    return NaN;
  }

  function getSyncUrgency(snapshot, now) {
    now = now || new Date();
    var ms = now.getTime();

    if (ms < TOURNAMENT_START || ms > TOURNAMENT_END) {
      return { level: "offseason", pollSec: 1800 };
    }

    var fixtures = snapshot && snapshot.fixtures ? Object.keys(snapshot.fixtures).map(function (k) {
      return snapshot.fixtures[k];
    }) : [];
    var results = snapshot && snapshot.results ? Object.keys(snapshot.results).map(function (k) {
      return snapshot.results[k];
    }) : [];
    var i, fx, kick, until;

    for (i = 0; i < fixtures.length; i++) {
      if (LIVE[fixtures[i].status]) return { level: "live", pollSec: 30 };
    }
    for (i = 0; i < results.length; i++) {
      if (LIVE[results[i].status]) return { level: "live", pollSec: 30 };
    }
    if (snapshot && snapshot.live && snapshot.live.length) {
      return { level: "live", pollSec: 30 };
    }

    var soonMs = 90 * 60 * 1000;
    var recentAfterMs = 45 * 60 * 1000;
    var matchWindowMs = 110 * 60 * 1000;

    for (i = 0; i < fixtures.length; i++) {
      fx = fixtures[i];
      kick = fixtureKickoffMs(fx);
      if (!isFinite(kick)) continue;

      if (!fx.status || fx.status === "TIMED" || fx.status === "SCHEDULED") {
        until = kick - ms;
        if (until > 0 && until <= soonMs) return { level: "soon", pollSec: 60 };
      }

      if (FINISHED[fx.status] && ms >= kick && ms <= kick + matchWindowMs + recentAfterMs) {
        return { level: "recent", pollSec: 90 };
      }
    }

    var today = swedishToday(now);
    for (i = 0; i < fixtures.length; i++) {
      if (fixtures[i].date === today) return { level: "matchday", pollSec: 180 };
    }

    return { level: "idle", pollSec: 600 };
  }

  window.VMSyncSchedule = { getSyncUrgency: getSyncUrgency };
})();
