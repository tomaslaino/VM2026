/* VM 2026 – app-logik: tabeller, bästa trea, slutspelsträd, kalender,
   lagsök, slutspelsinfo och realtidsuppdatering. */
(function () {
  "use strict";

  var STORE_KEY = "vm2026:v1";

  /* ---------- State ---------- */
  var state = loadState();
  var expandedGroups = {};      // letter -> bool (visa matcher)
  var selectedTeam = null;      // { group, idx } för lag-panelen (ej persistent)
  var hoverMatch = null;        // matchnummer med öppen infopanel i slutspelet
  var autoSync = { active: false, source: null, updatedAt: null, status: "pending" };
  var apiFixtures = {}; // nyckel -> { date, time, home, away, homeRef, awayRef, status } från API
  var apiStandings = {}; // grupp-bokstav -> [{ idx, position, pld, w, d, l, gf, ga, gd, pts }] från API
  var apiLive = {};      // nyckel -> { status, minute, score } för pågående matcher från API
  var focusDetails = {}; // nyckel -> matchdetaljer (mål m.m.) för startsidans hjälte
  var fairPlayMap = {};  // "L:idx" -> { y, r, pts } beräknat från matchdetaljernas kort
  var calScrollPending = false; // scrolla till nästa matchdag vid öppning av kalender
  var calGroupOpen = null;      // grupp-bokstav för öppen tabell-popup i kalendern

  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        return { results: p.results || {}, ui: p.ui || {} };
      }
    } catch (e) {}
    return { results: {}, ui: {} };
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function ui(key, def) { return state.ui[key] !== undefined ? state.ui[key] : def; }
  function setUi(key, val) { state.ui[key] = val; saveState(); }

  /* ---------- Hjälpare ---------- */
  var MONTHS = ["jan","feb","mars","apr","maj","juni","juli","aug","sep","okt","nov","dec"];
  var MONTHS_LONG = ["januari","februari","mars","april","maj","juni","juli","augusti","september","oktober","november","december"];
  var WEEKDAYS = ["sön","mån","tis","ons","tors","fre","lör"];
  var WEEKDAYS_LONG = ["söndag","måndag","tisdag","onsdag","torsdag","fredag","lördag"];

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  /** CSS-klass för grupppill (A–L får varsin färg via .grp-X i styles.css). */
  function groupPillClass(letter, extra) {
    var L = String(letter || "").toUpperCase();
    return "group-pill grp-" + L + (extra ? " " + extra : "");
  }
  function flagUrl(iso) { return "https://flagcdn.com/" + iso + ".svg"; }
  function flagImg(iso) {
    return '<img class="flag" loading="lazy" src="' + flagUrl(iso) + '" alt="" ' +
           'onerror="this.style.visibility=\'hidden\'">';
  }
  function matchExpandBtn(matchNo, expanded) {
    var label = expanded ? "Dölj matchinfo" : "Visa matchinfo";
    return '<button type="button" class="match-expand' + (expanded ? " on" : "") + '" data-expand-match="' + matchNo + '" ' +
      'title="' + label + '" aria-label="' + label + '" aria-expanded="' + (expanded ? "true" : "false") + '">' +
      '<svg class="match-expand-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg></button>';
  }
  function teamSvFixture(team) {
    if (team.svShort) return team.svShort;
    var sv = team.sv;
    var och = sv.indexOf(" och ");
    if (och > 0) return sv.slice(0, och);
    return sv;
  }
  function fixtureTeamName(team) {
    var compact = teamSvFixture(team);
    return '<span class="t-name" title="' + esc(team.sv) + '">' + esc(compact) + '</span>';
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function parseDateUTC(s) {
    var p = s.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  function shiftDateUTC(dateStr, days) {
    var d = parseDateUTC(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }

  /* Absolut tidpunkt (UTC) för avspark. Tider i data lagras som svensk tid (CEST, UTC+2). */
  function kickoffUTC(m) {
    var p = m.date.split("-").map(Number);
    var hh = 18, mm = 0;
    if (m.edt) {
      var parts = m.edt.split(":");
      hh = parseInt(parts[0], 10);
      mm = parseInt(parts[1] || "0", 10);
    }
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], hh - 2, mm));
  }

  /* Datum/tid-etiketter (svensk tid). */
  function whenLabels(m) {
    var d2 = parseDateUTC(m.date);
    var dateLabel = WEEKDAYS[d2.getUTCDay()] + " " + d2.getUTCDate() + " " + MONTHS[d2.getUTCMonth()];
    if (!m.edt) return { dateLabel: dateLabel, time: "tid TBC" };
    return { dateLabel: dateLabel, time: m.edt };
  }

  /* Relativ tid till avspark, ex "om 3 dagar", "Pågår", "Spelad". */
  function relativeLabel(m, played, resKey) {
    if (played) return { cls: "done", txt: "Spelad" };
    if (resKey) {
      var rs = getRes(resKey);
      if (rs && (rs.status === "IN_PLAY" || rs.status === "PAUSED" || rs.status === "LIVE"))
        return { cls: "live", txt: "Pågår nu" };
    }
    var now = Date.now();
    var ko = kickoffUTC(m).getTime();
    var diff = ko - now;
    var twoH = 2 * 3600 * 1000;
    if (diff <= 0 && diff > -twoH) return { cls: "live", txt: "Pågår nu" };
    if (diff <= -twoH) return { cls: "await", txt: "Inväntar resultat" };
    var mins = Math.round(diff / 60000);
    if (mins < 60) return { cls: "soon", txt: "om " + mins + " min" };
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return { cls: "soon", txt: "om " + hrs + " tim" };
    var days = Math.floor(hrs / 24);
    return { cls: "up", txt: "om " + days + (days === 1 ? " dag" : " dagar") };
  }

  /* ---------- Resultathantering (endast från API) ---------- */
  function getRes(key) { return state.results[key] || null; }
  function isPlayed(r) { return r && r.h !== undefined && r.a !== undefined; }

  function isLiveStatus(status) {
    return status === "IN_PLAY" || status === "PAUSED" || status === "LIVE";
  }

  function isMatchLive(key) {
    // Backendens live-lista är den färskaste signalen – ta den först så att en
    // match räknas som pågående även i glappet innan status/resultat hunnit
    // skrivas in i results/fixtures.
    if (apiLive[key]) return true;
    var fx = getApiFixture(key);
    if (fx && isLiveStatus(fx.status)) return true;
    var rs = getRes(key);
    return rs && isLiveStatus(rs.status);
  }

  function scoreDisplay(val) {
    var empty = val === undefined || val === null || val === "";
    return '<span class="score-display' + (empty ? " score-empty" : "") + '">' + (empty ? "–" : val) + "</span>";
  }

  function scorePair(r) {
    r = r || {};
    return '<span class="fx-score">' + scoreDisplay(r.h) + '<span class="dash">–</span>' + scoreDisplay(r.a) + "</span>";
  }

  function liveTimeLabel(key, fallback) {
    if (!isMatchLive(key)) return fallback;
    return '<span class="fx-live"><span class="live-dot"></span>LIVE</span>';
  }

  function getApiFixture(key) { return apiFixtures[key] || null; }

  /** Matchen är klickbar (matchinfo-vy). Pågående/spelade matcher visar
      händelser, ställning och statistik; kommande matcher visar preliminär
      laguppställning och tabell. Alltid öppningsbar så länge lagen är kända. */
  function isMatchOpenable() {
    return true;
  }

  /** Attribut + klass för klickbara matchrader. */
  function matchOpenAttr(key, hasTeams) {
    if (hasTeams === false || !isMatchOpenable(key)) return { attr: "", cls: "" };
    return { attr: ' data-match-open="' + key + '" role="button" tabindex="0"', cls: " match-openable" };
  }

  /**
   * Beskrivning av en match utifrån resultatnyckel ("g:A:0" / "k:73") –
   * används av matchinfo-modalen (assets/matchinfo.js).
   */
  function describeMatch(key) {
    var info = null;
    var g = /^g:([A-L]):(\d+)$/.exec(key);
    if (g) {
      var L = g[1];
      var fx = null;
      groupFixtures(L).forEach(function (f) { if (f.key === key) fx = f; });
      if (!fx) return null;
      var th = WC.groups[L][fx.h], ta = WC.groups[L][fx.a];
      info = {
        key: key, label: "Grupp " + L, kind: "group",
        home: th, away: ta, m: fx,
        channel: tvLookupGroup(fx, th, ta), venue: null
      };
    } else {
      var k = /^k:(\d+)$/.exec(key);
      if (!k) return null;
      var no = parseInt(k[1], 10);
      var ctx = getCtx();
      var res = ctx.resolved[no];
      if (!res) return null;
      info = {
        key: key, label: WC.roundNames[res.match.round] + " · M" + no, kind: "ko",
        home: res.home.team || null, away: res.away.team || null, m: res.match,
        channel: tvLookupKo(res.match), venue: WC.venues[res.match.venue] || null,
        homeLabel: res.home.label, awayLabel: res.away.label
      };
    }
    info.r = getRes(key);
    info.fixture = getApiFixture(key);
    info.live = isMatchLive(key);
    info.played = isPlayed(info.r);
    info.when = whenLabels(info.m);
    return info;
  }

  /** Slå in resultat + schema från backend (football-data). Uppdaterar grupper/slutspel/kalender. */
  function mergeRemoteResults(payload) {
    if (!payload) return false;
    var changed = false;
    var fixturesChanged = false;

    if (payload.fixtures) {
      var nextFx = JSON.stringify(payload.fixtures);
      if (nextFx !== JSON.stringify(apiFixtures)) {
        apiFixtures = payload.fixtures;
        fixturesChanged = true;
      }
    }

    if (payload.standings) {
      var nextSt = JSON.stringify(payload.standings);
      if (nextSt !== JSON.stringify(apiStandings)) {
        apiStandings = payload.standings;
        fixturesChanged = true;
      }
    }

    if (payload.live !== undefined) {
      var liveMap = {};
      (payload.live || []).forEach(function (l) { if (l && l.key) liveMap[l.key] = l; });
      if (JSON.stringify(liveMap) !== JSON.stringify(apiLive)) {
        apiLive = liveMap;
        fixturesChanged = true;
      }
    }

    if (payload.results) {
      var results = payload.results;
      for (var key in results) {
        if (!Object.prototype.hasOwnProperty.call(results, key)) continue;
        var r = results[key];
        if (r.h === undefined || r.a === undefined) continue;
        var cur = state.results[key];
        if (!cur || cur.h !== r.h || cur.a !== r.a || cur.pw !== r.pw || cur.status !== r.status) {
          state.results[key] = { h: r.h, a: r.a };
          if (r.pw) state.results[key].pw = r.pw;
          if (r.status) state.results[key].status = r.status;
          changed = true;
        }
      }
    }

    if (payload.meta) {
      autoSync.active = true;
      autoSync.status = "ok";
      autoSync.source = payload.meta.source || "espn";
      autoSync.updatedAt = payload.meta.updatedAt || null;
    }

    if (changed || fixturesChanged) {
      if (changed) saveState();
      refresh({ full: true });
      updateSyncBadge();
    } else if (payload.meta) {
      updateSyncBadge();
    }
    // Uppdatera ev. öppen matchinfo-modal med ny ställning/status.
    if ((changed || fixturesChanged) && window.VMMatchInfo &&
        typeof window.VMMatchInfo.onDataUpdated === "function") {
      try { window.VMMatchInfo.onDataUpdated(); } catch (e) {}
    }
    // Nya resultat → hämta även matchdetaljer (kort/fair play till tabellerna).
    if (changed && window.VMMatchInfo &&
        typeof window.VMMatchInfo.refreshDetails === "function") {
      try { window.VMMatchInfo.refreshDetails(); } catch (e) {}
    }
    return changed || fixturesChanged;
  }

  /* ---------- Fair play (gula/röda kort från matchdetaljerna) ----------
     FIFA:s fair play-poäng per match och spelare (hårdaste avdraget gäller):
       gult kort −1 · andra gula (utvisning) −3 · direkt rött −4 ·
       gult + direkt rött −5. Endast gruppspelet räknas. */
  function computeFairPlay(details) {
    var map = {};
    Object.keys(details || {}).forEach(function (key) {
      var g = /^g:([A-L]):(\d+)$/.exec(key);
      if (!g) return;
      var det = details[key];
      if (!det || !det.bookings || !det.bookings.length) return;
      var L = g[1];
      var i = parseInt(g[2], 10);
      var pair = RR[Math.floor(i / 2)][i % 2];
      var teamIdx = { h: pair[0], a: pair[1] };
      var players = {};
      det.bookings.forEach(function (b) {
        if (!b || (b.team !== "h" && b.team !== "a")) return;
        var pk = b.team + "|" + (b.player || "?" + b.minute);
        var p = players[pk] || (players[pk] = { side: b.team, y: 0, yr: 0, r: 0 });
        if (b.card === "YELLOW") p.y++;
        else if (b.card === "YELLOW_RED") p.yr++;
        else if (b.card === "RED") p.r++;
      });
      Object.keys(players).forEach(function (pk) {
        var p = players[pk];
        var slotKey = L + ":" + teamIdx[p.side];
        var slot = map[slotKey] || (map[slotKey] = { y: 0, r: 0, pts: 0 });
        slot.y += p.y;
        slot.r += p.yr + p.r;
        var ded;
        if (p.yr || (!p.r && p.y >= 2)) ded = 3;       // andra gula kortet
        else if (p.r) ded = p.y ? 5 : 4;               // direkt rött (+ ev. gult)
        else ded = p.y ? 1 : 0;
        slot.pts -= ded;
      });
    });
    return map;
  }

  /** Tar emot matchdetaljer (assets/matchinfo.js) och uppdaterar fair play
      samt spelarstatistiken (assets/playerstats.js). */
  var rawDetailsJson = "";
  function setMatchDetails(details) {
    var rawJson = JSON.stringify(details || {});
    if (rawJson === rawDetailsJson) return;
    rawDetailsJson = rawJson;
    focusDetails = details || {};
    if (window.VMPlayerStats && typeof window.VMPlayerStats.setDetails === "function") {
      try { window.VMPlayerStats.setDetails(details); } catch (e) {}
    }
    var next = computeFairPlay(details);
    if (JSON.stringify(next) === JSON.stringify(fairPlayMap)) return;
    fairPlayMap = next;
    refresh({ full: true });
  }

  function fpOf(letter, idx) {
    return fairPlayMap[letter + ":" + idx] || { y: 0, r: 0, pts: 0 };
  }

  function setSyncStatus(status) {
    autoSync.status = status;
    if (status === "ok") autoSync.active = true;
    updateSyncBadge();
  }

  function updateSyncBadge() {
    var el = document.getElementById("syncBadge");
    if (!el) return;
    el.hidden = false;
    el.classList.remove("pending", "ok", "error");
    if (autoSync.status === "ok" && autoSync.updatedAt) {
      el.classList.add("ok");
      el.textContent = "Auto · ESPN";
      el.title = "Senast uppdaterad: " + new Date(autoSync.updatedAt).toLocaleString("sv-SE");
    } else if (autoSync.status === "error") {
      el.classList.add("error");
      el.textContent = "Ingen backend";
      el.title = "Kunde inte hämta resultat. Kontrollera att servern körs och att VM_CONFIG.backend pekar rätt.";
    } else {
      el.classList.add("pending");
      el.textContent = "Hämtar…";
      el.title = "Resultat hämtas automatiskt från ESPN";
    }
  }

  /* ---------- Gruppspelets matcher (round-robin, 4 lag) ---------- */
  var RR = [ [[0,1],[2,3]], [[0,2],[3,1]], [[3,0],[1,2]] ];

  function koMatchDisplay(mt) {
    var fx = getApiFixture("k:" + mt.m);
    return {
      date: (fx && fx.date) || mt.date,
      edt: (fx && fx.time) || mt.edt,
      m: mt.m, round: mt.round, venue: mt.venue, home: mt.home, away: mt.away,
      status: fx ? fx.status : null
    };
  }

  function sideFromApiRef(ref) {
    if (!ref || !WC.groups[ref.group]) return null;
    var t = WC.groups[ref.group][ref.idx];
    if (!t) return null;
    return { team: t, decided: true, label: t.sv, fromApi: true };
  }

  function apiKnockoutSide(fx, which) {
    if (!fx) return null;
    var ref = which === "home" ? fx.homeRef : fx.awayRef;
    return sideFromApiRef(ref);
  }

  function groupFixtures(letter) {
    var out = [], idx = 0;
    for (var md = 0; md < RR.length; md++) {
      for (var j = 0; j < RR[md].length; j++) {
        var key = "g:" + letter + ":" + idx;
        var api = getApiFixture(key);
        var sched = api || (WC.groupSchedule && WC.groupSchedule[key]);
        out.push({
          key: key, md: md + 1,
          h: RR[md][j][0], a: RR[md][j][1],
          date: sched ? sched.date : WC.groupDates[letter][md],
          edt: sched ? (sched.time || sched.edt) : null,
          letter: letter
        });
        idx++;
      }
    }
    return out;
  }

  function sortFixturesChrono(fixtures) {
    return fixtures.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      var at = a.edt || "99:99", bt = b.edt || "99:99";
      return at < bt ? -1 : at > bt ? 1 : 0;
    });
  }

  /* ---------- Tabellberäkning ---------- */
  function emptyStat(team, idx) {
    return { team: team, idx: idx, pld:0, w:0, d:0, l:0, gf:0, ga:0, gd:0, pts:0, fp:0, fpY:0, fpR:0 };
  }
  /* Jämförelse av två lag enligt FIFA-ordning (utom inbördes möte):
     poäng → målskillnad → gjorda mål → fair play → vinster. */
  function cmpOverall(y, x) { // returnerar positivt om y ska före x
    return (y.pts - x.pts) || (y.gd - x.gd) || (y.gf - x.gf) || (y.fp - x.fp) || (y.w - x.w) || (x.idx - y.idx);
  }
  /* Sortera tabellen enligt API:ets officiella ordning (om den finns, täcker
     alla lag och stämmer med lokalt beräknad statistik). Returnerar true om
     ordningen tillämpades. API-tabeller kan släpa efter nya resultat – då
     faller vi tillbaka på lokal FIFA-sortering så placering och siffror hänger
     ihop. */
  function applyApiOrder(letter, st) {
    var rows = apiStandings[letter];
    if (!rows || !rows.length) return false;
    var posByIdx = {};
    var apiByIdx = {};
    rows.forEach(function (row) {
      posByIdx[row.idx] = row.position;
      apiByIdx[row.idx] = row;
    });
    var allHave = st.every(function (s) { return posByIdx[s.idx] != null; });
    if (!allHave) return false;
    var statsMatch = st.every(function (s) {
      var api = apiByIdx[s.idx];
      return s.pld === api.pld && s.pts === api.pts && s.gf === api.gf && s.ga === api.ga;
    });
    if (!statsMatch) return false;
    st.sort(function (x, y) {
      return (posByIdx[x.idx] - posByIdx[y.idx]) || cmpOverall(y, x) || (x.idx - y.idx);
    });
    st.forEach(function (s, k) { s.rank = k; });
    return true;
  }

  function computeTable(letter) {
    var teams = WC.groups[letter];
    var st = teams.map(function (t, i) { return emptyStat(t, i); });
    var fixtures = groupFixtures(letter);
    fixtures.forEach(function (fx) {
      var r = getRes(fx.key);
      if (!isPlayed(r)) return;
      var H = st[fx.h], A = st[fx.a];
      H.pld++; A.pld++;
      H.gf += r.h; H.ga += r.a; A.gf += r.a; A.ga += r.h;
      if (r.h > r.a) { H.w++; A.l++; H.pts += 3; }
      else if (r.h < r.a) { A.w++; H.l++; A.pts += 3; }
      else { H.d++; A.d++; H.pts++; A.pts++; }
    });
    st.forEach(function (s) {
      s.gd = s.gf - s.ga;
      var f = fpOf(letter, s.idx);
      s.fpY = f.y; s.fpR = f.r; s.fp = f.pts;
    });

    // Officiell tabellordning från API (inkl. fair play m.m.) när den är i fas
    // med matchresultaten. Annars FIFA-sortering på lokalt beräknad statistik.
    if (applyApiOrder(letter, st)) return st;

    var allZeroPts = st.every(function (s) { return s.pts === 0; });
    if (allZeroPts) {
      st.sort(function (x, y) { return x.team.sv.localeCompare(y.team.sv, "sv"); });
    } else {
      st.sort(function (x, y) {
        return cmpOverall(y, x) || (x.idx - y.idx);
      });
      // Inbördes möte vid lika på poäng+målskillnad+gjorda mål
      var i = 0;
      while (i < st.length) {
        var j = i + 1;
        while (j < st.length && st[j].pts === st[i].pts && st[j].gd === st[i].gd && st[j].gf === st[i].gf) j++;
        if (j - i > 1) tieBreakHeadToHead(st, i, j, fixtures);
        i = j;
      }
    }
    st.forEach(function (s, k) { s.rank = k; });
    return st;
  }
  function tieBreakHeadToHead(st, from, to, fixtures) {
    var group = st.slice(from, to);
    var idxs = group.map(function (g) { return g.idx; });
    var mini = {};
    idxs.forEach(function (ix) { mini[ix] = { pts:0, gd:0, gf:0 }; });
    fixtures.forEach(function (fx) {
      if (idxs.indexOf(fx.h) === -1 || idxs.indexOf(fx.a) === -1) return;
      var r = getRes(fx.key);
      if (!isPlayed(r)) return;
      mini[fx.h].gf += r.h; mini[fx.h].gd += (r.h - r.a);
      mini[fx.a].gf += r.a; mini[fx.a].gd += (r.a - r.h);
      if (r.h > r.a) mini[fx.h].pts += 3;
      else if (r.h < r.a) mini[fx.a].pts += 3;
      else { mini[fx.h].pts++; mini[fx.a].pts++; }
    });
    group.sort(function (x, y) {
      var mx = mini[x.idx], my = mini[y.idx];
      // inbördes: poäng → målskillnad → gjorda mål, sedan fair play → FIFA-ranking
      return (my.pts - mx.pts) || (my.gd - mx.gd) || (my.gf - mx.gf) ||
             (y.fp - x.fp) ||
             (fifaRankOf(x.team) - fifaRankOf(y.team)) || (x.idx - y.idx);
    });
    for (var k = 0; k < group.length; k++) st[from + k] = group[k];
  }

  /* ---------- Tredjeplacerade lag ---------- */
  function fifaRankOf(team) {
    var r = WC.fifaRank && team ? WC.fifaRank[team.iso] : null;
    return (typeof r === "number") ? r : 999;
  }
  /* FIFA:s kriterier för bästa treor: poäng → målskillnad → gjorda mål →
     fair play (kortpoäng, beräknad från matchdetaljerna) → FIFA-ranking. */
  function cmpThirdsStat(a, b) { // positivt om a ska före b
    return (a.pts - b.pts) || (a.gd - b.gd) || (a.gf - b.gf) || (a.fp - b.fp);
  }
  function computeThirds(tables) {
    var arr = WC.groupLetters.map(function (L) {
      var t = tables[L][2];
      return { L: L, team: t.team, s: t };
    });
    var allZeroPts = arr.every(function (e) { return e.s.pts === 0; });
    if (allZeroPts) {
      arr.sort(function (x, y) { return x.team.sv.localeCompare(y.team.sv, "sv"); });
    } else {
      arr.sort(function (x, y) {
        return cmpThirdsStat(y.s, x.s) ||
          (fifaRankOf(x.team) - fifaRankOf(y.team)) ||
          (x.L < y.L ? -1 : 1);
      });
    }

    // Markera lag som står lika på poäng/målskillnad/gjorda mål:
    //  - skiljs de av fair play-poängen (korten) → "FP"-markering
    //  - är de lika även där → FIFA-rankingen avgör → "FIFA"-markering
    arr.forEach(function (e) { e.fpDecided = false; e.contested = false; });
    var i = 0;
    while (i < arr.length) {
      var j = i + 1;
      while (j < arr.length &&
             arr[j].s.pts === arr[i].s.pts &&
             arr[j].s.gd === arr[i].s.gd &&
             arr[j].s.gf === arr[i].s.gf) j++;
      if (j - i > 1 && arr[i].s.pld > 0) {
        for (var k = i; k < j; k++) {
          var fpTie = false;
          for (var n = i; n < j; n++) {
            if (n !== k && arr[n].s.fp === arr[k].s.fp) { fpTie = true; break; }
          }
          if (fpTie) arr[k].contested = true;
          else arr[k].fpDecided = true;
        }
      }
      i = j;
    }

    arr.forEach(function (e, idx) { e.qualified = idx < 8; });
    var qset = arr.filter(function (e) { return e.qualified; }).map(function (e) { return e.L; });
    qset.sort();
    return { ranking: arr, key: qset.join("") };
  }

  /* ---------- Slutspelsupplösning ---------- */
  var THIRD_SLOT_MATCH = window.ANNEX_C_SLOT_MATCH;
  var MATCH_TO_SLOT = {};
  Object.keys(THIRD_SLOT_MATCH).forEach(function (L) { MATCH_TO_SLOT[THIRD_SLOT_MATCH[L]] = L; });
  var MATCH_BY_NO = {};
  WC.knockout.forEach(function (m) { MATCH_BY_NO[m.m] = m; });

  function buildContext() {
    var tables = {}, groupComplete = {}, allComplete = true;
    WC.groupLetters.forEach(function (L) {
      tables[L] = computeTable(L);
      var done = groupFixtures(L).every(function (f) { return isPlayed(getRes(f.key)); });
      groupComplete[L] = done;
      if (!done) allComplete = false;
    });
    return {
      tables: tables, groupComplete: groupComplete, allComplete: allComplete,
      thirds: computeThirds(tables), resolved: {}
    };
  }

  function resolveSlot(slot, ctx) {
    if (slot.t === "w") {
      return { team: ctx.tables[slot.g][0].team, decided: ctx.groupComplete[slot.g], label: "Etta grupp " + slot.g };
    }
    if (slot.t === "r") {
      return { team: ctx.tables[slot.g][1].team, decided: ctx.groupComplete[slot.g], label: "Tvåa grupp " + slot.g };
    }
    if (slot.t === "3") {
      var label = "3:a (" + slot.from.join("/") + ")";
      var assign = window.ANNEX_C[ctx.thirds.key];
      var matchNo = slot._m;
      if (assign && matchNo && MATCH_TO_SLOT[matchNo]) {
        var pos = window.ANNEX_C_SLOTS.indexOf(MATCH_TO_SLOT[matchNo]);
        var grp = assign.charAt(pos);
        if (grp && ctx.tables[grp]) {
          return { team: ctx.tables[grp][2].team, decided: ctx.allComplete, label: label, thirdGroup: grp };
        }
      }
      return { team: null, decided: false, label: label };
    }
    if (slot.t === "wm" || slot.t === "lm") {
      var src = ctx.resolved[slot.m];
      var want = slot.t === "wm" ? "winner" : "loser";
      var pre = slot.t === "wm" ? "Vinnare match " : "Förlorare match ";
      if (src && src[want]) return { team: src[want].team, decided: src[want].decided, label: pre + slot.m };
      return { team: null, decided: false, label: pre + slot.m };
    }
    return { team: null, decided: false, label: "?" };
  }

  function resolveKnockout(ctx) {
    WC.knockout.forEach(function (mt) {
      if (mt.home.t === "3") mt.home._m = mt.m;
      if (mt.away.t === "3") mt.away._m = mt.m;
      var fx = getApiFixture("k:" + mt.m);
      var home = apiKnockoutSide(fx, "home") || resolveSlot(mt.home, ctx);
      var away = apiKnockoutSide(fx, "away") || resolveSlot(mt.away, ctx);
      var r = getRes("k:" + mt.m);
      var winner = null, loser = null;
      var bothTeams = home.team && away.team;
      if (bothTeams && isPlayed(r)) {
        var dec = (home.decided || home.fromApi) && (away.decided || away.fromApi);
        if (r.h > r.a) { winner = mk(home, dec); loser = mk(away, dec); }
        else if (r.a > r.h) { winner = mk(away, dec); loser = mk(home, dec); }
        else if (r.pw === "h") { winner = mk(home, dec); loser = mk(away, dec); }
        else if (r.pw === "a") { winner = mk(away, dec); loser = mk(home, dec); }
      }
      ctx.resolved[mt.m] = {
        match: koMatchDisplay(mt), home: home, away: away,
        result: r, winner: winner, loser: loser, bothTeams: bothTeams
      };
    });
  }
  function mk(side, decided) { return { team: side.team, decided: decided && side.decided }; }

  /* Bygg fullständig kontext (tabeller + upplöst slutspel). */
  function getCtx() {
    var ctx = buildContext();
    resolveKnockout(ctx);
    return ctx;
  }

  /* ---------- Möjliga lag i en slutspelsmatch ---------- */
  /* Plocka ut grundplatser (grupp-slots) som matar en viss slot, rekursivt. */
  function collectBaseSlots(slot, acc) {
    if (slot.t === "wm" || slot.t === "lm") {
      var src = MATCH_BY_NO[slot.m];
      collectBaseSlots(src.home, acc);
      collectBaseSlots(src.away, acc);
    } else {
      acc.push(slot);
    }
  }
  /* Grupper som kan leverera lag till en match (union av båda sidor). */
  function involvedGroups(matchNo) {
    var mt = MATCH_BY_NO[matchNo];
    var acc = [];
    collectBaseSlots(mt.home, acc);
    collectBaseSlots(mt.away, acc);
    var groups = {};
    acc.forEach(function (s) {
      if (s.t === "w" || s.t === "r") groups[s.g] = true;
      else if (s.t === "3") s.from.forEach(function (g) { groups[g] = true; });
    });
    return Object.keys(groups).sort();
  }
  /* Vilka treor som faktiskt hamnar i matchens trea-platser (FIFA Annex C). */
  function assignedThirdGroups(ctx, base) {
    var assigned = {};
    var assign = window.ANNEX_C[ctx.thirds.key];
    if (!assign) return assigned;
    base.forEach(function (s) {
      if (s.t !== "3" || !s._m) return;
      var slotId = MATCH_TO_SLOT[s._m];
      if (!slotId) return;
      var pos = window.ANNEX_C_SLOTS.indexOf(slotId);
      if (pos < 0) return;
      var grp = assign.charAt(pos);
      if (grp) assigned[grp] = true;
    });
    return assigned;
  }

  /* ====================================================================
     RENDERING
  ==================================================================== */
  var viewEl;
  var countdownTimer = null;

  var HERO_TEXTS = {
    groups: { title: "Gruppspel", sub: "11 juni – 19 juli · 48 lag · 104 matcher" },
    bracket: { title: "Slutspel", sub: "" },
    calendar: { title: "Kalender", sub: "Alla matcher · grupp- & slutspelsfas" },
    players: { title: "Statistik", sub: "Spelare & lag · samlas in automatiskt från matcherna" }
  };

  /* Vytitel (Gruppspel/Slutspel/Kalender) visas i innehållsytan,
     inte i bannern – bannern är identisk i alla vyer. */
  function renderPageIntro(view) {
    if (!viewEl) return;
    var t = HERO_TEXTS[view] || HERO_TEXTS.groups;
    var html = '<div class="page-intro"><div class="page-intro-main">' +
      "<h2>" + t.title + "</h2>" +
      (t.sub ? "<p>" + t.sub + "</p>" : "") +
      "</div></div>";
    /* Slutspel: lägg rubriken i scroll-ytan så att den följer med uppåt när
       man scrollar i trädet (annars låser den fast och täcker tabellen). */
    if (view === "bracket") {
      var sc = viewEl.querySelector(".bracket-scroll");
      if (sc) { sc.insertAdjacentHTML("afterbegin", html); return; }
    }
    viewEl.insertAdjacentHTML("afterbegin", html);
  }

  var headerCollapseAt = 80;
  var headerExpandAt = 6;
  var headerShrinkDelta = 64;
  var headerScrollLock = false;

  function measureHeaderCollapseThreshold() {
    var header = document.querySelector(".hero-header");
    if (!header || window.innerWidth > 780) {
      headerCollapseAt = 80;
      headerExpandAt = 6;
      return;
    }
    if (header.classList.contains("hero-collapsed")) return;
    var search = header.querySelector(".search");
    if (!search) return;
    /* Höjd som försvinner vid ihopfällning: sökraden + gap i mobil-gridet. */
    headerShrinkDelta = search.offsetHeight + 10;
    if (headerShrinkDelta < 0) headerShrinkDelta = 0;
    /* Kräv scroll förbi hela shrink + expand-hysteres – annars flimrar headern. */
    headerCollapseAt = Math.max(56, headerShrinkDelta + headerExpandAt + 8);
    headerExpandAt = 6;
  }

  /* Sticky-header: top hålls på 0 – ihopfällning sker via CSS (.hero-collapsed). */
  function updateHeroSticky() {
    var header = document.querySelector(".hero-header");
    if (!header) return;
    header.style.top = "0";
    measureHeaderCollapseThreshold();
  }

  function setBracketHeroCollapsed(on) {
    var header = document.querySelector(".hero-header");
    if (!header) return;
    var was = header.classList.contains("hero-collapsed");
    if (was === !!on) return;

    var mobileCompact = window.innerWidth <= 780 && ui("view", "groups") !== "bracket";
    var beforeH = mobileCompact ? header.offsetHeight : 0;

    header.classList.toggle("hero-collapsed", !!on);

    /* Vid ihopfällning krymper dokumentet – kompensera scrollY så vi inte
       hamnar under expand-tröskeln och triggar expand/collapse i loop. */
    if (mobileCompact && on) {
      var delta = beforeH - header.offsetHeight;
      if (delta > 0) {
        headerScrollLock = true;
        window.scrollTo(0, Math.max(0, window.scrollY - delta));
        requestAnimationFrame(function () { headerScrollLock = false; });
      }
    }

    if (was !== !!on && ui("view", "groups") === "bracket") {
      requestAnimationFrame(drawBracketConnectors);
    }
  }

  /* Grupp/kalender: dölj sökfältet vid scroll – varumärke och nav behåller storlek. */
  function syncHeaderCompact() {
    if (headerScrollLock) return;
    if (ui("view", "groups") === "bracket") return;
    var header = document.querySelector(".hero-header");
    if (!header) return;
    var y = window.scrollY;
    if (header.classList.contains("hero-collapsed")) {
      if (y <= headerExpandAt) setBracketHeroCollapsed(false);
    } else if (y > headerCollapseAt) {
      setBracketHeroCollapsed(true);
    }
  }

  function setupBracketHeroCollapse() {
    var sc = viewEl.querySelector(".bracket-scroll");
    if (!sc || sc._heroCollapseBound) return;
    sc._heroCollapseBound = true;

    sc.addEventListener("scroll", function () {
      if (sc.scrollTop > 6) setBracketHeroCollapsed(true);
      else if (sc.scrollTop <= 0) setBracketHeroCollapsed(false);
    }, { passive: true });
  }

  function render() {
    var view = ui("view", "home");
    document.documentElement.classList.toggle("view-bracket", view === "bracket");
    document.documentElement.classList.toggle("view-home", view === "home");
    document.querySelectorAll("[data-nav]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-nav") === view);
    });
    if (view === "home") renderHome();
    else if (view === "groups") renderGroups();
    else if (view === "bracket") {
      setBracketHeroCollapsed(false);
      renderBracket();
    }
    else if (view === "players") renderPlayers();
    else renderCalendar();
    if (view !== "home") renderPageIntro(view);

    /* Grupp-popupen används i både kalender- och gruppvyn. */
    if (view !== "calendar" && view !== "groups") hideCalGroupPopup();
    if (view !== "bracket") {
      hoverMatch = null;
      hideAside();
      setBracketHeroCollapsed(false);
    }
    renderTeamDrawer();
    updateHeroSticky();
    syncHeaderCompact();
  }

  /* Re-render utan att störa pågående inmatning (för realtid/timer). */
  function refresh(opts) {
    opts = opts || {};
    var a = document.activeElement;
    if (a && a.classList && a.classList.contains("score")) return;
    if (a && a.id === "psSearch") return; // stör inte pågående sökning i spelarvyn
    if (a && a.id === "teamSearch") { render(); restoreSearchFocus(); return; }
    if (!opts.full && ui("view", "groups") === "bracket") {
      updateBracketTimers();
      return;
    }
    render();
  }

  /** Uppdatera "om X tim" / LIVE på slutspelskort utan att bygga om hela trädet. */
  function updateBracketTimers() {
    if (ui("view", "groups") !== "bracket") return;
    var ctx = getCtx();
    viewEl.querySelectorAll(".bracket .match[data-m]").forEach(function (el) {
      var m = parseInt(el.getAttribute("data-m"), 10);
      var res = ctx.resolved[m];
      if (!res) return;
      var played = res.bothTeams && isPlayed(res.result);
      var resKey = "k:" + m;
      var liveNow = isMatchLive(resKey);
      var rel = liveNow ? { cls: "live", txt: "Pågår nu" } : relativeLabel(res.match, played, resKey);
      var relEl = el.querySelector(".m-rel");
      if (relEl) {
        relEl.className = "m-rel " + rel.cls;
        relEl.textContent = rel.txt;
      }
      el.classList.toggle("live-now", liveNow);
    });
  }
  function restoreSearchFocus() {
    var s = document.getElementById("teamSearch");
    if (s) { s.focus(); }
  }

  /* ---------- Startsida (Hem) ---------- */
  function renderHome() {
    var ctx = getCtx();
    var html = '<div class="home-layout">' +
      '<div class="home-intro">' +
        '<span class="home-kicker"><span class="hk-dot" aria-hidden="true"></span>Fotbolls-VM 2026 · USA · Mexiko · Kanada</span>' +
        '<h2>Gräver grav</h2>' +
        '<p>VM 2026 i realtid — gruppspel, slutspel och en värdig begravning för svenska och uruguayanska drömmar.</p>' +
      '</div>' +
      focusHero(ctx) +
      teamsSpotlightStrip(ctx) +
      '</div>';
    viewEl.innerHTML = html;
    updateNextCountdown();
  }

  /* ---------- Gruppvy ---------- */
  function renderGroups() {
    var ctx = getCtx();
    var qualifiedLetters = {};
    ctx.thirds.ranking.forEach(function (e) { if (e.qualified) qualifiedLetters[e.L] = true; });

    var html = '<div class="groups-layout">' +
      '<div class="groups-grid">';
    WC.groupLetters.forEach(function (L) { html += groupCard(L, ctx.tables[L], qualifiedLetters[L]); });
    html += thirdsPanel(ctx.thirds);
    html += '</div></div>';
    viewEl.innerHTML = html;
    if (calGroupOpen) renderCalGroupPopup(); // håll grupp-popupen aktuell
  }

  /* ---------- Spelarstatistik-vy (assets/playerstats.js) ---------- */
  function renderPlayers() {
    if (window.VMPlayerStats && typeof window.VMPlayerStats.mount === "function") {
      window.VMPlayerStats.mount(viewEl);
    } else {
      viewEl.innerHTML = '<p class="note">Statistiken kunde inte laddas.</p>';
    }
  }

  /** Kort-cell (gula/röda) med fair play-poäng i tooltip. */
  function cardsCellHtml(s) {
    var title = "Fair play: " + s.fp + " poäng (" + s.fpY + " gula, " + s.fpR + " röda kort)";
    if (!s.fpY && !s.fpR) {
      return '<span class="cards-cell cards-none" title="' + title + '">–</span>';
    }
    var inner = '<span class="card-ico y" aria-hidden="true"></span>' + s.fpY;
    if (s.fpR) inner += '<span class="card-ico r" aria-hidden="true"></span>' + s.fpR;
    return '<span class="cards-cell" title="' + title + '">' + inner + '</span>';
  }

  function standingsRows(table, opts) {
    opts = opts || {};
    var compact = !!opts.compact;
    var showCards = !compact && opts.cards !== false;
    var showFp = !!opts.fp;
    var h = "";
    table.forEach(function (s, i) {
      var rowCls = "";
      if (i < 2) rowCls = "r-adv";
      else if (i === 2) rowCls = opts.thirdQualified ? "r-third-q" : "r-third-o";
      if (opts.highlightTeam && s.team && s.team.iso === opts.highlightTeam.iso) rowCls += " r-highlight";
      if (opts.highlightIsos && s.team && opts.highlightIsos.indexOf(s.team.iso) !== -1) rowCls += " r-highlight";
      var fpTitle = "Fair play: " + s.fp + " poäng (" + s.fpY + " gula, " + s.fpR + " röda kort)";
      h += '<tr class="' + rowCls + '"' + (opts.noLink ? '' : ' data-team="' + s.team.iso + '"') + '>' +
        '<td class="c-pos">' + (i + 1) + '</td>' +
        '<td class="c-team"><span class="team">' +
          flagImg(s.team.iso) + '<span class="t-name">' + esc(s.team.sv) + '</span></span></td>' +
        '<td class="c-stat">' + s.pld + '</td>' +
        (compact ? '' :
          '<td class="c-stat">' + s.w + '</td>' +
          '<td class="c-stat">' + s.d + '</td><td class="c-stat">' + s.l + '</td>') +
        '<td class="c-goals">' + s.gf + '–' + s.ga + '</td>' +
        '<td class="c-stat">' + (s.gd > 0 ? "+" + s.gd : s.gd) + '</td>' +
        (showCards ? '<td class="c-cards">' + cardsCellHtml(s) + '</td>' : '') +
        (showFp ? '<td class="c-stat c-fp' + (s.fp < 0 ? " has-cards" : "") + '" title="' + fpTitle + '">' + s.fp + '</td>' : '') +
        '<td class="c-pts">' + s.pts + '</td></tr>';
    });
    return h;
  }

  /** Kompakt grupptabell (HTML) för matchmodalen. highlightIsos markerar
      lagen i den öppnade matchen. Raderna är icke-klickbara i modalen. */
  function groupTableHtml(letter, highlightIsos) {
    var ctx = getCtx();
    var table = ctx.tables[letter];
    if (!table) return "";
    var thirdQualified = ctx.thirds.ranking.some(function (e) { return e.L === letter && e.qualified; });
    return '<table class="standings standings-compact mi-standings"><thead><tr>' +
      '<th class="c-pos">#</th><th class="c-team">Lag</th>' +
      '<th class="c-stat" title="Spelade matcher">S</th>' +
      '<th class="c-goals" title="Gjorda–insläppta mål">Mål</th>' +
      '<th class="c-stat" title="Målskillnad">+/-</th>' +
      '<th class="c-pts" title="Poäng">P</th>' +
      '</tr></thead><tbody>' +
      standingsRows(table, { thirdQualified: thirdQualified, compact: true, noLink: true, highlightIsos: highlightIsos || [] }) +
      '</tbody></table>';
  }

  function groupCard(L, table, thirdQualified) {
    var fixtures = groupFixtures(L);
    var open = !!expandedGroups[L];
    var h = '<section class="card group-card' + (open ? " is-open" : "") + '">';
    h += '<button type="button" class="group-head group-head-btn" data-cal-group="' + L + '" ' +
         'title="Visa fullständig tabell med vinster, förluster, kort och fair play">' +
         '<h3><span class="' + groupPillClass(L, "is-lg") + '">Grupp ' + L + '</span></h3>' +
         '<span class="group-more">Detaljer' +
         '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
         '<path fill="currentColor" d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>' +
         '</span></button>';
    /* Kompakt tabell – hela lagnamnet får plats. Fullständig statistik
       (V/O/F, kort, fair play) visas i popupen via gruppkortets rubrik. */
    h += '<table class="standings standings-compact"><thead><tr>' +
         '<th class="c-pos">#</th><th class="c-team">Lag</th>' +
         '<th class="c-stat" title="Spelade matcher">S</th>' +
         '<th class="c-goals" title="Gjorda–insläppta mål">Mål</th>' +
         '<th class="c-stat" title="Målskillnad">+/-</th>' +
         '<th class="c-pts" title="Poäng">P</th>' +
         '</tr></thead><tbody>' + standingsRows(table, { thirdQualified: thirdQualified, compact: true }) + '</tbody></table>';

    h += '<button class="matches-toggle" data-toggle-group="' + L + '">' +
         (open ? "Dölj matcher ▲" : "Visa matcher ▼") + '</button>';

    if (open) {
      h += '<div class="fixtures">';
      sortFixturesChrono(fixtures).forEach(function (fx) {
        var th = WC.groups[L][fx.h], ta = WC.groups[L][fx.a];
        var r = getRes(fx.key) || {};
        var when = whenLabels(fx);
        var liveFx = isMatchLive(fx.key);
        var open = matchOpenAttr(fx.key);
        h += '<div class="fixture' + (liveFx ? " live" : "") + open.cls + '"' + open.attr + '>' +
          '<div class="fx-date">' + (liveFx ? liveTimeLabel(fx.key, when.dateLabel + ' · ' + when.time) : when.dateLabel + ' · ' + when.time) + '</div>' +
          '<div class="fx-match">' +
          teamOpenBtn(th, fixtureTeamName(th) + flagImg(th.iso), "fx-team home") +
          scorePair(r) +
          teamOpenBtn(ta, flagImg(ta.iso) + fixtureTeamName(ta), "fx-team away") +
          '</div></div>';
      });
      h += '</div>';
    }
    h += '</section>';
    return h;
  }

  function thirdsPanel(thirds) {
    var h = '<section class="card thirds-card">' +
      '<div class="group-head"><h3>Ranking – tredjeplacerade lag</h3>' +
      '<span class="host-tag info">8 bästa går vidare</span></div>' +
      '<table class="standings thirds-table"><thead><tr>' +
      '<th class="c-pos">#</th><th class="c-grp">Gr</th><th class="c-team">Lag</th>' +
      '<th class="c-stat">S</th><th class="c-stat">V</th><th class="c-stat">O</th><th class="c-stat">F</th>' +
      '<th class="c-goals">Mål</th><th class="c-stat">+/-</th>' +
      '<th class="c-stat c-fp" title="Fair play-poäng: −1 gult kort, −3 två gula, −4 direkt rött, −5 gult + direkt rött">FP</th>' +
      '<th class="c-pts">P</th><th class="c-status">Kval</th></tr></thead><tbody>';
    var anyFpDecided = thirds.ranking.some(function (e) { return e.fpDecided; });
    var anyContested = thirds.ranking.some(function (e) { return e.contested; });
    thirds.ranking.forEach(function (e, i) {
      var cls = e.qualified ? "r-third-q" : "r-third-o";
      if (i === 7) cls += " cut-line"; // sista kvalplatsen
      if (e.contested) cls += " r-contested";
      var mark = "";
      if (e.fpDecided) {
        mark = ' <sup class="fp-mark" title="Lika på poäng, målskillnad och gjorda mål – särskiljs på fair play-poäng (kort).">FP</sup>';
      } else if (e.contested) {
        mark = ' <sup class="fp-mark" title="Lika på poäng, målskillnad, gjorda mål och fair play – ordnas på FIFA-ranking.">FIFA</sup>';
      }
      var fpTitle = e.s.fpY + " gula, " + e.s.fpR + " röda kort";
      h += '<tr class="' + cls + '" data-team="' + e.team.iso + '">' +
        '<td class="c-pos">' + (i + 1) + '</td><td class="c-grp">' + e.L + '</td>' +
        '<td class="c-team"><span class="team">' + flagImg(e.team.iso) +
          '<span class="t-name">' + esc(e.team.sv) + mark + '</span></span></td>' +
        '<td class="c-stat">' + e.s.pld + '</td><td class="c-stat">' + e.s.w + '</td>' +
        '<td class="c-stat">' + e.s.d + '</td><td class="c-stat">' + e.s.l + '</td>' +
        '<td class="c-goals">' + e.s.gf + '–' + e.s.ga + '</td>' +
        '<td class="c-stat">' + (e.s.gd > 0 ? "+" + e.s.gd : e.s.gd) + '</td>' +
        '<td class="c-stat c-fp' + (e.s.fp < 0 ? " has-cards" : "") + '" title="' + fpTitle + '">' + e.s.fp + '</td>' +
        '<td class="c-pts">' + e.s.pts + '</td>' +
        '<td class="c-status">' + (e.qualified ? '<span class="qbadge">✓</span>' : '<span class="xbadge">✗</span>') + '</td></tr>';
    });
    h += '</tbody></table><p class="note">Endast de <strong>8 bästa treorna</strong> går vidare (de 4 sämsta treorna + alla fyror åker ut). ' +
      'Rangordning enligt FIFA: poäng → målskillnad → gjorda mål → fair play → FIFA-ranking. ' +
      '<strong>FP</strong> = fair play-poäng, beräknade från korten i matcherna ' +
      '(−1 gult kort, −3 två gula i samma match, −4 direkt rött, −5 gult + direkt rött). ' +
      (anyFpDecided
        ? '<br><strong>FP</strong>-markerade lag står lika på poäng, målskillnad och gjorda mål och särskiljs just nu av fair play-poängen. '
        : '') +
      (anyContested
        ? '<br><strong>FIFA</strong>-markerade lag är lika även på fair play och ordnas på FIFA-ranking. '
        : '') +
      'De 8 placeras automatiskt i slutspelsträdet enligt FIFA:s 495 kombinationer (Annex C).</p></section>';
    return h;
  }

  /* ---------- Slutspelsvy (tvåsidigt träd, final i mitten) ---------- */
  var BR = {
    leftR32: [74,77,73,75,83,84,81,82], leftR16: [89,90,93,94], leftQF: [97,98], leftSF: [101],
    rightSF: [102], rightQF: [99,100], rightR16: [91,92,95,96], rightR32: [76,78,79,80,86,88,85,87]
  };

  var BR_HALF = {
    left: [
      { title: "Sextondelsfinal", nums: BR.leftR32, round: 0 },
      { title: "Åttondelsfinal",  nums: BR.leftR16, round: 1 },
      { title: "Kvartsfinal",     nums: BR.leftQF,  round: 2 },
      { title: "Semifinal",       nums: BR.leftSF,  round: 3 }
    ],
    right: [
      { title: "Semifinal",       nums: BR.rightSF,  round: 3 },
      { title: "Kvartsfinal",     nums: BR.rightQF,  round: 2 },
      { title: "Åttondelsfinal",  nums: BR.rightR16, round: 1 },
      { title: "Sextondelsfinal", nums: BR.rightR32, round: 0 }
    ]
  };

  function bracketGridCol(round, side) {
    return side === "left" ? round + 1 : 9 - round;
  }

  /** Höger halva av trädet → panel till vänster så matchkorten inte täcks. */
  function bracketAsideSide(matchNo) {
    var right = BR.rightR32.concat(BR.rightR16, BR.rightQF, BR.rightSF);
    return right.indexOf(matchNo) >= 0 ? "left" : "right";
  }

  function bracketGridRow(round, idx) {
    var span = Math.pow(2, round);
    return "grid-row:" + (2 + idx * span) + "/span " + span;
  }

  function bracketRoundTitle(title, col, opts) {
    opts = opts || {};
    var cls = "round-title bracket-jump";
    if (opts.final) cls += " final-label";
    if (opts.bronze) cls += " bronze-title";
    var sub = opts.sub ? '<span class="round-sub">' + esc(opts.sub) + '</span>' : "";
    var btn = '<button type="button" class="' + cls + '" data-bracket-col="' + col + '">' + title + sub + '</button>';
    if (opts.bronze) return btn;
    return '<div class="round-cell' + (opts.final ? " is-final" : "") + '" style="grid-column:' + col + '">' + btn + '</div>';
  }

  /* Datumintervall för en slutspelsfas, t.ex. "28 juni–3 juli". */
  function bracketRoundDates(nums, resolved) {
    var dates = nums.map(function (n) { return resolved[n].match.date; }).sort();
    var a = parseDateUTC(dates[0]), b = parseDateUTC(dates[dates.length - 1]);
    if (dates[0] === dates[dates.length - 1]) return a.getUTCDate() + " " + MONTHS[a.getUTCMonth()];
    if (a.getUTCMonth() === b.getUTCMonth()) {
      return a.getUTCDate() + "–" + b.getUTCDate() + " " + MONTHS[a.getUTCMonth()];
    }
    return a.getUTCDate() + " " + MONTHS[a.getUTCMonth()] + "–" + b.getUTCDate() + " " + MONTHS[b.getUTCMonth()];
  }

  function renderBracket() {
    var ctx = getCtx();
    bracketFrontier = frontierRoundKey(ctx);

    var html = '<div class="bracket-shell">' +
      '<div class="bracket-scroll"><div class="bracket-wrap">';
    html += '<svg class="bracket-lines" aria-hidden="true"></svg>';
    html += '<div class="bracket two-sided">';

    BR_HALF.left.forEach(function (col) {
      html += bracketRoundTitle(col.title, bracketGridCol(col.round, "left"),
        { sub: bracketRoundDates(col.nums, ctx.resolved) });
    });
    html += bracketRoundTitle("Final", 5, { final: true, sub: bracketRoundDates([104], ctx.resolved) });
    BR_HALF.right.forEach(function (col) {
      html += bracketRoundTitle(col.title, bracketGridCol(col.round, "right"),
        { sub: bracketRoundDates(col.nums, ctx.resolved) });
    });

    BR_HALF.left.forEach(function (col) {
      col.nums.forEach(function (n, idx) {
        html += matchCard(ctx.resolved[n], null, {
          side: "left",
          grid: "grid-column:" + bracketGridCol(col.round, "left") + ";" + bracketGridRow(col.round, idx)
        });
      });
    });

    html += '<div class="bracket-center-stack" style="grid-column:5;grid-row:2/span 8">' +
      '<div class="bracket-finals-block">' +
        championBanner(ctx.resolved[104]) +
        matchCard(ctx.resolved[104], "final") +
      '</div>' +
      '<div class="bracket-bronze-block">' +
        bracketRoundTitle("Bronsmatch", 5, { bronze: true }) +
        matchCard(ctx.resolved[103], "bronze") +
      '</div></div>';

    BR_HALF.right.forEach(function (col) {
      col.nums.forEach(function (n, idx) {
        html += matchCard(ctx.resolved[n], null, {
          side: "right",
          grid: "grid-column:" + bracketGridCol(col.round, "right") + ";" + bracketGridRow(col.round, idx)
        });
      });
    });

    html += '</div></div></div></div>';

    var sc = viewEl.querySelector(".bracket-scroll");
    var preserveScroll = !!sc;
    var prevScroll = sc ? sc.scrollLeft : 0;

    viewEl.innerHTML = html;

    var newSc = viewEl.querySelector(".bracket-scroll");
    function restoreBracketScroll() {
      if (!newSc || !preserveScroll) return;
      newSc.scrollLeft = Math.max(0, Math.min(prevScroll, newSc.scrollWidth - newSc.clientWidth));
    }

    if (preserveScroll) {
      restoreBracketScroll();
      drawBracketConnectors(restoreBracketScroll);
    } else {
      centerBracketScroll(drawBracketConnectors);
    }

    if (hoverMatch && ctx.resolved[hoverMatch]) updateAside(hoverMatch, ctx);
    else hideAside();
    setupBracketHeroCollapse();
  }

  function drawBracketConnectors(afterLayout) {
    requestAnimationFrame(function () {
      var wrap = viewEl.querySelector(".bracket-wrap");
      var br = wrap && wrap.querySelector(".bracket");
      var svg = wrap && wrap.querySelector(".bracket-lines");
      if (!wrap || !br || !svg) return;

      var wrapRect = wrap.getBoundingClientRect();
      var paths = [];

      function pos(el) {
        var r = el.getBoundingClientRect();
        return {
          y: r.top - wrapRect.top + r.height / 2,
          right: r.right - wrapRect.left,
          left: r.left - wrapRect.left,
          top: r.top - wrapRect.top,
          bottom: r.bottom - wrapRect.top,
          cx: r.left - wrapRect.left + r.width / 2
        };
      }

      function forkPair(aEl, bEl, pEl, side) {
        var a = pos(aEl), b = pos(bEl), p = pos(pEl);
        var midY = (a.y + b.y) / 2;
        if (side === "left") {
          var midX = (Math.max(a.right, b.right) + p.left) / 2;
          paths.push("M" + a.right + "," + a.y + " H" + midX);
          paths.push("M" + b.right + "," + b.y + " H" + midX);
          paths.push("M" + midX + "," + a.y + " V" + b.y);
          paths.push("M" + midX + "," + midY + " H" + p.left);
        } else {
          var midX = (Math.min(a.left, b.left) + p.right) / 2;
          paths.push("M" + a.left + "," + a.y + " H" + midX);
          paths.push("M" + b.left + "," + b.y + " H" + midX);
          paths.push("M" + midX + "," + a.y + " V" + b.y);
          paths.push("M" + midX + "," + midY + " H" + p.right);
        }
      }

      function linkSingle(fromEl, toEl, side) {
        var f = pos(fromEl), t = pos(toEl);
        if (side === "left") {
          var midX = (f.right + t.left) / 2;
          paths.push("M" + f.right + "," + f.y + " H" + midX);
          paths.push("M" + midX + "," + f.y + " V" + t.y);
          paths.push("M" + midX + "," + t.y + " H" + t.left);
        } else {
          var midX = (f.left + t.right) / 2;
          paths.push("M" + f.left + "," + f.y + " H" + midX);
          paths.push("M" + midX + "," + f.y + " V" + t.y);
          paths.push("M" + midX + "," + t.y + " H" + t.right);
        }
      }

      function linkBronze(aEl, bEl, bronzeEl) {
        var a = pos(aEl), b = pos(bEl), brz = pos(bronzeEl);
        var entryY = brz.y;

        paths.push("M" + a.cx + "," + a.bottom + " V" + entryY);
        paths.push("M" + a.cx + "," + entryY + " H" + brz.left);

        paths.push("M" + b.cx + "," + b.bottom + " V" + entryY);
        paths.push("M" + b.cx + "," + entryY + " H" + brz.right);
      }

      ["left", "right"].forEach(function (side) {
        var half = BR_HALF[side];
        for (var r = 0; r < half.length - 1; r++) {
          // Vänster: yttre → inre. Höger: BR_HALF är inre → yttre, vänd parningen.
          var kids = side === "left" ? half[r].nums : half[r + 1].nums;
          var pars = side === "left" ? half[r + 1].nums : half[r].nums;
          for (var j = 0; j < pars.length; j++) {
            var elA = br.querySelector('[data-m="' + kids[j * 2] + '"]');
            var elB = br.querySelector('[data-m="' + kids[j * 2 + 1] + '"]');
            var elP = br.querySelector('[data-m="' + pars[j] + '"]');
            if (elA && elB && elP) forkPair(elA, elB, elP, side);
          }
        }
      });

      var fin = br.querySelector('[data-m="104"]');
      var sfL = br.querySelector('[data-m="101"]');
      var sfR = br.querySelector('[data-m="102"]');
      var bronze = br.querySelector('[data-m="103"]');
      if (fin && sfL) linkSingle(sfL, fin, "left");
      if (fin && sfR) linkSingle(sfR, fin, "right");
      if (bronze && sfL && sfR) linkBronze(sfL, sfR, bronze);

      var w = wrap.offsetWidth;
      var h = wrap.offsetHeight;
      svg.setAttribute("viewBox", "0 0 " + w + " " + h);
      svg.setAttribute("width", w);
      svg.setAttribute("height", h);
      svg.innerHTML = paths.map(function (d) {
        return '<path d="' + d + '" fill="none" stroke-linecap="square"/>';
      }).join("");
      if (typeof afterLayout === "function") afterLayout();
    });
  }

  function centerBracketColumn(col, anchorEl) {
    requestAnimationFrame(function () {
      var sc = viewEl.querySelector(".bracket-scroll");
      var br = sc && sc.querySelector(".bracket");
      if (!sc || !br) return;
      var el = anchorEl || br.querySelector('[data-bracket-col="' + col + '"]');
      if (!el) return;
      var scRect = sc.getBoundingClientRect();
      var elRect = el.getBoundingClientRect();
      var colCenter = elRect.left + elRect.width / 2 - scRect.left + sc.scrollLeft;
      sc.scrollLeft = Math.max(0, Math.min(sc.scrollWidth - sc.clientWidth, colCenter - sc.clientWidth / 2));
    });
  }

  function centerBracketScroll(cb) {
    requestAnimationFrame(function () {
      var sc = viewEl.querySelector(".bracket-scroll");
      var br = sc && sc.querySelector(".bracket");
      if (!sc || !br) { if (cb) cb(); return; }
      sc.scrollLeft = Math.max(0, (br.scrollWidth - sc.clientWidth) / 2);
      if (cb) requestAnimationFrame(cb);
    });
  }

  function championBanner(fin) {
    if (!fin.winner || !fin.winner.team) return '<div class="champ-slot empty final-label">VM-final</div>';
    var c = fin.winner.team;
    return '<div class="champ-slot' + (fin.winner.decided ? " decided" : " prov") + '">' +
      teamOpenBtn(c, flagImg(c.iso) +
      '<span class="champ-txt">VM-final' +
      '<strong>' + esc(bracketTeamName(fin.winner)) + '</strong></span>', "champ-open") + '</div>';
  }

  /** Hypotetiskt lag i slutspelsträdet – frågetecken tills platsen är helt avgjord. */
  function bracketTeamName(side) {
    if (!side || !side.team) return "";
    var name = teamSvFixture(side.team);
    return side.decided ? name : name + "?";
  }

  /* Längre, mer läsbar seed-etikett för "vem möter vem"-grafiken. */
  function slotSeedLong(slot) {
    if (slot.t === "w") return "Etta grupp " + slot.g;
    if (slot.t === "r") return "Tvåa grupp " + slot.g;
    if (slot.t === "3") return "3:a grupp " + slot.from.join("/");
    if (slot.t === "wm") return "Vinnare match " + slot.m;
    if (slot.t === "lm") return "Förlorare match " + slot.m;
    return "?";
  }

  /* Typklass för seed-chip – färgkodar kvalvägen i linje med grupptabellerna
     (grön = 1:a/2:a som avancerar, guld = bästa trea, neutral = match-resultat). */
  function seedTypeClass(slot) {
    if (!slot) return "seed-m";
    if (slot.t === "w" || slot.t === "r") return "seed-adv";
    if (slot.t === "3") return "seed-third";
    return "seed-m";
  }

  /* En sida i matchup-grafiken: seed-etikett + flagga + lagnamn (eller platshållare). */
  function asideMatchupSide(slot, side, which, isWin) {
    var seed = slotSeedLong(slot);
    var inner;
    if (side.team) {
      var prov = !side.decided;
      inner = teamOpenBtn(side.team,
        flagImg(side.team.iso) + '<span class="mu-name">' + esc(bracketTeamName(side)) + '</span>',
        "mu-team" + (prov ? " prov" : ""));
    } else {
      inner = '<span class="mu-team tbd"><span class="mu-flag-ph"></span>' +
        '<span class="mu-name">Ej klart</span></span>';
    }
    return '<div class="mu-side mu-' + which + (isWin ? " win" : "") + '">' +
      '<span class="mu-seed seed-chip ' + seedTypeClass(slot) + '">' + esc(seed) + '</span>' +
      inner + '</div>';
  }

  function matchCard(res, variant, opts) {
    opts = opts || {};
    var m = res.match;
    var when = whenLabels(m);
    var played = res.bothTeams && isPlayed(res.result);
    var resKey = "k:" + m.m;
    var liveNow = isMatchLive(resKey);
    var rel = liveNow ? { cls: "live", txt: "Pågår nu" } : relativeLabel(m, played, resKey);
    var expanded = hoverMatch === m.m;
    var open = matchOpenAttr(resKey, !!res.bothTeams);
    var cls = "match" + (variant ? " " + variant : "") + (liveNow ? " live-now" : "") + (expanded ? " expanded" : "") + open.cls;
    if (opts.side) cls += " side-" + opts.side;

    var hWin = res.winner && res.home.team && res.winner.team === res.home.team;
    var aWin = res.winner && res.away.team && res.winner.team === res.away.team;

    // I "nästa match"-rundan visas oddsfavoriten i stället för platshållaren.
    var predHere = !variant && bracketFrontier &&
      KO_ROUND_KEY[m.round] === bracketFrontier && !played;
    var homeSide = effectiveSide(res, "home", predHere);
    var awaySide = effectiveSide(res, "away", predHere);

    var h = '<div class="' + cls + '" data-m="' + m.m + '"' + open.attr + (opts.grid ? ' style="' + opts.grid + '"' : '') + '">';
    h += '<div class="m-meta"><span class="m-no">M' + m.m + '</span>' +
         '<span class="m-rel ' + rel.cls + '">' + rel.txt + '</span></div>';
    h += sideRow(homeSide, res, "h", hWin);
    h += sideRow(awaySide, res, "a", aWin);

    var r = res.result;
    if (played && r.h === r.a && r.pw) {
      var penWinner = r.pw === "h"
        ? (res.home.team ? teamSvFixture(res.home.team) : "Hemma")
        : (res.away.team ? teamSvFixture(res.away.team) : "Borta");
      h += '<div class="pen-row"><span>Straffar: ' + esc(penWinner) + " vann</span></div>";
    }
    h += '<div class="m-footer">' +
         '<span class="m-when">' + when.dateLabel + ' · ' + when.time + '</span>' +
         matchExpandBtn(m.m, expanded) + '</div>';
    h += '</div>';
    return h;
  }

  function sideRow(side, res, ha, isWin) {
    var prov = side.team && !side.decided;
    var cls = "side" + (isWin ? " win" : "") + (prov ? " prov" : "") +
      (side.predicted ? " predicted" : "") + (side.team ? "" : " tbd");
    var slot = ha === "h" ? res.match.home : res.match.away;
    var inner = side.team
      ? teamOpenBtn(side.team, flagImg(side.team.iso) + '<span class="s-name" title="' + esc(side.team.sv) + '">' + esc(bracketTeamName(side)) + '</span>', "side-team")
      : '<span class="s-name placeholder seed-chip ' + seedTypeClass(slot) + '">' + esc(side.label) + '</span>';
    var r = res.result || {};
    var scoreCell = scoreDisplay(r[ha]);
    return '<div class="' + cls + '">' + inner + scoreCell + '</div>';
  }

  /* ---------- Sidopanel (möjliga lag + tabeller) ---------- */
  function hideAside() {
    var el = document.getElementById("bracketAside");
    if (el) el.classList.remove("show", "aside-left");
  }

  function syncExpandButtons() {
    document.querySelectorAll(".match-expand").forEach(function (btn) {
      var no = parseInt(btn.getAttribute("data-expand-match"), 10);
      var open = hoverMatch === no;
      btn.classList.toggle("on", open);
      var label = open ? "Dölj matchinfo" : "Visa matchinfo";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      var card = btn.closest(".match");
      if (card) card.classList.toggle("expanded", open);
    });
  }

  function updateAside(matchNo, ctx) {
    var el = document.getElementById("bracketAside");
    if (!el) return;
    el.classList.toggle("aside-left", bracketAsideSide(matchNo) === "left");
    el.classList.add("show");
    var res = ctx.resolved[matchNo];
    var mt = res.match;

    // Panelen äger kvalvägen (seed) och visar tydligt vem som möter vem samt
    // sannolikheterna. Matchrutan i trädet visar bara lagen.
    var h = '<div class="aside-head">' +
      '<div class="aside-title">' +
      '<span class="aside-round">' + WC.roundNames[mt.round] + '</span>' +
      '<span class="aside-match-no">Match ' + matchNo + '</span>' +
      '</div>' +
      '<button class="aside-close" id="asideClose" title="Återställ">×</button></div>';

    // Tydlig "vem möter vem"-grafik: två lagpaneler med seed-etikett (t.ex.
    // "Tvåa grupp A"), flagga och lagnamn, samt en VS-bricka emellan. Funkar i
    // alla slutspelsrundor även innan lagen är avgjorda (visar då platshållare).
    var hWin = res.winner && res.home.team && res.winner.team === res.home.team;
    var aWin = res.winner && res.away.team && res.winner.team === res.away.team;
    // Topprutorna visar alltid det mest sannolika laget tills platsen är avgjord.
    h += '<div class="aside-matchup">' +
      asideMatchupSide(mt.home, effectiveSide(res, "home", true), "home", hWin) +
      '<div class="mu-vs"><span>VS</span></div>' +
      asideMatchupSide(mt.away, effectiveSide(res, "away", true), "away", aWin) +
      '</div>';

    h += asideProbBlock(matchNo, ctx);

    el.innerHTML = h;
  }

  function asideThirdsTable(ctx, highlightGroups, assignedGroups) {
    assignedGroups = assignedGroups || {};
    var h = '<div class="mini-group thirds"><div class="mini-group-head">Tabell – tredjeplacerade (8 bästa går vidare)</div>' +
      '<table class="standings mini"><tbody>';
    ctx.thirds.ranking.forEach(function (e, i) {
      var cls = e.qualified ? "r-third-q" : "r-third-o";
      if (assignedGroups[e.L]) cls += " r-highlight";
      else if (highlightGroups[e.L]) cls += " r-highlight-grp";
      h += '<tr class="' + cls + '" data-team="' + e.team.iso + '"><td class="c-pos">' + (i + 1) + '</td>' +
        '<td class="c-grp">' + e.L + '</td>' +
        '<td class="c-team"><span class="team">' + flagImg(e.team.iso) +
          '<span class="t-name">' + esc(e.team.sv) + '</span></span></td>' +
        '<td class="c-pts">' + e.s.pts + '</td>' +
        '<td>' + (e.s.gd > 0 ? "+" + e.s.gd : e.s.gd) + '</td>' +
        '<td>' + (e.qualified ? '<span class="qbadge">✓</span>' : '') + '</td></tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }
  function isThirdQ(ctx, L) {
    var e = ctx.thirds.ranking.filter(function (x) { return x.L === L; })[0];
    return e && e.qualified;
  }

  /* ---------- Slutspelssannolikheter (data/bracket_probs.json) ---------- */
  // Filen byggs av ett backend-jobb (scripts/prob/) ur odds + FIFA:s slutspelsträd.
  // Frontend gör bara uppslag: per nod -> { lag: sannolikhet }.
  var bracketProbs = null;          // hela bracket_probs.json
  var bracketPosByMatch = null;     // matchnr -> { round, home, away } (nodpositioner)
  var teamByNameMap = null;

  function teamByName(name) {
    if (!teamByNameMap) {
      teamByNameMap = {};
      (WC.groupLetters || []).forEach(function (L) {
        (WC.groups[L] || []).forEach(function (t) { teamByNameMap[t.name] = t; });
      });
    }
    return teamByNameMap[name];
  }

  // Härled matchnr -> nodposition med SAMMA linjärisering som
  // scripts/prob/gen_bracket_map.mjs (in-order-traversal av trädet från finalen).
  // En vinnare på position p i en runda kommer från position (2p, 2p+1) i föregående.
  function buildBracketPosMap() {
    var byNo = {};
    WC.knockout.forEach(function (m) { byNo[m.m] = m; });
    var rk = { R32: "r32", R16: "r16", QF: "qf", SF: "sf", FINAL: "final" };
    var map = {};
    function assign(no, homePos, awayPos) {
      var m = byNo[no];
      if (!m || !rk[m.round]) return;                 // 3RD hanteras separat nedan
      map[no] = { round: rk[m.round], home: homePos, away: awayPos };
      if (m.home && m.home.t === "wm") assign(m.home.m, homePos * 2, homePos * 2 + 1);
      if (m.away && m.away.t === "wm") assign(m.away.m, awayPos * 2, awayPos * 2 + 1);
    }
    var fin = WC.knockout.filter(function (m) { return m.round === "FINAL"; })[0];
    if (fin) assign(fin.m, 0, 1);
    // Bronsmatchen ligger utanför vinnar-trädet: sidorna är FÖRLORARNA i de två
    // semifinalerna, samma ordning (SF1, SF2) som prob-noden "bronze".
    var brz = WC.knockout.filter(function (m) { return m.round === "3RD"; })[0];
    if (brz) map[brz.m] = { round: "bronze", home: 0, away: 1 };
    return map;
  }

  /* ---------- Oddsfavorit i trädet (mest sannolika laget) ---------- */
  // Rundnyckel (samma som prob-datan) per matchrunda, och rundordning.
  var KO_ROUND_KEY = { R32: "r32", R16: "r16", QF: "qf", SF: "sf", FINAL: "final" };
  var KO_ROUND_ORDER = ["r32", "r16", "qf", "sf", "final"];
  var bracketFrontier = null;       // rundnyckel för "nästa match" (sätts i renderBracket)

  // Tidigaste slutspelsrunda som inte är helt färdigspelad ("nästa match").
  // Bara i denna runda ersätter vi platshållarna med oddsfavoriten i trädet.
  function frontierRoundKey(ctx) {
    var byRound = {};
    WC.knockout.forEach(function (m) {
      var rk = KO_ROUND_KEY[m.round];
      if (rk) (byRound[rk] = byRound[rk] || []).push(m.m);
    });
    for (var i = 0; i < KO_ROUND_ORDER.length; i++) {
      var ms = byRound[KO_ROUND_ORDER[i]] || [];
      var allDone = ms.every(function (no) {
        var r = ctx.resolved[no];
        return r && r.winner;
      });
      if (!allDone) return KO_ROUND_ORDER[i];
    }
    return null;
  }

  // Mest sannolika laget för en matchsida enligt prob-noderna (eller null).
  function nodeTopSide(matchNo, which) {
    if (!bracketProbs || !bracketProbs.nodes) return null;
    if (!bracketPosByMatch) bracketPosByMatch = buildBracketPosMap();
    var pos = bracketPosByMatch[matchNo];
    if (!pos) return null;
    var nodes = bracketProbs.nodes[pos.round];
    var dist = nodes && nodes[which === "home" ? pos.home : pos.away];
    if (!dist) return null;
    var bestName = null, bestP = -1;
    Object.keys(dist).forEach(function (n) {
      if (dist[n] > bestP) { bestP = dist[n]; bestName = n; }
    });
    var t = bestName && teamByName(bestName);
    return t ? { team: t, decided: false, predicted: true, prob: bestP } : null;
  }

  // Effektiv lagsida: ett avgjort lag används alltid; annars (om tillåtet)
  // oddsfavoriten, så att "det mest sannolika laget" syns i rutan.
  function effectiveSide(res, which, usePrediction) {
    var side = which === "home" ? res.home : res.away;
    if (side.team && side.decided) return side;
    if (!usePrediction) return side;
    return nodeTopSide(res.match.m, which) || side;
  }

  function slotLabelText(code) {
    if (!code) return "";
    if (code.charAt(0) === "1") return "Etta grupp " + code.slice(1);
    if (code.charAt(0) === "2") return "Tvåa grupp " + code.slice(1);
    if (code.indexOf("3/") === 0) return "Bästa trea (" + code.slice(2).split("").join("/") + ")";
    return code;
  }

  function fmtPct(p) {
    var v = p * 100;
    if (v >= 99.95) return "100";
    if (v >= 9.95) return String(Math.round(v));
    return (Math.round(v * 10) / 10).toString();
  }

  // Detaljpanelen som visas/uppdateras direkt vid hovring – innehåll per lag
  // förberäknas i updateAside så att det dyker upp utan fördröjning.
  var asideDetails = {};        // detaljnyckel -> färdig HTML
  var asideDefaultKey = null;   // laget som visas innan man hovrar (mest sannolika)

  // Vilken grupp ett lag tillhör (via iso, oberoende av objektsreferens).
  function groupLetterOf(team) {
    if (!team) return null;
    var letters = WC.groupLetters || [];
    for (var i = 0; i < letters.length; i++) {
      var arr = WC.groups[letters[i]] || [];
      for (var j = 0; j < arr.length; j++) if (arr[j].iso === team.iso) return letters[i];
    }
    return null;
  }

  // Kort beskrivning av vilken plats i trädet laget skulle ta.
  function slotPhrase(round, slotLabel) {
    if (round === "r32" && slotLabel) {
      var c0 = slotLabel.charAt(0);
      if (c0 === "1") return "som etta i grupp " + slotLabel.slice(1);
      if (c0 === "2") return "som tvåa i grupp " + slotLabel.slice(1);
      if (slotLabel.indexOf("3/") === 0) return "som en av de bästa grupptreorna";
    }
    return "till " + ({ r16: "åttondelsfinal", qf: "kvartsfinal", sf: "semifinal",
      final: "final", bronze: "bronsmatchen" }[round] || "den här matchen");
  }

  // Liten stapelgrafik: hur laget troligen slutar i sin grupp (1:a–4:a).
  function groupOddsBars(gp) {
    if (!gp) return "";
    var rows = [["1", "Vinner gruppen", "pd-pos-1"], ["2", "Tvåa", "pd-pos-2"],
      ["3", "Trea", "pd-pos-3"], ["4", "Fyra (ut)", "pd-pos-4"]];
    var h = '<div class="pd-odds"><div class="pd-odds-title">Så troligt slutar laget i gruppen</div>';
    rows.forEach(function (r) {
      var p = gp[r[0]] || 0;
      h += '<div class="pd-bar-row"><span class="pd-bar-lbl">' + r[1] + '</span>' +
        '<span class="pd-bar ' + r[2] + '"><span style="width:' + Math.round(p * 100) + '%"></span></span>' +
        '<span class="pd-bar-pct">' + fmtPct(p) + ' %</span></div>';
    });
    return h + '</div>';
  }

  // Pedagogisk, lite fylligare förklaring till sannolikheten för ett lag.
  function probDetailText(engName, prob, round, slotLabel, ctx, L) {
    var t = teamByName(engName);
    var nm = t ? t.sv : engName;
    var pct = fmtPct(prob) + " %";
    var gp = bracketProbs.groupPositions && bracketProbs.groupPositions[engName];
    var rds = bracketProbs.rounds && bracketProbs.rounds[engName];
    var parts = [];
    var c0 = slotLabel ? slotLabel.charAt(0) : "";

    if (round === "r32" && c0 === "1") {
      parts.push("Den här platsen tillhör vinnaren av grupp " + slotLabel.slice(1) + ". " +
        nm + " vinner gruppen i " + pct + " av oddssimuleringarna.");
    } else if (round === "r32" && c0 === "2") {
      parts.push("Hit går tvåan i grupp " + slotLabel.slice(1) + ". " +
        nm + " slutar tvåa i " + pct + " av simuleringarna.");
    } else if (round === "r32" && slotLabel && slotLabel.indexOf("3/") === 0) {
      var p3 = gp ? Math.round((gp["3"] || 0) * 100) : null;
      parts.push("Platsen går till en av de fyra bästa grupptreorna. " + nm + " blir trea i sin grupp" +
        (p3 != null ? " i ungefär " + p3 + " % av fallen" : "") +
        " och rankas tillräckligt högt för just den här platsen i " + pct + " av simuleringarna.");
    } else if (round === "bronze") {
      parts.push(nm + " spelar bronsmatchen i " + pct +
        " av oddssimuleringarna – laget når då semifinalen men förlorar den.");
    } else {
      var rn = { r16: "åttondelsfinal", qf: "kvartsfinal", sf: "semifinal", final: "final" }[round] || "den här matchen";
      parts.push(nm + " tar sig hit (" + rn + ") i " + pct +
        " av oddssimuleringarna – det kräver segrar i alla tidigare ronder.");
    }

    if (L && ctx.tables[L]) {
      var idx = -1, s = null;
      ctx.tables[L].forEach(function (e, i) { if (t && e.team.iso === t.iso) { idx = i; s = e; } });
      if (s) {
        parts.push("Just nu ligger laget " + (idx + 1) + ":a i grupp " + L + " med " + s.pts +
          " poäng efter " + s.pld + " spelade matcher.");
      }
    }

    if (gp) {
      var adv = (gp["1"] || 0) + (gp["2"] || 0);
      parts.push(adv >= 0.7 ? "Laget är en tydlig favorit i sin grupp."
        : adv >= 0.45 ? "Laget väntas oftast ta sig vidare från gruppspelet."
        : "Laget är en utmanare som behöver överraska för att gå vidare.");
    }

    if (rds) {
      var bits = [];
      if (rds.qf != null) bits.push("kvartsfinal i " + fmtPct(rds.qf) + " %");
      if (rds.sf != null) bits.push("semifinal i " + fmtPct(rds.sf) + " %");
      if (rds.win != null) bits.push("vinner hela VM i " + fmtPct(rds.win) + " %");
      if (bits.length) parts.push("Längre fram når laget enligt oddsen " + bits.join(", ") + ".");
    }

    return parts.join(" ");
  }

  // Full HTML för detaljpanelen för ETT lag: rubrik, förklaring, grupp-odds
  // och lagets aktuella grupptabell (laget markerat).
  function probDetailHtml(engName, prob, round, slotLabel, ctx) {
    var t = teamByName(engName);
    if (!t) return "";
    var L = groupLetterOf(t);
    var gp = bracketProbs.groupPositions && bracketProbs.groupPositions[engName];
    var h = '<div class="pd-card">';
    h += '<div class="pd-head">' + flagImg(t.iso) +
      '<span class="pd-name">' + esc(t.sv) + '</span>' +
      '<span class="pd-prob">' + fmtPct(prob) + ' %</span></div>';
    h += '<div class="pd-slot">' + esc(t.svShort || t.sv) + ' ' + esc(slotPhrase(round, slotLabel)) + '</div>';
    h += '<p class="pd-text">' + esc(probDetailText(engName, prob, round, slotLabel, ctx, L)) + '</p>';
    h += groupOddsBars(gp);
    if (L && ctx.tables[L]) {
      h += '<div class="pd-table"><div class="pd-table-head">Grupp ' + L + ' – läget just nu</div>' +
        '<table class="standings mini standings-compact"><thead><tr>' +
        '<th class="c-pos">#</th><th class="c-team">Lag</th>' +
        '<th class="c-stat" title="Spelade">S</th><th class="c-goals" title="Mål">Mål</th>' +
        '<th class="c-stat" title="Målskillnad">+/-</th><th class="c-pts" title="Poäng">P</th>' +
        '</tr></thead><tbody>' +
        standingsRows(ctx.tables[L], { compact: true, thirdQualified: isThirdQ(ctx, L), highlightTeam: t }) +
        '</tbody></table></div>';
    }
    return h + '</div>';
  }

  // En sida av en match: lag -> sannolikhet, fallande, döljer < 0.1 %.
  // Varje rad får en detaljnyckel; detaljerna förberäknas i asideDetails.
  function asideProbSide(dist, slotLabel, round, sideKey, ctx) {
    var entries = Object.keys(dist || {})
      .map(function (n) { return [n, dist[n]]; })
      .filter(function (e) { return e[1] >= 0.001; })
      .sort(function (a, b) { return b[1] - a[1]; });
    var top = entries.length ? entries[0][1] : 1;
    var rows = entries.map(function (e) {
      var t = teamByName(e[0]);
      var iso = t ? t.iso : "";
      var nm = t ? (t.svShort || t.sv) : e[0];
      var w = top > 0 ? Math.round((e[1] / top) * 100) : 0;
      var key = sideKey + "|" + e[0];
      asideDetails[key] = probDetailHtml(e[0], e[1], round, slotLabel, ctx);
      if (!asideDefaultKey) asideDefaultKey = key;
      return '<div class="prob-row" data-detail="' + esc(key) + '">' +
        '<span class="team">' + flagImg(iso) + '<span class="t-name">' + esc(nm) + '</span></span>' +
        '<span class="prob-bar"><span style="width:' + w + '%"></span></span>' +
        '<span class="prob-pct">' + fmtPct(e[1]) + ' %</span></div>';
    }).join("");
    var lab = slotLabel ? '<div class="prob-slot">' + esc(slotLabelText(slotLabel)) + '</div>' : '';
    return '<div class="prob-col">' + lab + (rows || '<div class="prob-empty">–</div>') + '</div>';
  }

  // Bygger sannolikhetsblocket för en match (båda sidor) + detaljpanelen.
  function asideProbBlock(matchNo, ctx) {
    if (!bracketProbs || !bracketProbs.nodes) return "";
    if (!bracketPosByMatch) bracketPosByMatch = buildBracketPosMap();
    var pos = bracketPosByMatch[matchNo];
    if (!pos) return "";
    var nodes = bracketProbs.nodes[pos.round];
    if (!nodes || !nodes[pos.home] || !nodes[pos.away]) return "";
    var labels = (pos.round === "r32" && bracketProbs.slotLabels) ? bracketProbs.slotLabels.r32 : null;
    var updated = bracketProbs.updated ? new Date(bracketProbs.updated) : null;
    var stamp = updated && !isNaN(updated) ?
      ' <span class="prob-stamp">· odds ' + updated.toLocaleDateString("sv-SE") + '</span>' : '';

    asideDetails = {};
    asideDefaultKey = null;
    var sides = '<div class="prob-sides">' +
      asideProbSide(nodes[pos.home], labels ? labels[pos.home] : null, pos.round, "h", ctx) +
      asideProbSide(nodes[pos.away], labels ? labels[pos.away] : null, pos.round, "a", ctx) +
      '</div>';
    var def = asideDefaultKey ? asideDetails[asideDefaultKey] : "";
    return '<div class="aside-section-title">Sannolikhet att nå hit' + stamp + '</div>' +
      sides +
      '<div class="prob-detail" id="probDetail">' +
      '<div class="pd-hint">Håll muspekaren över ett lag ovan för dess läge och chanser</div>' +
      '<div class="pd-body" id="probDetailBody">' + def + '</div></div>';
  }

  function bracketProbsUrl() {
    var CFG = window.VM_CONFIG || {};
    if (CFG.backend) return CFG.backend.replace(/\/$/, "") + "/api/bracketprobs";
    var u = CFG.staticBracket || "data/bracket_probs.json";
    return u + (u.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
  }

  function loadBracketProbs() {
    return fetch(bracketProbsUrl(), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.nodes) {
          bracketProbs = d;
          // Trädet ritar om så att oddsfavoriten i "nästa match"-rundan dyker
          // upp (renderBracket återställer även den öppna infopanelen).
          if (ui("view", "groups") === "bracket") renderBracket();
        }
      })
      .catch(function () { /* tyst – panelen funkar utan */ });
  }

  /* ---------- Kalendervy ---------- */
  function buildSchedule() {
    var items = [];
    WC.groupLetters.forEach(function (L) {
      groupFixtures(L).forEach(function (fx) {
        items.push({ kind: "group", date: fx.date, edt: fx.edt, letter: L, fx: fx });
      });
    });
    WC.knockout.forEach(function (m) {
      var disp = koMatchDisplay(m);
      items.push({ kind: "ko", date: disp.date, edt: disp.edt, m: m });
    });
    items.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      var ax = a.edt || "99:99", bx = b.edt || "99:99";
      return ax < bx ? -1 : ax > bx ? 1 : 0;
    });
    return items;
  }

  function tvChHtml(ch) {
    if (!ch) return "";
    return '<span class="cal-tv ' + (ch === "SVT" ? "svt" : "tv4") + '">' + ch + "</span>";
  }

  function tvLookupGroup(fx, th, ta) {
    var sched = WC.tvSchedule;
    if (sched && fx.date && fx.edt) {
      var k1 = fx.date + "|" + fx.edt + "|" + th.name + "|" + ta.name;
      var k2 = fx.date + "|" + fx.edt + "|" + ta.name + "|" + th.name;
      if (sched[k1]) return sched[k1];
      if (sched[k2]) return sched[k2];
    }
    return (WC.tvBroadcast && WC.tvBroadcast[fx.key]) || "";
  }

  function tvLookupKo(m) {
    var slot = m.date + "|" + (m.edt || "");
    if (WC.tvKoTime && WC.tvKoTime[slot]) return WC.tvKoTime[slot];
    return (WC.tvBroadcast && WC.tvBroadcast["k:" + m.m]) || "";
  }

  var ROUND_SHORT = { R32: "S16", R16: "Å16", QF: "Kvarts", SF: "Semi", "3RD": "Brons", FINAL: "Final" };

  function countdownParts(targetMs) {
    var diff = Math.max(0, targetMs - Date.now());
    var sec = Math.floor(diff / 1000);
    var days = Math.floor(sec / 86400); sec %= 86400;
    var hrs = Math.floor(sec / 3600); sec %= 3600;
    var mins = Math.floor(sec / 60); sec %= 60;
    return { d: days, h: hrs, m: mins, s: sec };
  }

  function koTeamsLabel(res) {
    var h = res.home.team ? bracketTeamName(res.home) : res.home.label;
    var a = res.away.team ? bracketTeamName(res.away) : res.away.label;
    return h + " – " + a;
  }

  /* Datum + tid för kompakta paneler (nästa match, Sverige/Uruguay). */
  function panelWhenCompact(m, live) {
    if (live) return "Pågår";
    var d = parseDateUTC(m.date);
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " · " + (m.edt || "TBC");
  }

  function nextMatchTimerUnit(id, val, lbl) {
    return '<span class="nm-unit"><span class="nm-val" id="' + id + '">' + val + '</span><span class="nm-lbl">' + lbl + '</span></span>';
  }

  var TEAM_SPOTLIGHT = [
    // accent = RGB-triplett för lagets identitetsfärg (blå resp. celeste).
    { iso: "se", title: "Sverige", accent: "74, 138, 222" },
    { iso: "uy", title: "Uruguay", accent: "76, 188, 232" }
  ];

  function findTeamByIso(iso) {
    var found = null;
    WC.groupLetters.forEach(function (L) {
      WC.groups[L].forEach(function (t, idx) {
        if (t.iso === iso) found = { team: t, group: L, idx: idx };
      });
    });
    return found;
  }

  function openTeamByIso(iso) {
    var found = findTeamByIso(iso);
    if (found) openTeam(found.group, found.idx);
  }

  /** Klickbart lag (knapp) – öppnar statistikfliken. */
  function teamOpenBtn(team, inner, className) {
    if (!team || !team.iso) return inner;
    var cls = "team-open" + (className ? " " + className : "");
    return '<button type="button" class="' + cls + '" data-team-open="' + team.iso + '">' + inner + "</button>";
  }

  function matchTeamsLabel(home, away) {
    var h = home && home.sv ? home.sv : (home || "");
    var a = away && away.sv ? away.sv : (away || "");
    return h + " – " + a;
  }

  /** Kompakt matchrad i Sverige/Uruguay-panelen – kortare namn än referens får plats. */
  function teamSvSpotlightBase(team) {
    if (!team || !team.sv) return "";
    return teamSvFixture(team);
  }

  function matchTeamsLabelCompact(home, away) {
    return teamSvSpotlightBase(home) + " – " + teamSvSpotlightBase(away);
  }

  function findTeamNextMatch(ctx, teamIso) {
    var info = findTeamByIso(teamIso);
    if (!info) return null;
    var matches = teamMatches(info.team, info.group, ctx);
    var now = Date.now();
    var twoH = 2 * 3600 * 1000;

    for (var i = 0; i < matches.length; i++) {
      var mm = matches[i];
      if (mm.played) continue;
      if (!mm.home || !mm.away) continue;

      var m = mm.m;
      var key = mm.kind === "group" ? mm.m.key : "k:" + mm.m.m;
      var when = whenLabels(m);
      var ko = kickoffUTC(m).getTime();
      var rs = getRes(key);
      var inPlay = rs && (rs.status === "IN_PLAY" || rs.status === "PAUSED" || rs.status === "LIVE");
      var live = inPlay || isMatchLive(key) || (ko <= now && ko > now - twoH);
      if (!live && ko < now - twoH) continue;

      var channel = mm.kind === "group"
        ? tvLookupGroup(mm.m, mm.home, mm.away)
        : tvLookupKo(mm.m);

      return {
        kickoff: ko,
        live: live,
        label: mm.label,
        time: when.time,
        whenText: panelWhenCompact(m, live),
        teams: matchTeamsLabelCompact(mm.home, mm.away),
        teamsFull: matchTeamsLabel(mm.home, mm.away),
        homeName: teamSvSpotlightBase(mm.home),
        awayName: teamSvSpotlightBase(mm.away),
        homeIso: mm.home.iso,
        awayIso: mm.away.iso,
        channel: channel,
        team: info.team,
        key: key
      };
    }
    return null;
  }

  function spotlightTvHtml(ch) {
    if (!ch) return '<span class="cal-tv cal-tv-empty" aria-hidden="true"></span>';
    return tvChHtml(ch);
  }

  /** Ett lagnamn i matchraden – fokuslaget (Sverige/Uruguay) lyfts fram. */
  function tsTeamName(name, iso, focusIso) {
    var focus = iso && iso === focusIso;
    return '<span class="ts-team' + (focus ? " is-focus" : "") + '">' + esc(name) + '</span>';
  }

  /** En lag-cell i den smala Sverige/Uruguay-remsan (sekundär under hjälten). */
  function teamStripItem(tp) {
    var accent = tp.accent ? ' style="--ts-accent: ' + tp.accent + '"' : "";
    var m = tp.match;
    if (!m) {
      return '<button type="button" class="ts-item is-empty team-open" data-team-open="' + tp.iso + '"' + accent + '>' +
        '<span class="ts-flag">' + flagImg(tp.iso) + '</span>' +
        '<span class="ts-body"><span class="ts-when nm-muted">Ingen kommande match</span>' +
        '<span class="ts-teams nm-muted">' + esc(tp.title) + '</span></span></button>';
    }
    var whenLine = m.label
      ? '<span class="ts-grp">' + esc(m.label) + '</span><span class="ts-when-time">' + esc(m.whenText) + '</span>'
      : '<span class="ts-when-time">' + esc(m.whenText) + '</span>';
    var teamsTitle = (m.teamsFull && m.teamsFull !== m.teams) ? ' title="' + esc(m.teamsFull) + '"' : "";
    // Bygg matchningen med fokuslaget framhävt; fall tillbaka på platt text.
    var teamsInner = m.homeName
      ? tsTeamName(m.homeName, m.homeIso, tp.iso) + '<span class="ts-sep">–</span>' + tsTeamName(m.awayName, m.awayIso, tp.iso)
      : esc(m.teams);
    var inner =
      '<span class="ts-flag">' + flagImg(tp.iso) +
        (m.live ? '<span class="ts-livedot"><span class="live-dot"></span></span>' : "") + '</span>' +
      '<span class="ts-body">' +
        '<span class="ts-when' + (m.live ? " is-live" : "") + '">' + whenLine + '</span>' +
        '<span class="ts-teams"' + teamsTitle + '>' + teamsInner + '</span>' +
      '</span>' +
      spotlightTvHtml(m.channel);
    // Med matchnyckel öppnar cellen matchinfo-modalen; annars laget (fallback).
    var open = m.key ? matchOpenAttr(m.key) : { attr: "", cls: "" };
    if (open.attr) {
      return '<div class="ts-item' + (m.live ? " is-live" : "") + open.cls + '"' + accent + open.attr + '>' + inner + '</div>';
    }
    return '<button type="button" class="ts-item team-open' + (m.live ? " is-live" : "") + '" data-team-open="' + tp.iso + '"' + accent + '>' +
      inner + '</button>';
  }

  /** Smal spotlight-remsa: nästa relevanta match för Sverige och Uruguay.
      Sekundär – ligger under hjälten och konkurrerar inte med "Match i fokus". */
  function teamsSpotlightStrip(ctx) {
    var teams = TEAM_SPOTLIGHT.map(function (t) {
      return { title: t.title, iso: t.iso, accent: t.accent, match: findTeamNextMatch(ctx, t.iso) };
    });
    var anyLive = teams.some(function (t) { return t.match && t.match.live; });
    var h = '<section class="teams-strip' + (anyLive ? " is-live" : "") + '" id="teamsSpotlight" aria-label="Sverige och Uruguay">';
    h += '<span class="ts-label">' + flagImg("se") + flagImg("uy") + 'Sverige &amp; Uruguay</span>';
    h += '<div class="ts-items">';
    teams.forEach(function (tp) { h += teamStripItem(tp); });
    h += '</div></section>';
    return h;
  }

  /* ---------- "Pågår nu"-panel ---------- */
  var LIVE_SOON_MS = 5 * 60 * 1000;        // visa matchen 5 min före avspark
  var LIVE_MATCH_MS = 2 * 3600 * 1000;     // antagen speltid när status saknas
  var LIVE_GRACE_MS = 45 * 60 * 1000;      // visa kvar resultatet efter slutsignal

  function matchIsPaused(key) {
    var fx = getApiFixture(key);
    if (fx && fx.status === "PAUSED") return true;
    var rs = getRes(key);
    return !!(rs && rs.status === "PAUSED");
  }

  /* Avslutad match ligger kvar i hjälten ~2h efter slutsignal, sen faller ytan
     tillbaka till nästa avspark. */
  var FOCUS_FT_GRACE_MS = 2 * 3600 * 1000;

  /** Senaste mål i en match (för live-hjältens händelserad). */
  function latestGoal(key) {
    var det = focusDetails[key];
    if (!det || !det.goals || !det.goals.length) return null;
    return det.goals[det.goals.length - 1];
  }

  /** Vilken match hjälten ("Match i fokus") ska visa och i vilket läge.
      Prioritet: pågående > nyss avslutad (~2h) > nästa avspark.
      Två samtidiga matcher (t.ex. sista gruppomgången) returneras båda. */
  function findFocusMatch(ctx) {
    var items = buildSchedule();
    var now = Date.now();
    var live = [], finished = [], upcoming = [];

    items.forEach(function (it) {
      var key, label, home, away, m, channel;
      if (it.kind === "group") {
        var fx = it.fx;
        key = fx.key; m = fx;
        home = WC.groups[it.letter][fx.h];
        away = WC.groups[it.letter][fx.a];
        label = "Grupp " + it.letter;
        channel = tvLookupGroup(fx, home, away);
      } else {
        var res = ctx.resolved[it.m.m];
        key = "k:" + it.m.m;
        m = res.match;
        home = res.home.team;
        away = res.away.team;
        label = (ROUND_SHORT[m.round] || m.round) + " · M" + it.m.m;
        channel = tvLookupKo(m);
      }
      if (!home || !away) return;

      var r = getRes(key);
      var ko = kickoffUTC(m).getTime();
      var liveNow = isMatchLive(key);
      var played = !liveNow && isPlayed(r) && !isLiveStatus(r && r.status);
      var lv = apiLive[key];
      var entry = {
        key: key, ko: ko, label: label, home: home, away: away, m: m,
        r: r || {}, time: m.edt || "", channel: channel,
        minute: lv && lv.minute != null ? lv.minute : null
      };

      if (liveNow || (!played && now >= ko && now < ko + LIVE_MATCH_MS)) {
        entry.state = "live";
        entry.paused = matchIsPaused(key);
        live.push(entry);
      } else if (played && now < ko + LIVE_MATCH_MS + FOCUS_FT_GRACE_MS) {
        entry.state = "ft";
        finished.push(entry);
      } else if (!played && ko >= now) {
        entry.state = "next";
        upcoming.push(entry);
      }
    });

    function byKey(a, b) { return (a.ko - b.ko) || (a.key < b.key ? -1 : 1); }

    if (live.length) {
      live.sort(byKey);
      return { state: "live", kickoff: live[0].ko, matches: live.slice(0, 2) };
    }
    if (finished.length) {
      var maxKo = Math.max.apply(null, finished.map(function (e) { return e.ko; }));
      return {
        state: "ft", kickoff: maxKo,
        matches: finished.filter(function (e) { return e.ko === maxKo; }).sort(byKey).slice(0, 2)
      };
    }
    if (upcoming.length) {
      upcoming.sort(byKey);
      var best = upcoming[0].ko;
      return {
        state: "next", kickoff: best,
        matches: upcoming.filter(function (e) { return e.ko === best; }).slice(0, 2)
      };
    }
    return { state: "none", kickoff: null, matches: [] };
  }

  var FOCUS_HEADINGS = {
    live: { one: "Pågående match", many: "Pågående matcher" },
    ft: { one: "Avslutad match", many: "Avslutade matcher" },
    next: { one: "Nästa match", many: "Nästa matcher" }
  };

  /** Live-status: pulserande prick + spelminut (eller Halvtid/LIVE). */
  function focusLiveBadge(e) {
    var txt = e.paused ? "Halvtid" : (e.minute != null ? esc(e.minute) + "'" : "LIVE");
    return '<span class="fh-live"><span class="live-dot"></span>' + txt + '</span>';
  }

  /** En lagsida i hjälten – flaggan vänd inåt mot ställningen. */
  function focusTeamSide(team, side) {
    var flag = '<span class="fh-flag">' + flagImg(team.iso) + '</span>';
    var name = '<span class="fh-name" title="' + esc(team.sv) + '">' + esc(teamSvFixture(team)) + '</span>';
    return '<div class="fh-team fh-' + side + '">' + (side === "home" ? name + flag : flag + name) + '</div>';
  }

  /** Senaste viktiga händelse (mål) i en pågående match. */
  function focusEventLine(e) {
    var g = latestGoal(e.key);
    if (!g) return "";
    var team = g.team === "a" ? e.away : e.home;
    var min = g.minute != null ? (g.minute + (g.injuryTime ? "+" + g.injuryTime : "") + "'") : "";
    var sc = g.score ? g.score.h + "–" + g.score.a : "";
    return '<div class="fh-event">' +
      '<span class="fh-ev-ic" aria-hidden="true">⚽</span>' +
      '<span class="fh-ev-flag">' + flagImg(team.iso) + '</span>' +
      '<span class="fh-ev-txt"><b>' + esc(g.scorer || "Mål") + '</b>' +
        (min ? '<span class="fh-ev-min">' + esc(min) + '</span>' : "") + '</span>' +
      (sc ? '<span class="fh-ev-score">' + esc(sc) + '</span>' : "") +
      '</div>';
  }

  function focusCountdown(kickoff) {
    var p = countdownParts(kickoff);
    return '<div class="fh-countdown" id="focusTimer" data-kickoff="' + (kickoff || "") + '" aria-live="polite">' +
      nextMatchTimerUnit("fh-d", p.d, "dygn") +
      nextMatchTimerUnit("fh-h", pad(p.h), "tim") +
      nextMatchTimerUnit("fh-m", pad(p.m), "min") +
      nextMatchTimerUnit("fh-s", pad(p.s), "sek") +
      "</div>";
  }

  /** Säkerställ att live/avslutade matcher alltid är klickbara (modalen fyller
      på tomma flikar via pollningen även i glappet vid avspark). */
  function focusOpenAttr(e) {
    var open = matchOpenAttr(e.key);
    if (!open.attr && (e.state === "live" || e.state === "ft")) {
      open = { attr: ' data-match-open="' + e.key + '" role="button" tabindex="0"', cls: " match-openable" };
    }
    return open;
  }

  /** Stort hjältekort – ett huvudnummer per läge (nästa/pågående/avslutad). */
  function focusBigCard(e, state, kickoff) {
    var open = focusOpenAttr(e);
    var when = whenLabels(e.m);
    var center, status = "";
    if (state === "next") {
      center = '<span class="fh-vs" aria-hidden="true">vs</span>';
    } else {
      center = '<span class="fh-score">' +
        '<span class="fh-sc">' + (e.r.h != null ? e.r.h : 0) + '</span>' +
        '<span class="fh-dash" aria-hidden="true">–</span>' +
        '<span class="fh-sc">' + (e.r.a != null ? e.r.a : 0) + '</span></span>';
    }
    if (state === "live") status = focusLiveBadge(e);
    else if (state === "ft") status = '<span class="fh-ftbadge">Slutresultat</span>';

    var h = '<article class="focus-card fc-' + state + open.cls + '"' + open.attr + '>';
    h += '<div class="fh-top">' +
      '<span class="fh-eyebrow">' + esc(FOCUS_HEADINGS[state].one) + '</span>' +
      '<span class="fh-top-right"><span class="fh-group">' + esc(e.label) + '</span>' + status + '</span>' +
      '</div>';
    h += '<div class="fh-main">' +
      focusTeamSide(e.home, "home") + center + focusTeamSide(e.away, "away") +
      '</div>';
    if (state === "live") h += focusEventLine(e);
    h += '<div class="fh-meta">' +
      '<span class="fh-when">' + esc(when.dateLabel + " · " + when.time) + '</span>' +
      spotlightTvHtml(e.channel) +
      '</div>';
    if (state === "next") h += focusCountdown(kickoff != null ? kickoff : e.ko);
    h += '</article>';
    return h;
  }

  /** Kompakt hjältekort när två matcher delar fokus (samtidiga avsparkar). */
  function focusMiniCard(e, state) {
    var open = focusOpenAttr(e);
    var status = state === "live" ? focusLiveBadge(e)
      : state === "ft" ? '<span class="fm-ft">Slut</span>'
        : '<span class="fm-time">' + esc(e.time || whenLabels(e.m).time) + '</span>';
    function sideRow(team, sc) {
      return '<div class="fm-side">' +
        '<span class="fm-flag">' + flagImg(team.iso) + '</span>' +
        '<span class="fm-name" title="' + esc(team.sv) + '">' + esc(teamSvFixture(team)) + '</span>' +
        '<span class="fm-sc">' + sc + '</span></div>';
    }
    var hs = state === "next" ? "" : (e.r.h != null ? e.r.h : 0);
    var as = state === "next" ? "" : (e.r.a != null ? e.r.a : 0);
    var h = '<article class="focus-mini fm-' + state + open.cls + '"' + open.attr + '>';
    h += '<div class="fm-top"><span class="fm-group">' + esc(e.label) + '</span>' + status + '</div>';
    h += sideRow(e.home, hs) + sideRow(e.away, as);
    h += '<div class="fm-foot">' + spotlightTvHtml(e.channel) + '</div>';
    h += '</article>';
    return h;
  }

  /** Sidans huvudnummer: en bred hjälteyta som alltid visar den mest
      relevanta matchen just nu. */
  function focusHero(ctx) {
    var f = findFocusMatch(ctx);
    if (f.state === "none" || !f.matches.length) {
      return '<section class="focus-hero is-empty" aria-label="Match i fokus">' +
        '<span class="fh-eyebrow">Match i fokus</span>' +
        '<p class="fh-empty">Inga kvarvarande matcher</p></section>';
    }
    var multi = f.matches.length > 1;
    var h = '<section class="focus-hero state-' + f.state + (multi ? " is-multi" : " is-single") +
      '" aria-label="Match i fokus">';
    if (!multi) {
      h += focusBigCard(f.matches[0], f.state, f.kickoff);
    } else {
      h += '<div class="fh-multi-head">' +
        '<span class="fh-eyebrow">' + esc(FOCUS_HEADINGS[f.state].many) + '</span>' +
        (f.state === "live" ? '<span class="fh-live"><span class="live-dot"></span>LIVE</span>' : "") +
        '</div>';
      h += '<div class="focus-mini-grid">';
      f.matches.forEach(function (e) { h += focusMiniCard(e, f.state); });
      h += '</div>';
      if (f.state === "next") h += focusCountdown(f.kickoff);
    }
    h += '</section>';
    return h;
  }

  function updatePanelCountdown(panelId, prefix) {
    var el = document.getElementById(panelId);
    if (!el || el.getAttribute("data-live") === "1") return;
    var ko = parseInt(el.getAttribute("data-kickoff"), 10);
    if (!ko) return;
    var p = countdownParts(ko);
    var d = document.getElementById(prefix + "-d");
    var hrs = document.getElementById(prefix + "-h");
    var mins = document.getElementById(prefix + "-m");
    var secs = document.getElementById(prefix + "-s");
    if (d) d.textContent = p.d;
    if (hrs) hrs.textContent = pad(p.h);
    if (mins) mins.textContent = pad(p.m);
    if (secs) secs.textContent = pad(p.s);
  }

  function updateNextCountdown() {
    updatePanelCountdown("focusTimer", "fh");
  }

  /** Nyckel, matchobjekt och spelad-status för kalenderpost. */
  function scheduleItemKey(it) {
    return it.kind === "ko" ? "k" + it.m.m : it.fx.key;
  }
  function scheduleItemMatch(it, ctx) {
    return it.kind === "ko" ? ctx.resolved[it.m.m].match : it.fx;
  }
  function scheduleItemResKey(it) {
    return it.kind === "ko" ? "k:" + it.m.m : it.fx.key;
  }
  function scheduleItemPlayed(it, ctx) {
    return isPlayed(getRes(scheduleItemResKey(it)));
  }

  /** Nästa match(er), nyligen spelade + scrollmål för kalendervyn. */
  function calendarViewState(items, ctx) {
    var now = Date.now();
    var twoH = 2 * 3600 * 1000;
    var nextKeys = [];
    var bestKo = Infinity;

    items.forEach(function (it) {
      if (scheduleItemPlayed(it, ctx)) return;
      var ko = kickoffUTC(scheduleItemMatch(it, ctx)).getTime();
      if (ko >= now - twoH && ko < bestKo) bestKo = ko;
    });

    if (bestKo !== Infinity) {
      items.forEach(function (it) {
        if (scheduleItemPlayed(it, ctx)) return;
        if (kickoffUTC(scheduleItemMatch(it, ctx)).getTime() === bestKo) {
          nextKeys.push(scheduleItemKey(it));
        }
      });
    }

    var nextDate = null;
    if (nextKeys.length) {
      items.forEach(function (it) {
        if (nextKeys.indexOf(scheduleItemKey(it)) >= 0) nextDate = it.date;
      });
    }

    var anyPlayed = items.some(function (it) { return scheduleItemPlayed(it, ctx); });
    var scrollTop = !anyPlayed && nextKeys.length > 0;
    var scrollDate = null;
    var recentKeys = [];

    if (scrollTop) {
      // inför första matchen – börja högst upp
    } else if (!nextKeys.length) {
      scrollDate = items.length ? items[items.length - 1].date : null;
      items.forEach(function (it) {
        if (it.date === scrollDate && scheduleItemPlayed(it, ctx)) {
          recentKeys.push(scheduleItemKey(it));
        }
      });
    } else {
      var prevDay = shiftDateUTC(nextDate, -1);
      var hasPrevDay = items.some(function (it) { return it.date === prevDay; });
      if (hasPrevDay) scrollDate = prevDay;
      else {
        for (var i = items.length - 1; i >= 0; i--) {
          if (items[i].date < nextDate) { scrollDate = items[i].date; break; }
        }
      }
      if (scrollDate) {
        items.forEach(function (it) {
          if (it.date === scrollDate && scheduleItemPlayed(it, ctx)) {
            recentKeys.push(scheduleItemKey(it));
          }
        });
      }
    }

    // Mål för "Hoppa till …"-knappen: idag om det spelas matcher idag,
    // annars nästa matchdag, annars sista matchdagen.
    var todayStr = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    var hasToday = items.some(function (it) { return it.date === todayStr; });
    var jumpLive = bestKo !== Infinity && bestKo <= now;
    var jumpDate, jumpLabel;
    if (hasToday) {
      jumpDate = todayStr;
      jumpLabel = jumpLive ? "Till matchen som pågår" : "Hoppa till idag";
    } else if (nextDate) {
      jumpDate = nextDate;
      jumpLabel = "Hoppa till nästa match";
    } else if (items.length) {
      jumpDate = items[items.length - 1].date;
      jumpLabel = "Hoppa till sista matchen";
    } else {
      jumpDate = null;
      jumpLabel = "";
    }

    return {
      nextKeys: nextKeys, recentKeys: recentKeys, scrollDate: scrollDate, scrollTop: scrollTop,
      jumpDate: jumpDate, jumpLabel: jumpLabel, jumpLive: jumpLive,
    };
  }

  function scrollCalendarTop() {
    requestAnimationFrame(function () {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    });
  }

  function scrollCalendarToDate(dateStr, smooth) {
    if (!dateStr || !viewEl) return;
    requestAnimationFrame(function () {
      var el = viewEl.querySelector('.cal-day[data-date="' + dateStr + '"]');
      if (!el) return;
      var topbar = document.querySelector(".topbar");
      var offset = (topbar ? topbar.offsetHeight : 72) + 8;
      var top = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: Math.max(0, top), left: 0, behavior: smooth ? "smooth" : "instant" });
    });
  }

  function renderCalendar() {
    var ctx = getCtx();
    var items = buildSchedule();
    var calView = calendarViewState(items, ctx);

    var jumpBtn = calView.jumpDate
      ? '<button type="button" class="cal-jump' + (calView.jumpLive ? " is-live" : "") +
        '" data-cal-jump="' + calView.jumpDate + '">' +
        '<span class="cal-jump-txt">' + calView.jumpLabel + "</span>" +
        '<span class="cal-jump-ico" aria-hidden="true">↓</span></button>'
      : "";
    var html = '<div class="calendar-layout">' +
      '<div class="cal-shell">' + jumpBtn + '<div class="cal">';
    var lastDate = null;
    items.forEach(function (it) {
      if (it.date !== lastDate) {
        if (lastDate !== null) html += '</div></div>'; // stäng föregående cal-body + cal-day
        var d = parseDateUTC(it.date);
        html += '<div class="cal-day" data-date="' + it.date + '"><div class="cal-date">' +
          '<span class="cal-dow">' + WEEKDAYS_LONG[d.getUTCDay()] + '</span>' +
          '<span class="cal-dnum">' + d.getUTCDate() + '</span>' +
          '<span class="cal-mon">' + MONTHS_LONG[d.getUTCMonth()] + '</span></div>' +
          '<div class="cal-body">';
        lastDate = it.date;
      }
      var key = scheduleItemKey(it);
      var isNext = calView.nextKeys.indexOf(key) >= 0;
      var isRecent = calView.recentKeys.indexOf(key) >= 0;
      html += it.kind === "ko" ? calKoRow(ctx.resolved[it.m.m], isNext, isRecent)
                               : calGroupRow(it, isNext, isRecent);
    });
    if (lastDate !== null) html += '</div></div>';
    html += '</div></div></div>';
    viewEl.innerHTML = html;
    updateNextCountdown();

    if (calScrollPending) {
      calScrollPending = false;
      scrollCalendarTop(); // börja alltid högst upp – knappen tar dig till idag/nästa match
    }
    if (calGroupOpen) renderCalGroupPopup();
  }

  function hideCalGroupPopup() {
    calGroupOpen = null;
    renderCalGroupPopup();
  }

  /* Sannolik sluttabell: per lag P(1:a/2:a/3:a/4:a) + P(vidare) ur oddsmotorn,
     som en liten "heatmap" under grupptabellen. Tom sträng tills probs laddats. */
  function groupFinishProbsHtml(table) {
    if (!bracketProbs || !bracketProbs.groupPositions || !table) return "";
    var posMeta = [["1", "gp-pos-1"], ["2", "gp-pos-2"], ["3", "gp-pos-3"], ["4", "gp-pos-4"]];
    var rows = "", any = false;
    table.forEach(function (e) {
      var t = e.team;
      var gp = bracketProbs.groupPositions[t.name];
      if (!gp) return;
      any = true;
      var rds = bracketProbs.rounds && bracketProbs.rounds[t.name];
      var cells = posMeta.map(function (m) {
        var p = gp[m[0]] || 0;
        return '<td class="gp-cell ' + m[1] + '" style="--p:' + p.toFixed(3) + '">' +
          '<span>' + fmtPct(p) + '%</span></td>';
      }).join("");
      var adv = rds && rds.r32 != null ? rds.r32 : ((gp["1"] || 0) + (gp["2"] || 0));
      cells += '<td class="gp-cell gp-adv" style="--p:' + adv.toFixed(3) + '">' +
        '<span>' + fmtPct(adv) + '%</span></td>';
      rows += '<tr><th scope="row" class="gp-team">' + flagImg(t.iso) +
        '<span>' + esc(t.svShort || t.sv) + '</span></th>' + cells + '</tr>';
    });
    if (!any) return "";
    return '<div class="grp-probs">' +
      '<div class="grp-probs-title">Trolig sluttabell<span> · enligt aktuella odds</span></div>' +
      '<table class="grp-prob-table"><thead><tr>' +
        '<th class="gp-team">Lag</th><th>1:a</th><th>2:a</th><th>3:a</th><th>4:a</th>' +
        '<th class="gp-adv" title="Sannolikhet att gå vidare till slutspel – som topp 2 eller en av de åtta bästa treorna">Vidare</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function openCalGroupPopup(L) {
    calGroupOpen = L;
    renderCalGroupPopup();
  }

  function renderCalGroupPopup() {
    var popup = document.getElementById("calGroupPopup");
    var backdrop = document.getElementById("calGroupBackdrop");
    if (!popup || !backdrop) return;
    if (!calGroupOpen) {
      popup.classList.remove("open");
      backdrop.classList.remove("open");
      popup.innerHTML = "";
      return;
    }
    var ctx = getCtx();
    var L = calGroupOpen;
    var thirdQ = isThirdQ(ctx, L);
    popup.innerHTML =
      '<div class="cal-group-head">' +
        '<h3><span class="' + groupPillClass(L, "is-lg") + '">Grupp ' + L + "</span></h3>" +
        '<button type="button" class="cal-group-close" id="calGroupClose" title="Stäng">×</button>' +
      "</div>" +
      '<table class="standings mini"><thead><tr>' +
        '<th class="c-pos">#</th><th class="c-team">Lag</th>' +
        '<th title="Spelade">S</th><th title="Vinster">V</th><th title="Oavgjorda">O</th><th title="Förluster">F</th>' +
        '<th title="Gjorda–insläppta mål">Mål</th><th title="Målskillnad">+/-</th>' +
        '<th class="c-cards" title="Gula/röda kort">Kort</th>' +
        '<th class="c-fp" title="Fair play-poäng: −1 gult, −3 två gula, −4 direkt rött, −5 gult + direkt rött">FP</th>' +
        '<th class="c-pts" title="Poäng">P</th>' +
      "</tr></thead><tbody>" +
      standingsRows(ctx.tables[L], { thirdQualified: thirdQ, fp: true }) +
      "</tbody></table>" +
      groupFinishProbsHtml(ctx.tables[L]) +
      '<p class="cal-group-note">Lag särskiljs i ordningen poäng → målskillnad → gjorda mål → inbördes möte → ' +
      "fair play (FP, beräknas från korten) → FIFA-ranking. Klicka på ett lag för trupp och statistik.</p>";
    popup.classList.add("open");
    backdrop.classList.add("open");
  }

  function calRowClass(isNext, isRecent, extra) {
    var cls = "cal-row";
    if (extra) cls += " " + extra;
    if (isNext) cls += " is-next";
    else if (isRecent) cls += " is-recent";
    return cls;
  }

  function calVenueCell(channel, isNext) {
    var tv = channel ? tvChHtml(channel) : "";
    return '<span class="cal-venue">' +
      (isNext ? '<span class="cal-next">Nästa</span>' : '<span class="cal-next cal-next-slot" aria-hidden="true">Nästa</span>') +
      (tv || '<span class="cal-tv cal-tv-empty" aria-hidden="true"></span>') +
      "</span>";
  }

  function calGroupRow(it, isNext, isRecent) {
    var L = it.letter, fx = it.fx;
    var th = WC.groups[L][fx.h], ta = WC.groups[L][fx.a];
    var r = getRes(fx.key) || {};
    var played = isPlayed(r);
    var when = whenLabels(fx);
    var live = isMatchLive(fx.key);
    var score = (played || live) ? '<span class="cal-score">' + (r.h || 0) + '–' + (r.a || 0) + '</span>'
                       : '<span class="cal-vs">–</span>';
    var open = matchOpenAttr(fx.key);
    return '<div class="' + calRowClass(isNext, isRecent, (live ? "is-live" : "") + open.cls) + '"' + open.attr + '>' +
      '<span class="cal-time">' + (live ? liveTimeLabel(fx.key, when.time) : when.time) + '</span>' +
      '<button type="button" class="cal-badge grp grp-' + L + ' cal-group-btn" data-cal-group="' + L + '">Grupp ' + L + '</button>' +
      '<span class="cal-match">' + teamOpenBtn(th, '<span title="' + esc(th.sv) + '">' + esc(teamSvFixture(th)) + '</span>' + flagImg(th.iso), "cal-side home") +
        score +
        teamOpenBtn(ta, flagImg(ta.iso) + '<span title="' + esc(ta.sv) + '">' + esc(teamSvFixture(ta)) + '</span>', "cal-side away") + '</span>' +
      calVenueCell(tvLookupGroup(fx, th, ta), isNext) +
      '</div>';
  }

  var CAL_ROUND = { R32: "S16", R16: "Å16", QF: "Kvarts", SF: "Semi", "3RD": "Brons", FINAL: "Final" };

  function calKoRow(res, isNext, isRecent) {
    var m = res.match;
    var when = whenLabels(m);
    var r = getRes("k:" + m.m) || res.result || {};
    var played = isPlayed(r);
    var hProv = res.home.team && !res.home.decided;
    var aProv = res.away.team && !res.away.decided;
    var hName = res.home.team ? esc(bracketTeamName(res.home)) : '<i>' + esc(res.home.label) + '</i>';
    var aName = res.away.team ? esc(bracketTeamName(res.away)) : '<i>' + esc(res.away.label) + '</i>';
    var hFlag = res.home.team ? flagImg(res.home.team.iso) : "";
    var aFlag = res.away.team ? flagImg(res.away.team.iso) : "";
    var live = isMatchLive("k:" + m.m);
    var score = (played || live) ? '<span class="cal-score">' + (r.h || 0) + '–' + (r.a || 0) +
      (played && r.h === r.a && r.pw ? '<sup>S</sup>' : '') + '</span>' : '<span class="cal-vs">–</span>';
    var hHome = res.home.team
      ? teamOpenBtn(res.home.team, hName + hFlag, "cal-side home" + (hProv ? " prov" : ""))
      : '<span class="cal-side home' + (hProv ? " prov" : "") + '">' + hName + hFlag + '</span>';
    var hAway = res.away.team
      ? teamOpenBtn(res.away.team, aFlag + aName, "cal-side away" + (aProv ? " prov" : ""))
      : '<span class="cal-side away' + (aProv ? " prov" : "") + '">' + aFlag + aName + '</span>';
    var open = matchOpenAttr("k:" + m.m, !!(res.home.team && res.away.team));
    return '<div class="' + calRowClass(isNext, isRecent, "ko" + (live ? " is-live" : "") + open.cls) + '" data-m="' + m.m + '"' + open.attr + '>' +
      '<span class="cal-time">' + (live ? liveTimeLabel("k:" + m.m, when.time) : when.time) + '</span>' +
      '<span class="cal-badge ' + m.round + '">' + (CAL_ROUND[m.round] || m.round) + ' · M' + m.m + '</span>' +
      '<span class="cal-match">' + hHome + score + hAway + '</span>' +
      calVenueCell(tvLookupKo(m), isNext) +
      '</div>';
  }

  /* ====================================================================
     LAGSÖK + LAG-PANEL
  ==================================================================== */
  function allTeams() {
    var arr = [];
    WC.groupLetters.forEach(function (L) {
      WC.groups[L].forEach(function (t, i) { arr.push({ team: t, group: L, idx: i }); });
    });
    return arr;
  }

  /** FIFA-kod → WC-lag ({team, group, idx}) så person-träffar får flagga/grupp. */
  function wcTeamByCode() {
    var map = {};
    if (!window.VMPlayers || typeof VMPlayers.isoToCode !== "function") return map;
    allTeams().forEach(function (e) {
      var code = VMPlayers.isoToCode(e.team.iso);
      if (code) map[code] = e;
    });
    return map;
  }

  function srPersonRow(attrs, iso, name, sub) {
    return '<button class="sr-item"' + attrs + '>' +
      (iso ? flagImg(iso) : '<span class="sr-flag-blank"></span>') +
      '<span class="sr-name">' + esc(name) + '</span>' +
      '<span class="sr-grp">' + esc(sub) + '</span></button>';
  }

  function renderSearchResults(query) {
    var box = document.getElementById("searchResults");
    if (!box) return;
    var q = (query || "").trim().toLowerCase();
    if (!q) { box.hidden = true; box.innerHTML = ""; return; }

    // Truppdatan laddas asynkront – sök om när den är klar så spelare/tränare syns.
    if (window.VMPlayers && !VMPlayers.isLoaded()) {
      VMPlayers.load().then(function () {
        var el = document.getElementById("teamSearch");
        if (el && el.value.trim().toLowerCase() === q) renderSearchResults(el.value);
      }).catch(function () {});
    }

    var html = "";

    allTeams().filter(function (e) {
      return e.team.sv.toLowerCase().indexOf(q) !== -1 || e.team.name.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 5).forEach(function (e) {
      html += '<button class="sr-item" data-team-group="' + e.group + '" data-team-idx="' + e.idx + '">' +
        flagImg(e.team.iso) + '<span class="sr-name">' + esc(e.team.sv) + '</span>' +
        '<span class="' + groupPillClass(e.group) + '">Grupp ' + e.group + '</span></button>';
    });

    var people = (window.VMPlayers && typeof VMPlayers.search === "function")
      ? VMPlayers.search(q, 6) : { players: [], coaches: [] };
    var codeMap = (people.players.length || people.coaches.length) ? wcTeamByCode() : {};

    people.players.forEach(function (hit) {
      var wc = codeMap[hit.team.fifa_code];
      var iso = wc ? wc.team.iso : null;
      html += srPersonRow(' data-player-id="' + esc(hit.player.id) + '"', iso, hit.player.name,
        "Spelare · " + (hit.team.name_sv || hit.team.name));
    });

    people.coaches.slice(0, 3).forEach(function (hit) {
      var wc = codeMap[hit.team.fifa_code];
      var iso = wc ? wc.team.iso : null;
      html += srPersonRow(iso ? ' data-team-open="' + iso + '"' : "", iso, hit.name,
        "Förbundskapten · " + (hit.team.name_sv || hit.team.name));
    });

    box.innerHTML = html || '<div class="sr-empty">Inget hittades</div>';
    box.hidden = false;
  }

  function openSearchPlayer(id) {
    if (!window.VMPlayers || !window.VMLive || typeof VMLive.openPlayer !== "function") return;
    var p = VMPlayers.getPlayerById(id);
    var team = VMPlayers.getTeamOfPlayer(id);
    if (!p || !team) return;
    var s = document.getElementById("teamSearch");
    if (s) s.value = "";
    var box = document.getElementById("searchResults");
    if (box) { box.hidden = true; box.innerHTML = ""; }
    VMLive.openPlayer(p, { sv: team.name_sv, name: team.name });
  }

  function openTeam(group, idx) {
    selectedTeam = { group: group, idx: idx };
    var s = document.getElementById("teamSearch");
    if (s) s.value = "";
    var box = document.getElementById("searchResults");
    if (box) { box.hidden = true; box.innerHTML = ""; }
    renderTeamDrawer();
  }
  function closeTeam() { selectedTeam = null; renderTeamDrawer(); }

  /* Alla matcher som rör ett lag (grupp + slutspel där laget är aktuellt). */
  function teamMatches(team, group, ctx) {
    var list = [];
    groupFixtures(group).forEach(function (fx) {
      if (WC.groups[group][fx.h] !== team && WC.groups[group][fx.a] !== team) return;
      var home = WC.groups[group][fx.h], away = WC.groups[group][fx.a];
      var r = getRes(fx.key) || {};
      list.push({
        kind: "group", date: fx.date, edt: null, m: fx,
        home: home, away: away, isHome: home === team,
        played: isPlayed(r), r: r, label: "Grupp " + group, venue: null
      });
    });
    WC.knockout.forEach(function (mt) {
      var res = ctx.resolved[mt.m];
      var isHome = res.home.team === team, isAway = res.away.team === team;
      if (!isHome && !isAway) return;
      var r = res.result || {};
      list.push({
        kind: "ko", date: res.match.date, edt: res.match.edt, m: res.match,
        home: res.home.team, away: res.away.team, isHome: isHome,
        played: res.bothTeams && isPlayed(r), r: r,
        label: WC.roundNames[mt.round] + " · M" + mt.m, venue: WC.venues[mt.venue],
        decided: (isHome ? res.home.decided : res.away.decided)
      });
    });
    list.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.edt || "99:99") < (b.edt || "99:99") ? -1 : 1;
    });
    return list;
  }

  function renderTeamDrawer() {
    var drawer = document.getElementById("teamDrawer");
    var backdrop = document.getElementById("drawerBackdrop");
    if (!drawer) return;
    if (!selectedTeam) {
      drawer.classList.remove("open");
      backdrop.classList.remove("open");
      drawer.innerHTML = "";
      return;
    }
    var ctx = getCtx();
    var L = selectedTeam.group;
    var team = WC.groups[L][selectedTeam.idx];
    var table = ctx.tables[L];
    var st = table.filter(function (s) { return s.team === team; })[0];
    var pos = st.rank + 1;

    // status / projektion
    var statusTxt, statusCls;
    if (pos <= 2) { statusTxt = (pos === 1 ? "Etta" : "Tvåa") + " i grupp " + L + " – mot slutspel"; statusCls = "adv"; }
    else if (pos === 3) {
      var q = isThirdQ(ctx, L);
      statusTxt = "Trea i grupp " + L + (q ? " – kvalificerad (bästa treor)" : " – utanför just nu");
      statusCls = q ? "third-q" : "third-o";
    } else { statusTxt = "Fyra i grupp " + L + " – utanför"; statusCls = "out"; }

    var matches = teamMatches(team, L, ctx);
    var now = Date.now();
    var next = null;
    matches.forEach(function (mm) {
      if (mm.played) return;
      if (!mm.home || !mm.away) return;
      var ko = kickoffUTC(mm.m).getTime();
      if (ko >= now - 2 * 3600 * 1000 && (!next || ko < next._ko)) { next = mm; next._ko = ko; }
    });
    if (!next) {
      for (var i = 0; i < matches.length; i++) {
        if (!matches[i].played && matches[i].home && matches[i].away) { next = matches[i]; break; }
      }
    }
    var playedMatches = matches.filter(function (mm) { return mm.played && mm.home && mm.away; }).reverse();
    var upcomingMatches = matches.filter(function (mm) { return !mm.played && mm.home && mm.away; });

    var h = '<div class="drawer-head">' +
      '<span class="dh-flag">' + flagImg(team.iso) + '</span>' +
      '<div class="dh-title"><h3>' + esc(team.sv) + '</h3>' +
        '<span class="dh-sub">' + esc(team.name) + ' · <span class="' + groupPillClass(L) + '">Grupp ' + L + '</span></span></div>' +
      '<button class="drawer-close" id="drawerClose" title="Stäng">×</button></div>';

    h += '<div class="drawer-body">';
    h += '<div class="status-pill ' + statusCls + '">' + statusTxt + '</div>';

    // Nästa match
    h += '<div class="drawer-card"><div class="dc-title">Nästa match</div>';
    if (next && next.home && next.away) {
      h += teamMatchRow(team, next, true);
    } else {
      h += '<div class="dc-empty">Ingen kommande match avgjord ännu.</div>';
    }
    h += '</div>';

    // Statistik
    h += '<div class="drawer-card"><div class="dc-title">Statistik (gruppspel)</div>' +
      '<div class="stat-grid">' +
        statBox("Plac.", pos + " / 4") + statBox("Poäng", st.pts) + statBox("Spelade", st.pld) +
        statBox("V-O-F", st.w + "-" + st.d + "-" + st.l) + statBox("Mål", st.gf + "–" + st.ga) +
        statBox("Diff", (st.gd > 0 ? "+" : "") + st.gd) +
        statBox("Gula kort", st.fpY) + statBox("Röda kort", st.fpR) +
        statBox("Fair play", st.fp) +
      '</div></div>';

    // Tabell
    h += '<div class="drawer-card"><div class="dc-title">Tabell – Grupp ' + L + '</div>' +
      '<table class="standings mini"><thead><tr><th class="c-pos">#</th><th class="c-team">Lag</th>' +
      '<th>S</th><th>P</th><th>+/-</th></tr></thead><tbody>' +
      table.map(function (s, i) {
        var cls = i < 2 ? "r-adv" : (i === 2 ? (isThirdQ(ctx, L) ? "r-third-q" : "r-third-o") : "");
        if (s.team === team) cls += " r-highlight";
        return '<tr class="' + cls + '" data-team="' + s.team.iso + '"><td class="c-pos">' + (i + 1) + '</td>' +
          '<td class="c-team"><span class="team">' + flagImg(s.team.iso) + '<span class="t-name">' + esc(s.team.sv) + '</span></span></td>' +
          '<td>' + s.pld + '</td><td class="c-pts">' + s.pts + '</td>' +
          '<td>' + (s.gd > 0 ? "+" + s.gd : s.gd) + '</td></tr>';
      }).join("") + '</tbody></table></div>';

    // Spelade matcher (hela mästerskapet, senaste först)
    h += '<div class="drawer-card"><div class="dc-title">Spelade matcher</div>';
    if (playedMatches.length) {
      playedMatches.forEach(function (mm) { h += teamMatchRow(team, mm, false); });
    } else {
      h += '<div class="dc-empty">Inga matcher spelade ännu.</div>';
    }
    h += '</div>';

    // Kommande matcher
    h += '<div class="drawer-card"><div class="dc-title">Spelschema</div>';
    if (upcomingMatches.length) {
      upcomingMatches.forEach(function (mm) { h += teamMatchRow(team, mm, false); });
    } else {
      h += '<div class="dc-empty">Inga kommande matcher kvar.</div>';
    }
    h += '</div>';

    h += '</div>';
    drawer.innerHTML = h;
    drawer.classList.add("open");
    document.getElementById("drawerBackdrop").classList.add("open");

    // Hook: låter live-modulen (assets/live.js) injicera spelarlista + statistik.
    if (window.VMLive && typeof window.VMLive.onTeamDrawer === "function") {
      try { window.VMLive.onTeamDrawer(team, L, drawer); } catch (e) {}
    }
  }

  function statBox(label, val) {
    return '<div class="stat-box"><span class="sb-val">' + esc("" + val) + '</span><span class="sb-lbl">' + label + '</span></div>';
  }

  function teamMatchRow(team, mm, big) {
    var opp = mm.isHome ? mm.away : mm.home;
    var when = whenLabels(mm.m);
    var rel = relativeLabel(mm.m, mm.played);
    var resultTxt = "";
    if (mm.played) {
      var myG = mm.isHome ? mm.r.h : mm.r.a, opG = mm.isHome ? mm.r.a : mm.r.h;
      var outcome = myG > opG ? "v" : (myG < opG ? "f" : "o");
      if (myG === opG && mm.r.pw) outcome = (mm.r.pw === (mm.isHome ? "h" : "a")) ? "v" : "f";
      resultTxt = '<span class="tm-res ' + outcome + '">' + myG + '–' + opG + '</span>';
    } else {
      resultTxt = '<span class="tm-rel ' + rel.cls + '">' + rel.txt + '</span>';
    }
    return '<div class="tm-row' + (big ? " big" : "") + '">' +
      '<span class="tm-when">' + when.dateLabel + ' · ' + when.time + '</span>' +
      '<span class="tm-opp">' + (mm.isHome ? "mot " : "borta mot ") +
        (opp ? flagImg(opp.iso) + esc(opp.sv) : "?") + '</span>' +
      '<span class="tm-tag">' + mm.label + '</span>' +
      resultTxt + '</div>';
  }

  /* ====================================================================
     TOOLTIP (hover)
  ==================================================================== */
  var tipEl;
  function showTip(matchNo, x, y) {
    var ctx = getCtx();
    var res = ctx.resolved[matchNo];
    if (!res) return;
    var m = res.match, v = WC.venues[m.venue];

    // Hovern äger enbart "var spelas matchen" – tid och lag visas redan i rutan.
    var h = '<div class="tip-head"><b>' + WC.roundNames[m.round] + '</b> · Match ' + m.m + '</div>';
    h += '<div class="tip-row"><span>📍</span>' + esc(v.stadium) + ', ' + esc(v.city) + ' (' + esc(v.country) + ')</div>';
    h += '<div class="tip-row tip-dim"><span>🏟️</span>' + esc(v.real) + '</div>';

    tipEl.innerHTML = h;
    tipEl.classList.add("show");
    positionTip(x, y);
  }
  function positionTip(x, y) {
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var left = x + 16, top = y + 16;
    if (left + w > window.innerWidth - 10) left = x - w - 16;
    if (top + h > window.innerHeight - 10) top = y - h - 16;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    tipEl.style.left = left + "px";
    tipEl.style.top = top + "px";
  }
  function hideTip() { tipEl.classList.remove("show"); }

  /* ====================================================================
     EVENT-HANTERING
  ==================================================================== */

  function onInput(e) {
    if (e.target.id === "teamSearch") renderSearchResults(e.target.value);
  }

  function onClick(e) {
    var t = e.target;
    var nav = t.closest && t.closest("[data-nav]");
    if (nav) {
      var v = nav.getAttribute("data-nav");
      if (v === "calendar") calScrollPending = true;
      if (v !== "calendar") hideCalGroupPopup();
      setUi("view", v);
      hoverMatch = null;
      render();
      return;
    }
    var sr = t.closest && t.closest(".sr-item");
    if (sr) {
      if (sr.hasAttribute("data-player-id")) openSearchPlayer(sr.getAttribute("data-player-id"));
      else if (sr.hasAttribute("data-team-open")) openTeamByIso(sr.getAttribute("data-team-open"));
      else openTeam(sr.getAttribute("data-team-group"), parseInt(sr.getAttribute("data-team-idx"), 10));
      return;
    }

    var brCol = t.closest && t.closest("[data-bracket-col]");
    if (brCol) {
      centerBracketColumn(brCol.getAttribute("data-bracket-col"), brCol);
      return;
    }

    if (t.id === "drawerClose" || t.id === "drawerBackdrop") { closeTeam(); return; }
    if (t.id === "calGroupClose" || t.id === "calGroupBackdrop") { hideCalGroupPopup(); return; }
    if (t.id === "asideClose") { hoverMatch = null; hideAside(); syncExpandButtons(); return; }

    var calJump = t.closest && t.closest("[data-cal-jump]");
    if (calJump) {
      scrollCalendarToDate(calJump.getAttribute("data-cal-jump"), true);
      return;
    }

    var calGrp = t.closest && t.closest("[data-cal-group]");
    if (calGrp) {
      var gL = calGrp.getAttribute("data-cal-group");
      if (calGroupOpen === gL) hideCalGroupPopup();
      else openCalGroupPopup(gL);
      return;
    }

    var exp = t.closest && t.closest("[data-expand-match]");
    if (exp) {
      var mno = parseInt(exp.getAttribute("data-expand-match"), 10);
      hoverMatch = hoverMatch === mno ? null : mno;
      if (hoverMatch) updateAside(hoverMatch, getCtx());
      else hideAside();
      syncExpandButtons();
      return;
    }

    var tg = t.closest && t.closest("[data-toggle-group]");
    if (tg) { var L = tg.getAttribute("data-toggle-group"); expandedGroups[L] = !expandedGroups[L]; render(); return; }

    // klick på lag → öppna statistikflik (alla vyer)
    var teamEl = t.closest && t.closest("[data-team-open]");
    if (teamEl) {
      openTeamByIso(teamEl.getAttribute("data-team-open"));
      return;
    }

    // klick på matchrad (pågående/spelad) → öppna matchinfo
    var matchEl = t.closest && t.closest("[data-match-open]");
    if (matchEl) {
      if (window.VMMatchInfo && typeof window.VMMatchInfo.open === "function") {
        window.VMMatchInfo.open(matchEl.getAttribute("data-match-open"));
      }
      return;
    }
    var trow = t.closest && t.closest("tr[data-team]");
    if (trow) {
      openTeamByIso(trow.getAttribute("data-team"));
      return;
    }
  }

  // Hovring i sannolikhetslistan → byt detaljpanelens innehåll direkt.
  function onProbHover(e) {
    var row = e.target.closest && e.target.closest(".prob-row[data-detail]");
    if (!row) return;
    var body = document.getElementById("probDetailBody");
    if (!body) return;
    var html = asideDetails[row.getAttribute("data-detail")];
    if (html == null) return;
    if (body.getAttribute("data-key") === row.getAttribute("data-detail")) return;
    body.innerHTML = html;
    body.setAttribute("data-key", row.getAttribute("data-detail"));
    document.querySelectorAll("#bracketAside .prob-row.active").forEach(function (r) {
      r.classList.remove("active");
    });
    row.classList.add("active");
  }

  function onOver(e) {
    var mc = e.target.closest && e.target.closest("[data-m]");
    if (mc) {
      var no = parseInt(mc.getAttribute("data-m"), 10);
      showTip(no, e.clientX, e.clientY);
    }
  }
  function onMove(e) {
    if (tipEl.classList.contains("show")) positionTip(e.clientX, e.clientY);
  }
  function onOut(e) {
    var mc = e.target.closest && e.target.closest("[data-m]");
    if (mc && (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest("[data-m]"))) {
      hideTip();
    }
  }

  function onDocClick(e) {
    if (!e.target.closest || !e.target.closest(".search")) {
      var box = document.getElementById("searchResults");
      if (box) { box.hidden = true; }
    }
    if (hoverMatch && ui("view", "groups") === "bracket") {
      var inside = e.target.closest && (e.target.closest("#bracketAside") || e.target.closest("[data-expand-match]"));
      if (!inside) {
        hoverMatch = null;
        hideAside();
        syncExpandButtons();
      }
    }
  }

  /* ---------- Init ---------- */
  function init() {
    viewEl = document.getElementById("view");

    /* Startsida: öppna alltid på Hem vid sidladdning. Vyn minns inte mellan
       omladdningar – flikklick navigerar bara under det pågående besöket. */
    state.ui.view = "home";

    // dynamiska element
    tipEl = document.createElement("div"); tipEl.id = "tooltip"; tipEl.className = "tooltip";
    document.body.appendChild(tipEl);

    var backdrop = document.createElement("div"); backdrop.id = "drawerBackdrop"; backdrop.className = "drawer-backdrop";
    document.body.appendChild(backdrop);
    var drawer = document.createElement("aside"); drawer.id = "teamDrawer"; drawer.className = "team-drawer";
    document.body.appendChild(drawer);

    var calGroupBackdrop = document.createElement("div");
    calGroupBackdrop.id = "calGroupBackdrop";
    calGroupBackdrop.className = "cal-group-backdrop";
    document.body.appendChild(calGroupBackdrop);
    var calGroupPopup = document.createElement("div");
    calGroupPopup.id = "calGroupPopup";
    calGroupPopup.className = "cal-group-popup";
    document.body.appendChild(calGroupPopup);

    var aside = document.createElement("aside"); aside.id = "bracketAside"; aside.className = "bracket-aside";
    document.body.appendChild(aside);
    // Direkt (utan webbläsarens title-fördröjning) uppdatera detaljpanelen vid hovring.
    aside.addEventListener("mouseover", onProbHover);
    document.body.addEventListener("input", onInput);
    document.body.addEventListener("click", onClick);
    document.addEventListener("click", onDocClick);
    viewEl.addEventListener("mouseover", onOver);
    viewEl.addEventListener("mousemove", onMove);
    viewEl.addEventListener("mouseout", onOut);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeTeam(); hideTip();
        hideCalGroupPopup();
        if (hoverMatch) { hoverMatch = null; hideAside(); syncExpandButtons(); }
      }
      // Aktivera klickbar länk (role=link, t.ex. varumärket) med Enter/Space.
      if ((e.key === "Enter" || e.key === " ") && document.activeElement) {
        var nav = document.activeElement.closest && document.activeElement.closest('[data-nav][role="link"]');
        if (nav) {
          e.preventDefault();
          setUi("view", nav.getAttribute("data-nav"));
          hoverMatch = null;
          render();
        }
      }
    });

    // Realtid: synk mellan flikar + nedräkningar
    window.addEventListener("storage", function (e) {
      if (e.key === STORE_KEY) { state = loadState(); refresh(); }
    });
    setInterval(refresh, 30000); // uppdatera "om X / Pågår" m.m.
    countdownTimer = setInterval(function () {
      var view = ui("view", "home");
      if (view === "home") updateNextCountdown();
    }, 1000);

    var bracketLineTimer;
    window.addEventListener("resize", function () {
      if (ui("view", "groups") !== "bracket") return;
      clearTimeout(bracketLineTimer);
      bracketLineTimer = setTimeout(drawBracketConnectors, 120);
    });

    var heroStickyTimer;
    window.addEventListener("resize", function () {
      clearTimeout(heroStickyTimer);
      heroStickyTimer = setTimeout(updateHeroSticky, 80);
    });
    window.addEventListener("load", updateHeroSticky);
    window.addEventListener("scroll", syncHeaderCompact, { passive: true });

    window.addEventListener("wheel", function (e) {
      if (ui("view", "groups") !== "bracket") return;
      var sc = viewEl.querySelector(".bracket-scroll");
      if (e.deltaY > 2) setBracketHeroCollapsed(true);
      else if (e.deltaY < -2 && (!sc || sc.scrollTop <= 0)) setBracketHeroCollapsed(false);
    }, { passive: true });

    if (ui("view", "groups") === "calendar") calScrollPending = true;
    render();
    updateSyncBadge();

    bracketPosByMatch = buildBracketPosMap();
    loadBracketProbs();
    setInterval(loadBracketProbs, 300000);   // uppdateras under turneringen
  }

  window.VMApp = {
    mergeRemoteResults: mergeRemoteResults,
    setSyncStatus: setSyncStatus,
    autoSync: autoSync,
    describeMatch: describeMatch,
    setMatchDetails: setMatchDetails,
    groupTableHtml: groupTableHtml
  };

  document.addEventListener("DOMContentLoaded", init);
})();
