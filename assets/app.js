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
  var hoverLineage = null;      // matchnummer vars härstamning (in/ut) är highlightad
  // R32-motståndarsimulator (inbäddad i slutspelsvyn)
  var legacyR32Open = false;    // gamla motståndarsimulatorn (motstandare.html)
  var calcOpen = false;         // Tomas förenklade slutspelskalkylator (nav r32)
  var r32TeamKey = "F:3";       // analyserat lag, "grupp:idx" (default Sverige)
  var r32Fixed = {};            // oddsMatchId -> ["result",r] | ["score",h,a]
  var r32OpenGrids = {};        // oddsMatchId -> true (utfällt resultatrutnät)
  var r32OddsData = null;       // normaliserad odds.json | "loading" | "error"
  var marketOddsStamp = null;   // data.updated – för att upptäcka nya scrapes
  var winnerOddsStamp = null;   // winner_odds.json updated
  var r32Result = null;         // senaste simuleringsresultat
  var r32Key = null;            // cache-nyckel för r32Result
  var r32Worker = null;         // Web Worker (eller "none" vid fallback)
  var r32Seq = 0;               // sekvensnummer för att ignorera gamla svar
  var r32Busy = false;          // pågående simulering
  var r32TipMap = {};           // id -> tooltip-HTML
  var R32_N = 12000;            // antal simuleringar per körning
  // Slutspelskalkylatorn: kör hela trädet (assets/bracketengine.js) med ett valt
  // fokuslag och visar dess troliga motståndare i varje runda.
  var calcWorker = null;        // Web Worker (eller "none" vid fallback)
  var calcSeq = 0;              // sekvensnummer för att ignorera gamla svar
  var calcResult = null;        // senaste focal-resultat
  var calcKey = null;           // cache-nyckel för calcResult
  var CALC_N = 20000;           // simuleringar per körning (snabb men stabil)
  // Hela slutspelsträdet beräknas lokalt (assets/bracketengine.js) på samma data
  // som sextondelskollen, i stället för den servergenererade bracket_probs.json.
  var bracketWorker = null;     // Web Worker för hela trädet (eller "none")
  var bracketSeq = 0;           // sekvensnummer för att ignorera gamla svar
  var bracketEngKey = null;     // cache-nyckel för senaste lokala beräkning
  var bracketMapData = null;    // data/bracket_map.json | "loading" | "error"
  var bracketStrength = null;   // styrka per lag ur data/winner_odds.json
  var BRACKET_N = 40000;        // simuleringar för hela trädet
  var autoSync = { active: false, source: null, updatedAt: null, status: "pending" };
  var apiFixtures = {}; // nyckel -> { date, time, home, away, homeRef, awayRef, status } från API
  var apiStandings = {}; // grupp-bokstav -> [{ idx, position, pld, w, d, l, gf, ga, gd, pts }] från API
  var apiLive = {};      // nyckel -> { status, minute, score } för pågående matcher från API
  var focusDetails = {}; // nyckel -> matchdetaljer (mål m.m.) för startsidans hjälte
  var fairPlayMap = {};  // "L:idx" -> { y, r, pts } beräknat från matchdetaljernas kort
  var calScrollPending = false; // scrolla till nästa matchdag vid öppning av kalender
  var calGroupOpen = null;      // grupp-bokstav för öppen tabell-popup i kalendern
  var calHighlights = {};       // matchnyckel -> { SVT?:{full,long,short}, TV4?:{...} } (repriser i kalendern)

  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        var ui = p.ui || {};
        // Migrering: gamla på/av-switchen "spoilerFree" → nya "spoilerOn".
        if (ui.spoilerOn === undefined && ui.spoilerFree !== undefined) ui.spoilerOn = !!ui.spoilerFree;
        return { results: p.results || {}, ui: ui };
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
    var label = expanded ? "Dölj odds & väg hit" : "Visa odds & väg hit";
    return '<button type="button" class="match-expand' + (expanded ? " on" : "") + '" data-expand-match="' + matchNo + '" ' +
      'title="' + label + '" aria-label="' + label + '" aria-expanded="' + (expanded ? "true" : "false") + '">' +
      '<span class="match-expand-txt">Odds</span>' +
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
  /* Versaler i JS med svensk locale (säkrare än CSS text-transform).
     OBS: Big Shoulders HAR å/ä/ö – men diakriterna sitter högt; ge rubrik-
     elementen vertikal padding så de inte klipps av overflow:hidden (se CSS). */
  function teamSvDisplay(team) {
    return teamSvFixture(team).toLocaleUpperCase("sv-SE");
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

  /* Kompakt datum för slutspelsträdet: numerisk månad ("mån 29/6") så datum+tid
     ryms på en rad i de smala korten. */
  function bracketDateShort(m) {
    var d = parseDateUTC(m.date);
    return WEEKDAYS[d.getUTCDay()] + " " + d.getUTCDate() + "/" + (d.getUTCMonth() + 1);
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
  /* getRes är spoilerfilter-grindad: i spoilerfritt läge döljs resultat för
     matcher som spelats det senaste dygnet, så att tabeller, slutspel, kalender,
     statistik och startsida behandlar dem som "ännu inte spelade". rawRes ger
     det verkliga resultatet (används bara där spoilern medvetet ska kringgås,
     t.ex. "visa ändå" i matchmodalen). */
  function rawRes(key) { return state.results[key] || null; }
  function getRes(key) {
    if (isSpoilerHidden(key)) return null;
    return state.results[key] || null;
  }
  function isPlayed(r) { return r && r.h !== undefined && r.a !== undefined; }

  function isLiveStatus(status) {
    return status === "IN_PLAY" || status === "PAUSED" || status === "LIVE";
  }

  function isMatchLive(key) {
    // Spoilerfritt läge: en match från det senaste dygnet räknas inte som
    // pågående (annars skulle "LIVE"-märket avslöja att den spelas just nu).
    if (isSpoilerHidden(key)) return false;
    // Backendens live-lista är den färskaste signalen – ta den först så att en
    // match räknas som pågående även i glappet innan status/resultat hunnit
    // skrivas in i results/fixtures.
    if (apiLive[key]) return true;
    var fx = getApiFixture(key);
    if (fx && isLiveStatus(fx.status)) return true;
    var rs = rawRes(key);
    return rs && isLiveStatus(rs.status);
  }

  // Färdigspelad match = har ett resultat OCH spelas inte just nu. En pågående
  // (live) match ska INTE låsas i 16delskollen utan fortsätta simuleras ur sina
  // odds tills den är slutspelad – annars skulle delresultatet (t.ex. en
  // ledning i halvtid) felaktigt frysas som slutresultat i tabellen.
  function isFinishedMatch(key, r) {
    if (!isPlayed(r)) return false;
    if (isMatchLive(key)) return false;
    return !isLiveStatus(r.status);
  }

  /* ---------- Spoilerfritt läge ----------
     Döljer resultat (och tabell-/statistikpåverkan) för spelade matcher tills de
     "låses upp" vid en daglig återställning. Tanken: matcher spelas under
     amerikanska kvällen/natten (svensk kväll/natt), och man vill kunna gå in i
     kalendern dagen efter och se highlights/hela matchen utan att veta hur det
     gick. Återställningen sker kl. 18:00 svensk tid (just före kvällens första
     match ~19:00), och en match förblir dold tills den ANDRA 18:00-gränsen efter
     avspark passerats. Det innebär att gårdagens/nattens matcher hålls dolda hela
     dagen och kvällen, och avslöjas först kl. 18:00 dygnet därpå. */
  var SPOILER_RESET_UTC_HOUR = 16; // 18:00 svensk sommartid (CEST = UTC+2)
  /* Spoilerskyddet har tre lägen (sätts från headerpanelen):
       off    – spoilerOn=false: inget döljs.
       auto   – spoilerOn=true, spoilerCutoff=null: rullande dygnsskydd (standard,
                oförändrat beteende – döljer matcher från det senaste dygnet).
       custom – spoilerOn=true, spoilerCutoff=<ms>: egen brytpunkt – döljer alla
                matcher vars avspark ligger EFTER den valda matchen/dagen. */
  function spoilerFreeOn() { return !!ui("spoilerOn", false); }
  function spoilerCutoffMs() {
    var v = ui("spoilerCutoff", null);
    return typeof v === "number" ? v : null;
  }

  /* Tidpunkt (ms, UTC) då en match med given avspark avslöjas: den andra
     18:00-gränsen (svensk tid) strikt efter avspark. */
  function spoilerUnlockMs(ko) {
    var d = new Date(ko);
    var boundary = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SPOILER_RESET_UTC_HOUR, 0, 0);
    var DAY = 24 * 3600 * 1000;
    if (boundary <= ko) boundary += DAY; // första 18:00-gränsen strikt efter avspark
    return boundary + DAY;                // andra gränsen (ett dygn till)
  }

  /* Avsparkstid (ms, UTC) för en resultatnyckel utan att läsa resultat
     (undviker rekursion med getRes). */
  function kickoffMsForKey(key) {
    var g = /^g:([A-L]):(\d+)$/.exec(key);
    if (g) {
      var L = g[1], idx = parseInt(g[2], 10);
      var sched = getApiFixture(key) || (WC.groupSchedule && WC.groupSchedule[key]);
      var date = sched ? sched.date : (WC.groupDates[L] && WC.groupDates[L][Math.floor(idx / 2)]);
      var edt = sched ? (sched.time || sched.edt) : null;
      if (!date) return null;
      return kickoffUTC({ date: date, edt: edt }).getTime();
    }
    var k = /^k:(\d+)$/.exec(key);
    if (k) {
      var fx = getApiFixture(key);
      var mt = MATCH_BY_NO[parseInt(k[1], 10)];
      var date2 = (fx && fx.date) || (mt && mt.date);
      var edt2 = (fx && fx.time) || (mt && mt.edt);
      if (!date2) return null;
      return kickoffUTC({ date: date2, edt: edt2 }).getTime();
    }
    return null;
  }

  /* Ska en match med given avspark (ms, UTC) döljas just nu? Gemensam grind för
     både auto- och custom-läget. Framtida matcher döljs aldrig (de har inget
     resultat att spoila och deras nedräkning/"Nästa match" ska fungera). */
  function spoilerHidesKo(ko) {
    if (!spoilerFreeOn()) return false;
    if (ko == null) return false;
    if (ko > Date.now()) return false;          // inte avspakad än
    var cutoff = spoilerCutoffMs();
    if (cutoff != null) return ko > cutoff;     // custom: dölj allt efter brytpunkten
    return Date.now() < spoilerUnlockMs(ko);    // auto: senaste dygnet (oförändrat)
  }

  function isSpoilerHidden(key) {
    if (!spoilerFreeOn()) return false;
    return spoilerHidesKo(kickoffMsForKey(key));
  }

  /* Matchdetaljer filtrerade efter spoilerläget – döljer mål/kort/byten för
     matcher från det senaste dygnet så spelar-, lag- och regionstatistiken
     (assets/playerstats.js) inte heller avslöjar dem. */
  function visibleDetails(src) {
    src = src || focusDetails;
    if (!spoilerFreeOn()) return src;
    var out = {};
    Object.keys(src || {}).forEach(function (key) {
      if (!isSpoilerHidden(key)) out[key] = src[key];
    });
    return out;
  }
  function pushVisibleDetailsToStats() {
    if (window.VMPlayerStats && typeof window.VMPlayerStats.setDetails === "function") {
      try { window.VMPlayerStats.setDetails(visibleDetails(focusDetails)); } catch (e) {}
    }
  }
  function recomputeFairPlay() {
    fairPlayMap = computeFairPlay(focusDetails);
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
        channel: tvLookupGroup(fx, th, ta),
        venue: (fx.venue && WC.venues[fx.venue]) || null
      };
    } else {
      var k = /^k:(\d+)$/.exec(key);
      if (!k) return null;
      var no = parseInt(k[1], 10);
      var ctx = getCtx();
      var res = ctx.resolved[no];
      if (!res) return null;
      info = {
        key: key, label: koRoundLabel(res.match), kind: "ko",
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
    // Spoilerfritt läge: matchen spelades det senaste dygnet men resultatet är
    // dolt. Matchmodalen kan då visa highlights och en "visa ändå"-knapp utan
    // att avslöja resultatet i förväg. raw* speglar det verkliga utfallet.
    info.spoiler = isSpoilerHidden(key);
    if (info.spoiler) {
      var raw = rawRes(key);
      info.rawR = raw;
      info.rawPlayed = isPlayed(raw);
      info.rawLive = !!apiLive[key] || isLiveStatus(raw && raw.status);
    }
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
      // Spoilerfritt läge: räkna inte in kort (fair play) från dolda matcher.
      if (isSpoilerHidden(key)) return;
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
      try { window.VMPlayerStats.setDetails(visibleDetails(focusDetails)); } catch (e) {}
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
    var cls, text, title;
    if (autoSync.status === "ok" && autoSync.updatedAt) {
      cls = "ok";
      text = "Auto · ESPN";
      title = "Senast uppdaterad: " + new Date(autoSync.updatedAt).toLocaleString("sv-SE");
    } else if (autoSync.status === "error") {
      cls = "error";
      text = "Ingen backend";
      title = "Kunde inte hämta resultat. Kontrollera att servern körs och att VM_CONFIG.backend pekar rätt.";
    } else {
      cls = "pending";
      text = "Hämtar…";
      title = "Resultat hämtas automatiskt från ESPN";
    }
    // Rör bara DOM:en när något faktiskt ändrats – annars blinkar badgen
    // till vid varje bakgrundspoll (remove/add av klassen nollar gradienten).
    if (el.hidden) el.hidden = false;
    if (!el.classList.contains(cls)) {
      el.classList.remove("pending", "ok", "error");
      el.classList.add(cls);
    }
    if (el.textContent !== text) el.textContent = text;
    if (el.title !== title) el.title = title;
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

  /* API-fixturer placerar ut det lag som avancerat ut ur en tidigare
     slutspelsmatch (homeRef/awayRef pekar direkt på laget). Om DEN matchen är
     spoilergömd får vi inte avslöja laget – vinnaren/förloraren spoilar ju
     resultatet. Då faller vi tillbaka på platshållaren ("Vinnare 1/16-final X")
     precis som resolveSlot gör för en ännu oavgjord match. */
  function apiSideSpoiled(slot) {
    return (slot.t === "wm" || slot.t === "lm") && isSpoilerHidden("k:" + slot.m);
  }

  function groupFixtures(letter) {
    var out = [], idx = 0;
    for (var md = 0; md < RR.length; md++) {
      for (var j = 0; j < RR[md].length; j++) {
        var key = "g:" + letter + ":" + idx;
        var api = getApiFixture(key);
        var staticSched = WC.groupSchedule && WC.groupSchedule[key];
        var sched = api || staticSched;
        out.push({
          key: key, md: md + 1,
          h: RR[md][j][0], a: RR[md][j][1],
          date: sched ? sched.date : WC.groupDates[letter][md],
          edt: sched ? (sched.time || sched.edt) : null,
          // Arenan ligger i det statiska schemat (API-fixturer saknar den).
          venue: staticSched ? staticSched.venue : null,
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
      var pre = (slot.t === "wm" ? "Vinnare " : "Förlorare ") + koRefLabel(slot.m);
      if (src && src[want]) return { team: src[want].team, decided: src[want].decided, label: pre };
      return { team: null, decided: false, label: pre };
    }
    return { team: null, decided: false, label: "?" };
  }

  function resolveKnockout(ctx) {
    WC.knockout.forEach(function (mt) {
      if (mt.home.t === "3") mt.home._m = mt.m;
      if (mt.away.t === "3") mt.away._m = mt.m;
      var fx = getApiFixture("k:" + mt.m);
      var home = (!apiSideSpoiled(mt.home) && apiKnockoutSide(fx, "home")) || resolveSlot(mt.home, ctx);
      var away = (!apiSideSpoiled(mt.away) && apiKnockoutSide(fx, "away")) || resolveSlot(mt.away, ctx);
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
    groups: { title: "Gruppspel", sub: "" },
    bracket: { title: "Slutspel", sub: "" },
    calendar: { title: "Kalender", sub: "" },
    players: { title: "Statistik", sub: "" }
  };

  /* Vytitel (Gruppspel/Slutspel/Kalender) visas i innehållsytan,
     inte i bannern – bannern är identisk i alla vyer. */
  /* Vytitelns inre HTML (rubrik + underrubrik) – delas av sidintrot och av
     slutspelets toppra (där lägesväxlaren ligger på samma rad). */
  function pageIntroMainHtml(view) {
    var t = HERO_TEXTS[view] || HERO_TEXTS.groups;
    return '<div class="page-intro-main">' +
      "<h2>" + t.title + "</h2>" +
      (t.sub ? "<p>" + t.sub + "</p>" : "") +
      "</div>";
  }

  function renderPageIntro(view) {
    if (!viewEl) return;
    /* Slutspelsvyn bygger sin egen toppra (rubrik + lägesväxlare) i
       renderBracket; övriga vyer får sitt intro infogat här. */
    viewEl.insertAdjacentHTML("afterbegin",
      '<div class="page-intro">' + pageIntroMainHtml(view) + "</div>");
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
    /* Mät den faktiska höjdskillnaden mot ihopfällt läge (varumärkesrad + sök
       försvinner). Klassen togglas synkront utan mellanliggande paint, så vi får
       exakt delta utan flimmer – oavsett vad CSS:en döljer. */
    var fullH = header.offsetHeight;
    header.classList.add("hero-collapsed");
    var collapsedH = header.offsetHeight;
    header.classList.remove("hero-collapsed");
    headerShrinkDelta = Math.max(0, fullH - collapsedH);
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

    var mobileCompact = window.innerWidth <= 780;
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
    var header = document.querySelector(".hero-header");
    if (!header) return;
    var y = window.scrollY;
    /* Frostad panel så snart sidan rullats en aning – håller headertexten läsbar
       mot innehållet bakom. Liten tröskel + hysteres så det inte flimrar vid 0. */
    if (header.classList.contains("is-scrolled")) {
      if (y <= 2) header.classList.remove("is-scrolled");
    } else if (y > 8) {
      header.classList.add("is-scrolled");
    }
    if (header.classList.contains("hero-collapsed")) {
      if (y <= headerExpandAt) setBracketHeroCollapsed(false);
    } else if (y > headerCollapseAt) {
      setBracketHeroCollapsed(true);
    }
  }

  /* Skriv bara om #view när innehållet faktiskt ändrats. En oförändrad
     omritning river annars hela DOM:en (inkl. flaggbilder) och ger ett
     synligt flimmer – t.ex. vid 30-sekunderstimern som mest uppdaterar
     "om X / Pågår" utan att något egentligen förändrats. Returnerar true
     när #view byggdes om (så att om-introt kan läggas tillbaka). Vyer som
     äger #view själva (slutspel/statistik) nollställer cachen. */
  /* Nedräkningssiffrorna (dygn/tim/min/sek) bakas in i hjälte-HTML:en men
     uppdateras separat varje sekund av updateNextCountdown(). Maska bort dem
     ur jämförelsen – annars ser 30-sekunderstimern en "ändring" varje gång
     sekunden tickat och river hela #view (flaggbilderna laddas om = flimmer). */
  function viewSignature(html) {
    return html.replace(/(<span class="nm-val"[^>]*>)[^<]*(<\/span>)/g, "$1$2");
  }
  var lastViewSig = null;
  function setViewHtml(html) {
    var sig = viewSignature(html);
    if (sig === lastViewSig) return false;
    lastViewSig = sig;
    morphView(viewEl, html);
    return true;
  }

  /* Patcha #view PÅ PLATS mot ny HTML i stället för att slänga och bygga om
     hela DOM:en (viewEl.innerHTML = html). Oförändrade noder – särskilt
     flaggbilder – lämnas orörda, så 30-sekunderstimerns kosmetiska
     uppdateringar ("om X / Pågår" m.m.) inte längre ger ett synligt flimmer
     eller tappad scroll. Appen använder delegerade event-lyssnare (på
     document), så inga lyssnare tappas vid patchning. Positionsbaserad morf
     räcker eftersom layouten är stabil mellan uppdateringar. */
  function morphView(container, html) {
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    morphChildren(container, tmp);
  }
  function sameMorphNode(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType === 1) return a.tagName === b.tagName && a.id === b.id;
    return true;
  }
  function morphChildren(oldParent, newParent) {
    var newKids = Array.prototype.slice.call(newParent.childNodes);
    var oldKid = oldParent.firstChild;
    for (var i = 0; i < newKids.length; i++) {
      var nk = newKids[i];
      if (!oldKid) { oldParent.appendChild(nk); continue; }
      var next = oldKid.nextSibling;
      if (sameMorphNode(oldKid, nk)) patchMorphNode(oldKid, nk);
      else oldParent.replaceChild(nk, oldKid);
      oldKid = next;
    }
    while (oldKid) { var n2 = oldKid.nextSibling; oldParent.removeChild(oldKid); oldKid = n2; }
  }
  function patchMorphNode(oldNode, newNode) {
    if (oldNode.nodeType === 3 || oldNode.nodeType === 8) { // text / kommentar
      if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
      return;
    }
    if (oldNode.nodeType !== 1) return;
    var oldA = oldNode.attributes;
    for (var i = oldA.length - 1; i >= 0; i--) {
      if (!newNode.hasAttribute(oldA[i].name)) oldNode.removeAttribute(oldA[i].name);
    }
    var newA = newNode.attributes;
    for (var j = 0; j < newA.length; j++) {
      if (oldNode.getAttribute(newA[j].name) !== newA[j].value) oldNode.setAttribute(newA[j].name, newA[j].value);
    }
    morphChildren(oldNode, newNode);
  }

  function standaloneView() {
    var CFG = window.VM_CONFIG || {};
    return CFG.standaloneView || null;
  }

  /* ---------- Besöksmätning (skickas till backend, ingen tredjepart) ---------- */
  var lastTrackedView = null;
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
  function trackView(view) {
    if (!view || view === lastTrackedView) return; // räkna bara faktiska vy-byten
    lastTrackedView = view;
    try {
      var cfg = window.VM_CONFIG || {};
      var base = cfg.backend ? cfg.backend.replace(/\/$/, "") : "";
      var url = base + "/api/track";
      var body = JSON.stringify({ view: view, visitor: getVisitorId(), ref: document.referrer || "" });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, body); // text/plain → ingen CORS-preflight
      } else {
        fetch(url, { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(function () {});
      }
    } catch (e) {
      /* mätning får aldrig störa sidan */
    }
  }

  function render() {
    var view = standaloneView() || ui("view", "home");
    trackView(view);
    document.documentElement.classList.toggle("view-bracket", view === "bracket");
    document.documentElement.classList.toggle("view-home", view === "home");
    document.documentElement.classList.toggle("view-r32", view === "r32");
    document.documentElement.classList.toggle("view-legacy-r32", view === "legacy-r32");
    legacyR32Open = view === "legacy-r32";
    calcOpen = view === "r32";
    document.querySelectorAll("[data-nav]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-nav") === view);
    });
    var rebuilt;
    if (view === "home") rebuilt = renderHome();
    else if (view === "groups") rebuilt = renderGroups();
    else if (view === "bracket") {
      rebuilt = renderBracket();
    }
    else if (view === "legacy-r32") rebuilt = renderR32View();
    else if (view === "r32") rebuilt = renderCalcView();
    else if (view === "players") rebuilt = renderPlayers();
    else rebuilt = renderCalendar();
    /* Slutspelsvyn lägger själv in sin rubrik (renderBracket → renderPageIntro)
       så att rubrik + lägesväxlare hamnar i scroll-ytans topp och scrollen kan
       bevaras vid omritning – undvik därför dubbelinsättning här.
       Statistikvyn bygger själv sin toppra (rubrik + lägesväxlare på samma rad)
       i playerstats.js, och kalendern bygger sin egen toppra (rubrik +
       "Hoppa till idag" på samma rad) i renderCalendar, så de hoppas också
       över här. */
    if (view !== "home" && view !== "bracket" && view !== "r32" && view !== "legacy-r32" &&
        view !== "players" && view !== "calendar" && rebuilt) renderPageIntro(view);

    /* Grupp-popupen används i både kalender- och gruppvyn. */
    if (view !== "calendar" && view !== "groups") hideCalGroupPopup();
    if (view !== "bracket") {
      hoverMatch = null;
      hoverLineage = null;
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
    if (a && a.classList && (a.classList.contains("score") || a.classList.contains("calc-score"))) return;
    if (a && a.id === "psSearch") return; // stör inte pågående sökning i spelarvyn
    if (a && a.id === "teamSearch") { render(); restoreSearchFocus(); return; }
    // Räkna om slutspelssannolikheterna lokalt (dedupar på ställningar/odds/
    // live-läge, så det är gratis när inget ändrats – men fångar nya mål).
    if (anyLiveOddsPoll()) reloadMarketOdds();
    updateBracketProbs();
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
        '<p>VM 2026 i realtid och en värdig begravning för de svenska och uruguayanska VM-drömmarna.</p>' +
      '</div>' +
      focusHero(ctx) +
      recentMatchesPanel(ctx) +
      teamsSpotlightStrip(ctx) +
      '</div>';
    var wrote = setViewHtml(html);
    if (wrote) updateNextCountdown();
    return wrote;
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
    var wrote = setViewHtml(html);
    if (wrote && calGroupOpen) renderCalGroupPopup(); // håll grupp-popupen aktuell
    return wrote;
  }

  /* ---------- Spelarstatistik-vy (assets/playerstats.js) ---------- */
  function renderPlayers() {
    lastViewSig = null; // statistikvyn äger #view själv – ogiltigförklara cachen
    if (window.VMPlayerStats && typeof window.VMPlayerStats.mount === "function") {
      window.VMPlayerStats.mount(viewEl);
    } else {
      viewEl.innerHTML = '<p class="note">Statistiken kunde inte laddas.</p>';
    }
    return true;
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
    h += '</tbody></table><p class="note">8 bästa treorna går vidare. Tiebreak: poäng → målskillnad → mål → fair play (FP) → FIFA-ranking.</p></section>';
    return h;
  }

  /* ---------- Slutspelsvy (tvåsidigt träd, final i mitten) ---------- */
  var BR = {
    leftR32: [74,77,73,75,83,84,81,82], leftR16: [89,90,93,94], leftQF: [97,98], leftSF: [101],
    rightSF: [102], rightQF: [99,100], rightR16: [91,92,95,96], rightR32: [76,78,79,80,86,88,85,87]
  };

  var BR_HALF = {
    left: [
      { title: "1/16-final", nums: BR.leftR32, round: 0 },
      { title: "Åttondelsfinal",  nums: BR.leftR16, round: 1 },
      { title: "Kvartsfinal",     nums: BR.leftQF,  round: 2 },
      { title: "Semifinal",       nums: BR.leftSF,  round: 3 }
    ],
    right: [
      { title: "Semifinal",       nums: BR.rightSF,  round: 3 },
      { title: "Kvartsfinal",     nums: BR.rightQF,  round: 2 },
      { title: "Åttondelsfinal",  nums: BR.rightR16, round: 1 },
      { title: "1/16-final", nums: BR.rightR32, round: 0 }
    ]
  };

  /* Kronologisk etikett per match, t.ex. "1/16-final 3" – matcherna i en
     runda numreras 1..N i spelordning (datum + avsparkstid), inte efter det
     kryptiska matchnumret. Final/Brons är enskilda matcher och får ingen siffra. */
  var KO_CHRONO = null;
  function koChronoIndex() {
    if (KO_CHRONO) return KO_CHRONO;
    KO_CHRONO = {};
    var byRound = {};
    WC.knockout.forEach(function (mt) {
      (byRound[mt.round] = byRound[mt.round] || []).push(mt);
    });
    Object.keys(byRound).forEach(function (rk) {
      byRound[rk].slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        var ax = a.edt || "99:99", bx = b.edt || "99:99";
        return ax < bx ? -1 : ax > bx ? 1 : 0;
      }).forEach(function (mt, i) { KO_CHRONO[mt.m] = i + 1; });
    });
    return KO_CHRONO;
  }
  function koRoundLabel(m) {
    var name = WC.roundNames[m.round] || ("Match " + m.m);
    if (m.round === "FINAL" || m.round === "3RD") return name;
    return name + " " + koChronoIndex()[m.m];
  }
  /* Gemen referensform för "Vinnare …"-platshållare, t.ex. "1/16-final 3",
     så att en kommande match pekar tydligt tillbaka på rätt rutas etikett. */
  function koRefLabel(matchNo) {
    var m = MATCH_BY_NO[matchNo];
    if (!m) return "match " + matchNo;
    var name = (WC.roundNames[m.round] || "match " + matchNo).toLowerCase();
    if (m.round === "FINAL" || m.round === "3RD") return name;
    return name + " " + koChronoIndex()[matchNo];
  }

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
    return "grid-row:" + (1 + idx * span) + "/span " + span;
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

  /* Knapprad överst i slutspelsvyn: växla hela trädet mellan platsetiketter
     ("Etta grupp E") och oddsfavoriter (det mest sannolika laget). */
  function bracketModeBar() {
    var odds = bracketMode() === "odds";
    return '<div class="bracket-modebar">' +
      '<button type="button" class="bmode-toggle' + (odds ? " on" : "") + '" ' +
        'data-bracket-toggle role="switch" aria-checked="' + (odds ? "true" : "false") + '" ' +
        'title="Visa troliga lag enligt oddsfavoriter i stället för platshållare">' +
        '<span class="bmode-toggle-txt">Oddsfavoriter</span>' +
        '<span class="bmode-switch" aria-hidden="true"><span class="bmode-knob"></span></span>' +
      '</button>' +
      '</div>';
  }

  function renderBracket() {
    var ctx = getCtx();

    var html = '<div class="bracket-shell">' +
      '<div class="bracket-scroll"><div class="bracket-wrap">';
    html += '<svg class="bracket-lines" aria-hidden="true"></svg>';
    html += '<div class="bracket two-sided">';

    BR_HALF.left.forEach(function (col) {
      html += bracketRoundTitle(col.title, bracketGridCol(col.round, "left"));
    });
    html += bracketRoundTitle("Final", 5, { final: true });
    BR_HALF.right.forEach(function (col) {
      html += bracketRoundTitle(col.title, bracketGridCol(col.round, "right"));
    });

    BR_HALF.left.forEach(function (col) {
      col.nums.forEach(function (n, idx) {
        html += matchCard(ctx.resolved[n], null, {
          side: "left",
          grid: "grid-column:" + bracketGridCol(col.round, "left") + ";" + bracketGridRow(col.round, idx)
        });
      });
    });

    html += '<div class="bracket-modebar-slot" style="grid-column:4 / 7;grid-row:1 / 3">' +
      bracketModeBar() + '</div>';
    html += '<div class="bracket-center-stack" style="grid-column:5;grid-row:1/span 8">' +
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

    html += '<div class="bracket-foot" style="grid-column:3 / 8;grid-row:8">' +
      '<span class="bracket-foot-cap">' +
      'Data: FIFA &amp; Wikipedia · Resultat &amp; statistik: ' +
      '<a href="https://www.espn.com/soccer/" target="_blank" rel="noopener">ESPN</a>' +
      ' · Tider kan ändras – <a href="https://www.fifa.com/" target="_blank" rel="noopener">FIFA.com</a>' +
      '</span></div>';
    html += '</div></div></div></div>';

    var sc = viewEl.querySelector(".bracket-scroll");
    var preserveScroll = !!sc;
    var prevScrollLeft = sc ? sc.scrollLeft : 0;
    var prevScrollTop = sc ? sc.scrollTop : 0;

    lastViewSig = null; // slutspelsvyn äger #view själv (scroll/anslutningslinjer)
    viewEl.innerHTML = html;

    var newSc = viewEl.querySelector(".bracket-scroll");
    function restoreBracketScroll() {
      if (!newSc || !preserveScroll) return;
      newSc.scrollLeft = Math.max(0, Math.min(prevScrollLeft, newSc.scrollWidth - newSc.clientWidth));
      newSc.scrollTop = Math.max(0, Math.min(prevScrollTop, newSc.scrollHeight - newSc.clientHeight));
    }

    if (preserveScroll) {
      restoreBracketScroll();
      drawBracketConnectors(restoreBracketScroll);
    } else {
      centerBracketScroll(drawBracketConnectors);
    }

    if (hoverMatch && ctx.resolved[hoverMatch]) updateAside(hoverMatch, ctx);
    else hideAside();
    return true;
  }

  /* Fyll trädets höjd dynamiskt: de 8 sextondelsmatcherna sprids jämnt över den
     tillgängliga höjden (inget tomrum nedtill). Finns inte plats för minsta
     mellanrum så blir det vågrät/lodrät scroll i stället. Körs efter varje
     rendering och vid resize (via drawBracketConnectors). */
  function layoutBracketRows() {
    var sc = viewEl.querySelector(".bracket-scroll");
    var br = sc && sc.querySelector(".bracket.two-sided");
    if (!br) return;
    var card = br.querySelector(".match.side-left");
    var cardH = card ? Math.ceil(card.getBoundingClientRect().height) : 71;
    if (cardH < 40) cardH = 71;
    var gridTop = br.getBoundingClientRect().top;
    var BOTTOM_PAD = 16; // minimal luft nedtill
    var avail = window.innerHeight - gridTop - BOTTOM_PAD;
    var n = 8;
    var minGap = 12; // minsta mellanrum (något mer än tidigare); under detta → scroll
    var gap = (avail - n * cardH) / (n - 1);
    if (!isFinite(gap) || gap < minGap) gap = minGap;
    gap = Math.round(gap);
    br.style.gridTemplateRows = "repeat(8, " + cardH + "px)";
    br.style.rowGap = gap + "px";
  }

  function drawBracketConnectors(afterLayout) {
    requestAnimationFrame(function () {
      layoutBracketRows();
      var wrap = viewEl.querySelector(".bracket-wrap");
      var br = wrap && wrap.querySelector(".bracket");
      var svg = wrap && wrap.querySelector(".bracket-lines");
      if (!wrap || !br || !svg) return;

      var wrapRect = wrap.getBoundingClientRect();
      var paths = [];
      // Aktuell härstamnings-edge (parent + barn-matcher) som varje path-segment
      // tillhör, så att linjerna kan tändas tillsammans med rätt rutor vid hover.
      var edge = null;
      function push(d) { paths.push({ d: d, p: edge ? edge.p : null, k: edge ? edge.k : null }); }

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
          push("M" + a.right + "," + a.y + " H" + midX);
          push("M" + b.right + "," + b.y + " H" + midX);
          push("M" + midX + "," + a.y + " V" + b.y);
          push("M" + midX + "," + midY + " H" + p.left);
        } else {
          var midX = (Math.min(a.left, b.left) + p.right) / 2;
          push("M" + a.left + "," + a.y + " H" + midX);
          push("M" + b.left + "," + b.y + " H" + midX);
          push("M" + midX + "," + a.y + " V" + b.y);
          push("M" + midX + "," + midY + " H" + p.right);
        }
      }

      function linkSingle(fromEl, toEl, side) {
        var f = pos(fromEl), t = pos(toEl);
        if (side === "left") {
          var midX = (f.right + t.left) / 2;
          push("M" + f.right + "," + f.y + " H" + midX);
          push("M" + midX + "," + f.y + " V" + t.y);
          push("M" + midX + "," + t.y + " H" + t.left);
        } else {
          var midX = (f.left + t.right) / 2;
          push("M" + f.left + "," + f.y + " H" + midX);
          push("M" + midX + "," + f.y + " V" + t.y);
          push("M" + midX + "," + t.y + " H" + t.right);
        }
      }

      function linkBronze(aEl, bEl, bronzeEl) {
        var a = pos(aEl), b = pos(bEl), brz = pos(bronzeEl);
        var entryY = brz.y;

        push("M" + a.cx + "," + a.bottom + " V" + entryY);
        push("M" + a.cx + "," + entryY + " H" + brz.left);

        push("M" + b.cx + "," + b.bottom + " V" + entryY);
        push("M" + b.cx + "," + entryY + " H" + brz.right);
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
            if (elA && elB && elP) {
              edge = { p: pars[j], k: [kids[j * 2], kids[j * 2 + 1]] };
              forkPair(elA, elB, elP, side);
            }
          }
        }
      });

      var fin = br.querySelector('[data-m="104"]');
      var sfL = br.querySelector('[data-m="101"]');
      var sfR = br.querySelector('[data-m="102"]');
      var bronze = br.querySelector('[data-m="103"]');
      if (fin && sfL) { edge = { p: 104, k: [101] }; linkSingle(sfL, fin, "left"); }
      if (fin && sfR) { edge = { p: 104, k: [102] }; linkSingle(sfR, fin, "right"); }
      if (bronze && sfL && sfR) { edge = { p: 103, k: [101, 102] }; linkBronze(sfL, sfR, bronze); }
      edge = null;

      var w = wrap.offsetWidth;
      var h = wrap.offsetHeight;
      svg.setAttribute("viewBox", "0 0 " + w + " " + h);
      svg.setAttribute("width", w);
      svg.setAttribute("height", h);
      svg.innerHTML = paths.map(function (o) {
        var attr = "";
        if (o.p != null) attr += ' data-edge-p="' + o.p + '"';
        if (o.k) attr += ' data-edge-k="' + o.k.join(",") + '"';
        return '<path d="' + o.d + '"' + attr + ' fill="none" stroke-linecap="square"/>';
      }).join("");
      // Återställ ev. aktiv hover-markering efter omritning av linjerna.
      if (hoverLineage != null) setBracketLineage(hoverLineage);
      if (typeof afterLayout === "function") afterLayout();
    });
  }

  /* Tänd härstamningen bakåt för en slutspelsmatch: de matcher som leder in i
     den (dess "barn") plus linjerna däremellan – så att man ser vilka tidigare
     matcher som avgör rutan. Matchen den själv leder vidare till (framåt)
     tänds inte. Övriga rutor/linjer dämpas. no=null nollställer. */
  function setBracketLineage(no) {
    var wrap = viewEl.querySelector(".bracket-wrap");
    if (!wrap) return;
    wrap.classList.remove("lineage-active");
    wrap.querySelectorAll(".is-lineage").forEach(function (el) { el.classList.remove("is-lineage"); });
    hoverLineage = (no == null ? null : no);
    if (hoverLineage == null) return;

    var key = String(no);
    var related = {};
    related[key] = true;
    wrap.querySelectorAll(".bracket-lines path").forEach(function (pth) {
      var p = pth.getAttribute("data-edge-p");
      var k = pth.getAttribute("data-edge-k");
      var kids = k ? k.split(",") : [];
      // Tänd enbart bakåt: matcherna som matar in i den hovrade rutan (dess
      // "barn"), inte matchen den själv leder vidare till (dess "förälder").
      if (p === key) {
        pth.classList.add("is-lineage");
        kids.forEach(function (x) { related[x] = true; });
      }
    });
    Object.keys(related).forEach(function (m) {
      var card = wrap.querySelector('.match[data-m="' + m + '"]');
      if (card) card.classList.add("is-lineage");
    });
    wrap.classList.add("lineage-active");
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
    if (slot.t === "wm") return "Vinnare " + koRefLabel(slot.m);
    if (slot.t === "lm") return "Förlorare " + koRefLabel(slot.m);
    return "?";
  }

  /* Gruppbokstav i gruppens egen färg (samma palett som grupptabellerna). */
  function grpLetter(L) {
    var u = String(L || "").toUpperCase();
    return '<span class="grp-letter grp-' + u + '">' + esc(u) + '</span>';
  }

  /* Binder slutspelsnumret till sitt rundord med hårt mellanslag så att de smala
     trädrutorna bryter platshållaren som "Vinnare" / "åttondelsfinal 2" i stället
     för att lämna en ensam siffra på egen rad (ser kapad/ofärdig ut). */
  function bindKoNum(s) { return s.replace(/ (\d+)$/, "\u00A0$1"); }

  /* Seed-etikett som HTML där gruppbokstäverna är färgkodade, t.ex.
     "Etta grupp E" eller "3:a grupp A/B/C/D/F". Match-platshållare
     ("Vinnare 1/16-final 3") saknar grupp och visas som ren text. */
  function slotSeedHtml(slot) {
    if (!slot) return "";
    if (slot.t === "w") return "Etta grupp " + grpLetter(slot.g);
    if (slot.t === "r") return "Tvåa grupp " + grpLetter(slot.g);
    if (slot.t === "3") return "3:a grupp " + slot.from.map(grpLetter).join("/");
    if (slot.t === "wm") return "Vinnare " + bindKoNum(esc(koRefLabel(slot.m)));
    if (slot.t === "lm") return "Förlorare " + bindKoNum(esc(koRefLabel(slot.m)));
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
      '<span class="mu-seed seed-chip ' + seedTypeClass(slot) + '" title="' + esc(slotSeedLong(slot)) +
      '">' + slotSeedHtml(slot) + '</span>' +
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

    // Visningsläge: "seed" visar platsetiketter (Etta grupp E …) för oavgjorda
    // platser; "odds" ersätter dem i hela trädet med det mest sannolika laget.
    var oddsMode = bracketMode() === "odds";
    var homeSide = displaySide(res, "home", oddsMode);
    var awaySide = displaySide(res, "away", oddsMode);

    var h = '<div class="' + cls + '" data-m="' + m.m + '"' + open.attr + (opts.grid ? ' style="' + opts.grid + '"' : '') + '">';
    // Final/Brons har redan tydliga egna rubriker – upprepa inte rundnamnet i rutan.
    var metaLabel = (variant === "final" || variant === "bronze") ? "" : koRoundLabel(m);
    // Datumet i foten räcker för kommande matcher; statusbrickan visas bara när
    // den säger något utöver datumet (live/spelad/inväntar resultat).
    var showRel = rel.cls === "live" || rel.cls === "done" || rel.cls === "await";
    if (metaLabel || showRel) {
      h += '<div class="m-meta">' +
           (metaLabel ? '<span class="m-no">' + esc(metaLabel) + '</span>' : '') +
           (showRel ? '<span class="m-rel ' + rel.cls + '">' + rel.txt + '</span>' : '') +
           '</div>';
    }
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
         '<span class="m-when">' + bracketDateShort(m) + ' · ' + when.time + '</span>' +
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
      : '<span class="s-name placeholder seed-chip ' + seedTypeClass(slot) + '" title="' + esc(slotSeedLong(slot)) + '">' + slotSeedHtml(slot) + '</span>';
    var r = res.result || {};
    var scoreCell = scoreDisplay(r[ha]);
    return '<div class="' + cls + '">' + inner + scoreCell + '</div>';
  }

  /* ---------- Sidopanel (möjliga lag + tabeller) ---------- */
  function hideAside() {
    var el = document.getElementById("bracketAside");
    if (el) el.classList.remove("show", "aside-left");
    hideProbPopup();
  }

  function syncExpandButtons() {
    document.querySelectorAll(".match-expand").forEach(function (btn) {
      var no = parseInt(btn.getAttribute("data-expand-match"), 10);
      var open = hoverMatch === no;
      btn.classList.toggle("on", open);
      var label = open ? "Dölj odds & väg hit" : "Visa odds & väg hit";
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
    hideProbPopup();
    el.classList.toggle("aside-left", bracketAsideSide(matchNo) === "left");
    el.classList.add("show");
    var res = ctx.resolved[matchNo];
    var mt = res.match;

    // Panelen äger kvalvägen (seed) och visar tydligt vem som möter vem samt
    // sannolikheterna. Matchrutan i trädet visar bara lagen.
    var singleMatch = mt.round === "FINAL" || mt.round === "3RD";
    var h = '<div class="aside-head">' +
      '<div class="aside-title">' +
      '<span class="aside-round">' + WC.roundNames[mt.round] + '</span>' +
      (singleMatch ? '' : '<span class="aside-match-no">Match ' + koChronoIndex()[matchNo] + '</span>') +
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
  // Visningsläge för slutspelsträdet: "seed" (platsetiketter) eller "odds"
  // (oddsfavoriten i hela trädet). Växlas via knappraden överst i slutspelsvyn.
  function bracketMode() { return ui("bracketMode", "seed") === "odds" ? "odds" : "seed"; }

  /* ====================================================================
     R32-MOTSTÅNDARSIMULATOR  (inbäddad i slutspelsvyn)
     Monte Carlo över de återstående gruppmatchernas resultat-odds → vem man
     möter i sextondelsfinalen. Motorn (assets/r32engine.js) körs i en Web
     Worker; här bygger vi indata från de live-resultat sidan redan har och
     ritar resultatet i samma mörka stil som resten av sidan.
  ==================================================================== */
  var R32_RES = ["1", "X", "2"];
  function r32TitleText(svName) { return "Vem möter " + svName + "?"; }
  function r32Pct(x) { return x == null ? "–" : (x * 100).toFixed(x >= 0.0995 ? 0 : 1) + "%"; }
  // Förändring i procentenheter, men visad som "%" för läsbarhet (genomsnitts-
  // användaren tänker i procent). ±0 % när skillnaden avrundas till noll.
  function r32Dpp(d) {
    var v = Math.round(d * 100);
    if (v === 0) return "±0 %";
    return (v > 0 ? "+" : "−") + Math.abs(v) + " %";
  }
  function r32DirCls(d) { var v = Math.round(d * 100); return v > 0 ? "good" : v < 0 ? "bad" : "neutral"; }

  // Lista över alla lag: { key:"G:idx", g, idx, team }
  function r32AllTeams() {
    var out = [];
    WC.groupLetters.forEach(function (L) {
      WC.groups[L].forEach(function (t, i) { out.push({ key: L + ":" + i, g: L, idx: i, team: t }); });
    });
    return out;
  }
  function r32TeamByKey(key) {
    var p = (key || "F:3").split(":"); var g = p[0], i = parseInt(p[1], 10);
    if (!WC.groups[g] || !WC.groups[g][i]) { g = "F"; i = 3; }
    return { g: g, idx: i, team: WC.groups[g][i] };
  }
  function r32EnglishToTeam() {
    var map = {};
    WC.groupLetters.forEach(function (L) { WC.groups[L].forEach(function (t) { map[t.name] = t; }); });
    return map;
  }

  // De tyngsta lagen att slippa: tre högst FIFA-rankade (utom det analyserade laget).
  function r32AvoidSet(skipName) {
    var all = r32AllTeams().filter(function (e) { return e.team.name !== skipName; });
    all.sort(function (a, b) { return fifaRankOf(a.team) - fifaRankOf(b.team); });
    return all.slice(0, 3).map(function (e) { return e.team; });
  }

  // Ladda + normalisera odds.json. p = (1/odds) normaliserat per match.
  function normalizeOddsJson(data) {
    var matches = (data.matches || []).map(function (m) {
      var inv = m.scores.map(function (s) { return 1 / s.odds; });
      var tot = inv.reduce(function (a, b) { return a + b; }, 0);
      var scores = m.scores.map(function (s, k) { return { h: s.h, a: s.a, p: inv[k] / tot }; });
      var rp = { "1": 0, "X": 0, "2": 0 };
      scores.forEach(function (s) { rp[s.h > s.a ? "1" : s.h === s.a ? "X" : "2"] += s.p; });
      var pair = [m.home_idx, m.away_idx].slice().sort(function (a, b) { return a - b; }).join(",");
      return {
        id: m.group + "-" + m.home_idx + "-" + m.away_idx,
        key: m.key || null,
        g: m.group, i: m.home_idx, j: m.away_idx,
        home: m.home, away: m.away, pair: pair, scores: scores, rp: rp,
        oddsContext: m.oddsContext || "prematch",
        scrapedAt: m.scrapedAt || null,
        matchMinute: m.matchMinute != null ? m.matchMinute : null
      };
    });
    return { updated: data.updated || null, matches: matches, knockout: (data.knockout || []).map(normalizeKnockoutEntry) };
  }

  function r32EnsureOdds(cb, force) {
    if (!force && r32OddsData && r32OddsData !== "loading" && r32OddsData !== "error") return cb(r32OddsData);
    if (r32OddsData === "loading" && !force) return;
    r32OddsData = "loading";
    fetch("data/odds.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("odds " + r.status);
      return r.json();
    }).then(function (data) {
      marketOddsStamp = data.updated || null;
      r32OddsData = normalizeOddsJson(data);
      cb(r32OddsData);
    }).catch(function () { r32OddsData = "error"; if (legacyR32Open) paintR32(); });
  }

  function normalizeKnockoutEntry(ko) {
    var h2h = ko.h2h || {};
    var inv = {
      "1": h2h["1"] ? 1 / h2h["1"] : 0,
      "X": h2h.X ? 1 / h2h.X : 0,
      "2": h2h["2"] ? 1 / h2h["2"] : 0
    };
    var tot = inv["1"] + inv["X"] + inv["2"];
    var rp = tot > 0
      ? { "1": inv["1"] / tot, "X": inv["X"] / tot, "2": inv["2"] / tot }
      : { "1": 1 / 3, "X": 1 / 3, "2": 1 / 3 };
    return {
      key: ko.key,
      matchNo: ko.matchNo,
      home: ko.home,
      away: ko.away,
      h2h: h2h,
      rp: rp,
      oddsContext: ko.oddsContext || "prematch",
      scrapedAt: ko.scrapedAt || null,
      matchMinute: ko.matchMinute != null ? ko.matchMinute : null
    };
  }

  // Poisson (pre-match-odds) eller villkorad sampling (inplay-odds) för live-match.
  function attachLiveOdds(g, m, live) {
    if (!live) return g;
    var ctx = m.oddsContext || "prematch";
    if (ctx === "inplay") {
      g.live = { h: live.h, a: live.a, mode: "inplay" };
    } else {
      var muH = 0, muA = 0;
      m.scores.forEach(function (s) { muH += s.h * s.p; muA += s.a * s.p; });
      g.live = { h: live.h, a: live.a, mode: "prematch", lamH: muH * live.frac, lamA: muA * live.frac };
    }
    return g;
  }

  // Hämta nya marknadsodds om GitHub committat uppdatering (math tills dess).
  function reloadMarketOdds(cb) {
    var changed = false, pending = 2;
    function done() {
      pending--;
      if (pending > 0) return;
      if (changed) {
        r32Key = null;
        calcKey = null;
        bracketEngKey = null;
        updateBracketProbs();
        if (legacyR32Open) runR32Sim();
        if (calcOpen) runCalc();
      }
      if (cb) cb(changed);
    }
    fetch("data/odds.json", { cache: "no-store" }).then(function (r) {
      return r && r.ok ? r.json() : null;
    }).then(function (data) {
      if (data && data.updated && data.updated !== marketOddsStamp) {
        marketOddsStamp = data.updated;
        r32OddsData = normalizeOddsJson(data);
        changed = true;
      }
      done();
    }).catch(done);
    fetch("data/winner_odds.json", { cache: "no-store" }).then(function (r) {
      return r && r.ok ? r.json() : null;
    }).then(function (wo) {
      if (wo && wo.updated && wo.updated !== winnerOddsStamp && wo.teams && window.BracketEngine) {
        winnerOddsStamp = wo.updated;
        bracketStrength = window.BracketEngine.strengthsFromOutrights(wo.teams);
        changed = true;
      }
      done();
    }).catch(done);
  }

  function anyGroupMatchLive() {
    for (var li = 0; li < WC.groupLetters.length; li++) {
      var L = WC.groupLetters[li];
      var fxs = groupFixtures(L);
      for (var fi = 0; fi < fxs.length; fi++) {
        if (isMatchLive(fxs[fi].key)) return true;
      }
    }
    return false;
  }

  function anyLiveOddsPoll() {
    if (anyGroupMatchLive()) return true;
    for (var ki = 0; ki < WC.knockout.length; ki++) {
      if (isMatchLive("k:" + WC.knockout[ki].m)) return true;
    }
    return false;
  }

  // Matchnummer per motor-varv (ri=1 → R32, ri=2 → R16, … ri=5 → final).
  function buildKoPlayOrders(r32Order) {
    var byNo = {};
    WC.knockout.forEach(function (m) { byNo[m.m] = m; });
    function findParent(m1, m2) {
      for (var no in byNo) {
        var m = byNo[no];
        if (m.round === "R32") continue;
        var hm = m.home.t === "wm" ? m.home.m : null;
        var am = m.away.t === "wm" ? m.away.m : null;
        if (hm && am && ((hm === m1 && am === m2) || (hm === m2 && am === m1))) return parseInt(no, 10);
      }
      return null;
    }
    var orders = [null, r32Order.slice()];
    var prev = r32Order.slice();
    for (var r = 0; r < 3; r++) {
      var next = [];
      for (var i = 0; i < prev.length; i += 2) {
        next.push(findParent(prev[i], prev[i + 1]));
      }
      orders.push(next);
      prev = next;
    }
    orders.push([104]);
    return orders;
  }

  var KO_PLACEHOLDER = /group|third place|winner|loser|\bplace\b/i;
  function koTeamKnown(name) { return !!name && !KO_PLACEHOLDER.test(name); }

  function koRpFallback(home, away) {
    if (!bracketStrength || bracketStrength[home] == null || bracketStrength[away] == null) return null;
    var p1 = 1 / (1 + Math.exp(-0.6 * (bracketStrength[home] - bracketStrength[away])));
    var px = 0.22;
    var p2 = 1 - p1 - px;
    if (p2 < 0) { px = 0.1; p2 = Math.max(0.02, 1 - p1 - px); }
    return { "1": p1, "X": px, "2": p2 };
  }

  function buildKoOddsMap(knockout) {
    var scraped = {};
    (knockout || []).forEach(function (ko) { if (ko.key) scraped[ko.key] = ko; });
    var koOdds = {};
    WC.knockout.forEach(function (mt) {
      var key = "k:" + mt.m;
      var fx = getApiFixture(key);
      var home = fx && koTeamKnown(fx.home) ? fx.home : null;
      var away = fx && koTeamKnown(fx.away) ? fx.away : null;
      if (!home || !away) return;
      var s = scraped[key];
      var entry = {
        home: home, away: away,
        rp: (s && s.rp) || koRpFallback(home, away),
        oddsContext: (s && s.oddsContext) || "prematch"
      };
      var r = getRes(key);
      if (isFinishedMatch(key, r) && r && r.h != null && r.a != null) {
        entry.finished = true;
        if (r.h !== r.a) entry.winner = r.h > r.a ? home : away;
        else if (r.pw) entry.winner = r.pw === "h" ? home : away;
      }
      var live = liveMatchState(key);
      if (live) entry.live = live;
      koOdds[key] = entry;
    });
    return koOdds;
  }

  // Bygg motorns indata från live-resultat + odds. Returnerar { input, key }.
  function r32BuildInput(odds) {
    var sel = r32TeamByKey(r32TeamKey);
    var names = {}, fifa = {};
    WC.groupLetters.forEach(function (L) {
      names[L] = WC.groups[L].map(function (t) { return t.name; });
      fifa[L] = WC.groups[L].map(function (t) { return fifaRankOf(t); });
    });

    // FÄRDIGSPELADE matcher = baslinje. Live-matcher låses inte här utan
    // hamnar bland odds-matcherna nedan och simuleras tills de är slutspelade.
    var played = [], playedPairs = {};
    WC.groupLetters.forEach(function (L) {
      playedPairs[L] = {};
      groupFixtures(L).forEach(function (fx) {
        var r = getRes(fx.key);
        if (!isFinishedMatch(fx.key, r)) return;
        played.push({ g: L, i: fx.h, j: fx.a, gi: r.h, gj: r.a });
        playedPairs[L][[fx.h, fx.a].slice().sort(function (a, b) { return a - b; }).join(",")] = true;
      });
    });

    // odds-matcher vars fixtur ännu inte spelats = redigerbara, simulerade
    var oddsPairs = {};
    var oddsGames = [];
    var fxKeyByPair = {};
    WC.groupLetters.forEach(function (L) {
      fxKeyByPair[L] = {};
      groupFixtures(L).forEach(function (fx) {
        fxKeyByPair[L][[fx.h, fx.a].slice().sort(function (a, b) { return a - b; }).join(",")] = fx.key;
      });
    });
    odds.matches.forEach(function (m) {
      oddsPairs[m.g] = oddsPairs[m.g] || {}; oddsPairs[m.g][m.pair] = true;
      if (playedPairs[m.g] && playedPairs[m.g][m.pair]) return; // redan spelad → ligger i baslinjen
      var fxKey = fxKeyByPair[m.g] && fxKeyByPair[m.g][m.pair];
      var live = fxKey ? liveMatchState(fxKey) : null;
      var g = {
        id: m.id, g: m.g, i: m.i, j: m.j, home: m.home, away: m.away,
        scores: m.scores, rp: m.rp, fixed: r32Fixed[m.id] || null
      };
      oddsGames.push(attachLiveOdds(g, m, live));
    });

    // ospelade matcher utan odds = neutral modell (ovanligt så här sent)
    var neutral = [];
    WC.groupLetters.forEach(function (L) {
      groupFixtures(L).forEach(function (fx) {
        if (isFinishedMatch(fx.key, getRes(fx.key))) return;
        var pk = [fx.h, fx.a].slice().sort(function (a, b) { return a - b; }).join(",");
        if (playedPairs[L][pk] || (oddsPairs[L] && oddsPairs[L][pk])) return;
        neutral.push({ g: L, i: fx.h, j: fx.a });
      });
    });

    var input = {
      teamG: sel.g, teamIdx: sel.idx, n: R32_N, seed: 0x9e3779b9,
      groups: names, fifa: fifa,
      // de hårdaste lagen man faktiskt kan möta väljs i motorn (topp-3 FIFA bland
      // möjliga motståndare); avoidNames är en reserv om inga motståndare hittas.
      autoAvoidTop: 3, avoidNames: r32AvoidSet(sel.team.name).map(function (t) { return t.name; }),
      annexC: window.ANNEX_C, annexSlots: window.ANNEX_C_SLOTS,
      played: played, oddsGames: oddsGames, neutral: neutral
    };
    var key = JSON.stringify({
      t: r32TeamKey, n: R32_N,
      pl: played.map(function (p) { return p.g + p.i + p.j + ":" + p.gi + "-" + p.gj; }).sort(),
      og: oddsGames.map(function (g) {
        return g.id + (g.live ? ("@" + g.live.h + "-" + g.live.a + (g.live.mode || "")) : "");
      }).sort(),
      fx: Object.keys(r32Fixed).sort().map(function (k) { return k + "=" + r32Fixed[k].join(","); }),
      ne: neutral.map(function (g) { return g.g + g.i + g.j; }).sort()
    });
    return { input: input, key: key };
  }

  function r32EnsureWorker() {
    if (r32Worker) return;
    try {
      r32Worker = new Worker("assets/r32worker.js");
      r32Worker.onmessage = function (e) {
        var d = e.data || {};
        if (d.seq !== r32Seq) return;     // ett nyare anrop har redan startats
        r32Busy = false;
        if (d.error) { setR32Status("kunde inte räkna ut just nu"); return; }
        r32Result = d.result; r32Key = d.key;
        renderR32Dynamic();
      };
      r32Worker.onerror = function () {
        // Worker kunde inte laddas/köras → fall tillbaka på huvudtråden.
        r32Worker = "none"; r32Busy = false; r32Key = null; runR32Sim();
      };
    } catch (err) { r32Worker = "none"; }
  }

  function setR32Status(txt) {
    var el = document.getElementById("r32-status");
    if (el) el.textContent = txt;
  }

  function runR32Sim() {
    if (!r32OddsData || r32OddsData === "loading" || r32OddsData === "error") return;
    var built = r32BuildInput(r32OddsData);
    if (r32Key === built.key && r32Result) { renderR32Dynamic(); return; }
    setR32Status("räknar …");
    r32Seq++;
    var seq = r32Seq, key = built.key;
    r32EnsureWorker();
    if (r32Worker && r32Worker !== "none") {
      r32Busy = true;
      r32Worker.postMessage({ seq: seq, key: key, input: built.input });
    } else {
      // fallback: kör på huvudtråden (ger en kort paus men funkar utan Worker)
      setTimeout(function () {
        if (seq !== r32Seq) return;
        try {
          r32Result = window.R32Engine.simulate(built.input); r32Key = key;
          renderR32Dynamic();
        } catch (err) { setR32Status("kunde inte räkna ut just nu"); }
      }, 16);
    }
  }
  function r32AvoidLabel() {
    if (!r32Result || !r32Result.avoidNames || !r32Result.avoidNames.length) return "topplagen";
    var byName = r32EnglishToTeam();
    return r32Result.avoidNames.map(function (nm) {
      var t = byName[nm];
      return t ? teamSvFixture(t) : nm;
    }).join("/");
  }
  // Exempel på de troligaste "lättare" motståndarna – speglar topplags-etiketten.
  function r32GoodLabel() {
    if (!r32Result || !r32Result.outcomes) return "";
    var good = r32Result.outcomes
      .filter(function (o) { return o.good === true && o.prob > 0; })
      .sort(function (a, b) { return b.prob - a.prob; })
      .slice(0, 3);
    if (!good.length) return "";
    var byName = r32EnglishToTeam();
    return good.map(function (o) {
      var t = byName[o.label];
      return t ? teamSvFixture(t) : r32SvName(o.label);
    }).join("/");
  }

  /* ---------- panel-skelett ---------- */
  /* Sextondelskollen som egen vy (nås via top-navet, inte längre från
     slutspelsträdet). Panelen äger #view själv – på samma sätt som
     slutspelsvyn – så vi nollställer signaturcachen och målar dynamiken. */
  function renderR32View() {
    lastViewSig = null;
    viewEl.innerHTML = '<div class="r32-view">' + r32PanelHtml() + '</div>';
    var sl = document.getElementById("r32-team");
    if (sl) sl.value = r32TeamKey;
    paintR32();
    return true;
  }

  /* Sorteringsväljare för matchlistan: spelordning (kronologisk, default) eller
     viktigast (störst påverkan för det valda laget). */
  function r32SortControl() {
    var sort = ui("r32Sort", "time");
    function btn(v, label) {
      return '<button type="button" class="r32-sortbtn' + (sort === v ? " on" : "") +
        '" data-r32-sort="' + v + '" aria-pressed="' + (sort === v ? "true" : "false") + '">' + label + '</button>';
    }
    return '<div class="r32-sort" role="group" aria-label="Sortera matcher">' +
      '<span class="r32-sort-lbl">Sortera:</span>' +
      btn("time", "Spelordning") + btn("impact", "Viktigast") +
      '</div>';
  }

  function r32PanelHtml() {
    var sel = r32TeamByKey(r32TeamKey);
    // lag-väljare grupperad per grupp
    var optgroups = WC.groupLetters.map(function (L) {
      var opts = WC.groups[L].map(function (t, i) {
        var k = L + ":" + i;
        return '<option value="' + k + '"' + (k === r32TeamKey ? " selected" : "") + '>' + esc(t.sv) + "</option>";
      }).join("");
      return '<optgroup label="Grupp ' + L + '">' + opts + "</optgroup>";
    }).join("");

    function quick(key) {
      var t = r32TeamByKey(key).team;
      return '<button type="button" class="r32-quick' + (key === r32TeamKey ? " on" : "") +
        '" data-r32-tab="' + key + '">' + flagImg(t.iso) + '<span>' + esc(t.sv) + '</span></button>';
    }

    return '' +
      '<section class="r32-panel" aria-label="Motståndarsimulator">' +
        '<div class="r32-head">' +
          '<div class="r32-titlewrap">' +
            '<h3 id="r32-title">' + esc(r32TitleText(sel.team.sv)) + '</h3>' +
            '<p class="r32-sub">Klicka i hur gruppmatcherna slutar – så ser du vilka lag ' +
              esc(sel.team.sv) + ' kan möta i 1/16-finalen. ' +
              '<span class="r32-status" id="r32-status"></span></p>' +
          '</div>' +
          '<div class="r32-pick">' +
            '<div class="r32-quicktabs">' + quick("F:3") + quick("H:1") + '</div>' +
            '<label class="r32-select"><span>Lag</span>' +
              '<select id="r32-team">' + optgroups + '</select></label>' +
            '<button type="button" class="r32-reset" data-r32-reset>Återställ val</button>' +
          '</div>' +
        '</div>' +
        '<div class="r32-summary" id="r32-summary"></div>' +
        '<div class="r32-body">' +
          '<div class="r32-col r32-games-col">' +
            '<div class="r32-colhead"><h4>Matcher kvar att spela</h4>' +
              r32SortControl() +
            '</div>' +
            '<div class="r32-legend">Färgen visar läget för ' + esc(sel.team.sv) + ': ' +
              '<i class="sw good"></i>bättre <i class="sw neu"></i>oförändrat <i class="sw bad"></i>sämre</div>' +
            '<div id="r32-games" class="r32-games"></div>' +
          '</div>' +
          '<div class="r32-col r32-side-col">' +
            '<div class="r32-card"><h4>Möjliga motståndare</h4>' +
              '<p class="r32-cardsub" id="r32-outcome-sub"></p>' +
              '<div id="r32-outcomes" class="r32-outcomes"></div></div>' +
            '<div class="r32-card"><h4 id="r32-standings-title">Gruppen just nu</h4>' +
              '<div id="r32-standings"></div></div>' +
          '</div>' +
        '</div>' +
      '</section>';
  }

  function paintR32() {
    if (r32OddsData === "error") { setR32Status("kunde inte hämta data"); return; }
    if (!r32Result) setR32Status("laddar …");
    r32EnsureOdds(function () {
      if (!legacyR32Open) return;
      runR32Sim();
    });
  }

  /* ---------- rita dynamiskt innehåll ---------- */
  function renderR32Dynamic() {
    if (!r32Result) return;
    r32TipN = 0; r32TipMap = {};
    var avoid = r32AvoidLabel();
    var sel = r32TeamByKey(r32TeamKey);
    var titleEl = document.getElementById("r32-title");
    if (titleEl) titleEl.textContent = r32TitleText(sel.team.sv);
    setR32Status("");

    renderR32Summary(avoid);
    renderR32Outcomes(avoid);
    renderR32Standings(sel);
    renderR32Games();
  }

  function renderR32Summary(avoid) {
    var s = r32Result.summary;
    var el = document.getElementById("r32-summary");
    if (!el) return;
    var good = r32GoodLabel();
    el.innerHTML =
      '<div class="r32-stat good"><div class="v">' + r32Pct(s.good) + '</div><div class="l">Möter ett lag de bör klara' + (good ? ' (' + esc(good) + ')' : '') + '</div></div>' +
      '<div class="r32-stat bad"><div class="v">' + r32Pct(s.bad) + '</div><div class="l">Möter ett topplag (' + esc(avoid) + ')</div></div>' +
      '<div class="r32-stat out"><div class="v">' + r32Pct(s.eliminated) + '</div><div class="l">Åker ut i gruppspelet</div></div>';
  }

  function r32TipId(html) {
    var id = "t" + (r32TipN++);
    r32TipMap[id] = html;
    return id;
  }
  var r32TipN = 0;

  // Kortet som visas när man hovrar ett tänkbart utfall: hur det påverkar det
  // valda lagets lottning. Headline = lätt-att-förstå omdöme ("bättre/sämre
  // lottning") med färg. Listan = vilka motståndare som blir troligare (↑) eller
  // mindre troliga (↓), där PIL + SIFFRA färgas efter om skiftet är bra (grönt)
  // eller dåligt (rött) FÖR DIG – inte efter om motståndaren är vass. Lagnamnet
  // hålls neutralt så färgen entydigt betyder "bra/dåligt för dig".
  function r32TipBody(b, base) {
    if (!b || b.good == null) return '<div class="r32t-empty">för lite underlag</div>';
    var d = b.good - base, dir = r32DirCls(d);
    var verdict = dir === "good" ? "bättre lottning" : dir === "bad" ? "sämre lottning" : "oförändrad lottning";
    var s = '<div class="r32t-main ' + dir + '"><span class="r32t-delta">' + r32Dpp(d) +
      '</span><span class="r32t-lbl">' + verdict + '</span></div>';
    if (b.changes && b.changes.length) {
      s += '<div class="r32t-cap">Motståndare</div><div class="r32t-list">';
      s += b.changes.map(function (c) {
        // Bra för dig = möta ett spelbart lag oftare, eller ett topplag mer sällan.
        var goodForMe = (c.good === true) ? (c.delta > 0) : (c.delta < 0);
        var arrow = c.delta > 0 ? "↑" : "↓";
        return '<div class="r32t-chg ' + (goodForMe ? "good" : "bad") + '">' +
          '<span class="ar">' + arrow + '</span>' +
          '<span class="nm">' + esc(r32SvName(c.label)) + '</span>' +
          '<span class="d">' + r32Dpp(c.delta) + '</span></div>';
      }).join("");
      s += '</div>';
    }
    return s;
  }

  function r32SvName(englishName) {
    if (englishName === "Eliminated") return "Utslagen";
    var t = r32EnglishToTeam()[englishName];
    return t ? t.sv : englishName;
  }

  function renderR32Outcomes(avoid) {
    var host = document.getElementById("r32-outcomes");
    if (!host) return;
    var outs = r32Result.outcomes.filter(function (o) { return o.prob > 0; });
    var maxP = Math.max.apply(null, outs.map(function (o) { return o.prob; }).concat([0.0001]));
    host.innerHTML = outs.map(function (o) {
      var klass = o.good == null ? "out" : (o.good ? "good" : "bad");
      var od = o.label === "Eliminated" || o.win == null ? "" : ("ni vinner " + Math.round(o.win * 100) + "%");
      var tip = r32TipId(r32OutcomeTip(o));
      return '<div class="r32-outcome ' + klass + '" data-r32-tip="' + tip + '">' +
        '<div class="top"><span class="nm">' + esc(r32SvName(o.label)) + '</span>' +
          '<span class="od">' + r32Pct(o.prob) + (od ? " · " + od : "") + '</span></div>' +
        '<div class="bar"><div style="width:' + (o.prob / maxP * 100).toFixed(1) + '%"></div></div></div>';
    }).join("");
    var sub = document.getElementById("r32-outcome-sub");
    if (sub) sub.innerHTML = outs.length + ' lag kan bli motståndare. Stapeln visar hur troligt det är. ' +
      '<i class="dot good"></i> lag de bör klara · <i class="dot bad"></i> topplag.';
  }

  function r32OutcomeTip(o) {
    var s = '<h4>' + esc(r32SvName(o.label)) + '</h4>';
    if (o.win != null) s += '<div class="hl">~<b>' + Math.round(o.win * 100) + '%</b> att ' + esc(r32Result.teamName === "Sweden" ? "Sverige" : r32SvName(r32Result.teamName)) + ' vinner matchen</div>';
    if (o.sweden_pos) s += '<div>Slutar som: <b>' + esc(o.sweden_pos) + '</b></div>';
    if (o.key_games && o.key_games.length) {
      s += '<div class="ci" style="margin-top:6px">Påverkas mest av:</div>';
      s += o.key_games.map(function (k) {
        return '<div class="chg"><span>' + esc(r32SvMatch(k.match)) + '</span></div>' +
          '<div class="ci" style="margin:-2px 0 4px">↑ troligare vid ' + esc(r32SvCheer(k.cheer)) + '</div>';
      }).join("");
    } else if (o.label !== "Eliminated") {
      s += '<div class="ci" style="margin-top:4px">styrs mest av egen placering</div>';
    }
    return s;
  }
  function r32SvMatch(m) {
    var parts = m.split(" – ");
    return parts.map(function (p) { return r32SvName(p); }).join(" – ");
  }
  function r32SvCheer(c) {
    if (c === "oavgjort") return "oavgjort";
    return r32SvName(c);
  }

  function renderR32Standings(sel) {
    var host = document.getElementById("r32-standings");
    if (!host) return;
    var title = document.getElementById("r32-standings-title");
    if (title) title.textContent = "Grupp " + sel.g + " just nu";
    var table = computeTable(sel.g);
    host.innerHTML = '<table class="r32-standings"><tr><th class="nm">Lag</th><th>S</th><th>MV</th><th>GM</th><th>P</th></tr>' +
      table.map(function (r, pos) {
        var isTeam = r.idx === sel.idx;
        return '<tr' + (isTeam ? ' class="me"' : '') + '>' +
          '<td class="nm">' + (pos + 1) + '. ' + flagImg(r.team.iso) + esc(r.team.sv) + '</td>' +
          '<td>' + r.pld + '</td><td>' + (r.gd >= 0 ? "+" : "") + r.gd + '</td>' +
          '<td>' + r.gf + '</td><td>' + r.pts + '</td></tr>';
      }).join("") + '</table>';
  }

  // tint för påverkan (mörkt tema): negativ=röd, neutral=grå, positiv=grön
  function r32ImpactStyle(delta) {
    if (delta == null) return null;
    var t = Math.max(-1, Math.min(1, delta / 0.15));
    var hue = t >= 0 ? 142 : 2;
    var sat = Math.round(Math.abs(t) * 50);
    return "background:hsl(" + hue + " " + sat + "% 15%);" +
      "border-color:hsl(" + hue + " " + sat + "% 28%);" +
      "border-bottom-color:hsl(" + hue + " " + Math.min(sat + 8, 64) + "% 40%);";
  }

  /* Avsparkstid (ms) för en kvarvarande gruppmatch utifrån dess id ("L-i-j"),
     så listan kan sorteras i spelordning. Okänt datum sorteras sist. */
  function r32GameKickoff(g) {
    var p = String(g.id).split("-");
    if (p.length < 3) return Infinity;
    var L = p[0], hi = +p[1], ai = +p[2];
    var fxs = groupFixtures(L);
    for (var k = 0; k < fxs.length; k++) {
      var fx = fxs[k];
      if ((fx.h === hi && fx.a === ai) || (fx.h === ai && fx.a === hi)) {
        var ko = kickoffMsForKey(fx.key);
        return ko == null ? Infinity : ko;
      }
    }
    return Infinity;
  }

  function renderR32Games() {
    var host = document.getElementById("r32-games");
    if (!host || !r32Result) return;
    var sort = ui("r32Sort", "time");
    var games = r32Result.games.slice();
    if (sort === "impact") {
      games.sort(function (a, b) { return b.importance - a.importance; });
    } else {
      games.sort(function (a, b) {
        return (r32GameKickoff(a) - r32GameKickoff(b)) || (b.importance - a.importance);
      });
    }
    // Stjärnan markerar alltid de 2 mest avgörande matcherna, oavsett sortering.
    var top2 = {};
    r32Result.games.slice()
      .sort(function (a, b) { return b.importance - a.importance; })
      .slice(0, 2).forEach(function (g) { if (g.importance > 0.04) top2[g.id] = true; });
    host.innerHTML = games.map(function (g) { return r32GameRow(g, top2[g.id]); }).join("");
  }

  function r32GameRow(g, star) {
    var base = g.base_good != null ? g.base_good : (r32Result.summary.good);
    var fx = r32Fixed[g.id];
    var locked = !!fx;
    var open = !!r32OpenGrids[g.id];

    var teamMap = r32EnglishToTeam();
    var homeT = teamMap[g.home], awayT = teamMap[g.away];
    var chips = R32_RES.map(function (r) {
      var b = g.results[r] || {};
      var scorish = (g.score_flags || {})[r];
      var selR = fx && fx[0] === "result" && fx[1] === r;
      var selS = fx && fx[0] === "score" &&
        ((r === "1" && fx[1] > fx[2]) || (r === "X" && fx[1] === fx[2]) || (r === "2" && fx[1] < fx[2]));
      var sel = selR || selS;
      var style = scorish ? "" : r32ImpactStyle(b.good != null ? b.good - base : null);
      var cls = "r32-chip" + (sel ? " sel" : "") + (scorish ? " scorish" : "") + (b.good == null && !scorish ? " nodata" : "");
      var tip = r32TipId(r32ResultTip(g, r));
      var who = r === "1" ? homeT : awayT;
      var label = r === "X"
        ? '<span class="rwho">Oavgjort</span>'
        : '<span class="rwho">' + (who ? flagImg(who.iso) + '<span class="rnm">' + esc(teamSvFixture(who)) + '</span>' : '<span class="rnm">' + esc(r32SvName(r === "1" ? g.home : g.away)) + '</span>') + '</span>';
      return '<button type="button" class="' + cls + '" data-r32-gid="' + g.id + '" data-r32-r="' + r + '"' +
        (style ? ' style="' + style + '"' : '') + ' data-r32-tip="' + tip + '">' +
        label + '<span class="rsub">' + r32Pct(g.result_probs[r]) + '</span>' +
        (scorish ? '<span class="rtag">▸</span>' : '') + '</button>';
    }).join("");

    var msgHtml = locked
      ? '<span class="r32-lockico" aria-hidden="true">🔒</span> Låst på ' + esc(r32FixLabel(g, fx))
      : r32MsgHtml(g);
    var msgCls = "r32-gmsg" + (locked ? " locked" : "");

    var row = '<div class="r32-game' + (star ? " star" : "") + (locked ? " islocked" : "") + '">' +
      '<div class="r32-gtop">' +
        '<span class="r32-gpill grp-' + g.group + '">' + g.group + '</span>' +
        '<div class="r32-gnames">' + esc(r32SvName(g.home)) + ' – ' + esc(r32SvName(g.away)) +
          (star ? ' <span class="r32-gstar" title="Matchen som påverkar dig mest">⭐</span>' : '') +
          (msgHtml ? '<div class="' + msgCls + '">' + msgHtml + '</div>' : '') + '</div>' +
        '<div class="r32-chips">' + chips +
          '<button type="button" class="r32-exp" data-r32-expand="' + g.id + '" title="Välj exakt resultat">' +
            (open ? "▾" : "▸") + '</button>' +
        '</div>' +
      '</div>' +
      (open ? r32ScoreMatrix(g, base, fx) : "") +
    '</div>';
    return row;
  }

  function r32FixLabel(g, fx) {
    if (fx[0] === "score") return fx[1] + "–" + fx[2];
    return { "1": r32SvName(g.home) + " vinner", "X": "oavgjort", "2": r32SvName(g.away) + " vinner" }[fx[1]];
  }

  // Pedagogiskt radtips för en match: visar bara något när resultatet faktiskt
  // spelar roll för det valda laget. "målskillnad avgör" visas som egen tagg.
  function r32MsgHtml(g) {
    var m = g.message;
    if (!m || m.kind !== "cheer") return "";
    var teamSv = esc(r32TeamByKey(r32TeamKey).team.sv);
    var txt = m.best === "X"
      ? "Bäst för " + teamSv + ": oavgjort"
      : "Bäst för " + teamSv + ": " + esc(r32SvName(m.best === "1" ? g.home : g.away)) + " vinner";
    if (g.score_matters) txt += ' <span class="r32-gtag">målskillnad avgör</span>';
    return txt;
  }

  function r32ResultTip(g, r) {
    var head = { "1": r32SvName(g.home) + " vinner", "X": "Oavgjort", "2": r32SvName(g.away) + " vinner" }[r];
    var s = '<h4>' + esc(head) + '</h4>' + r32TipBody(g.results[r], g.base_good);
    if ((g.score_flags || {})[r]) s += '<span class="warn">⚠ målskillnaden avgör – öppna ▸</span>';
    return s;
  }

  function r32ScoreMatrix(g, base, fx) {
    var occ = {}; (g.scores_occ || []).forEach(function (s) { occ[s.h + "-" + s.a] = s.p; });
    var byScore = {}; (g.scores || []).forEach(function (s) { byScore[s.h + "-" + s.a] = s; });
    var cap = 6;
    var maxH = Math.min(cap, Math.max.apply(null, (g.scores_occ || [{ h: 0 }]).map(function (s) { return s.h; })));
    var maxA = Math.min(cap, Math.max.apply(null, (g.scores_occ || [{ a: 0 }]).map(function (s) { return s.a; })));
    var head = '<tr><th class="corner">' + esc(r32SvName(g.home)) + ' ↓<br>' + esc(r32SvName(g.away)) + ' →</th>';
    for (var a = 0; a <= maxA; a++) head += '<th>' + a + '</th>';
    head += '</tr>';
    var rows = "";
    for (var h = 0; h <= maxH; h++) {
      rows += '<tr><th>' + h + '</th>';
      for (var a2 = 0; a2 <= maxA; a2++) {
        var key = h + "-" + a2, p = occ[key];
        if (p == null) { rows += '<td class="empty"></td>'; continue; }
        var info = byScore[key] || {};
        var sel = fx && fx[0] === "score" && fx[1] === h && fx[2] === a2;
        var style = r32ImpactStyle(info.good_shrunk != null ? info.good_shrunk - base : null);
        var cls = "r32-cell" + (sel ? " sel" : "") + (h === a2 ? " diag" : "") +
          (info.n != null && info.n < 80 ? " lowdata" : "") + (info.good_shrunk == null ? " nodata" : "");
        var tip = r32TipId(r32ScoreTip(g, h, a2, info, base));
        rows += '<td><button type="button" class="' + cls + '" data-r32-gid="' + g.id +
          '" data-r32-h="' + h + '" data-r32-a="' + a2 + '"' + (style ? ' style="' + style + '"' : '') +
          ' data-r32-tip="' + tip + '">' + h + '–' + a2 + '<span class="sp">' + r32Pct(p) + '</span></button></td>';
      }
      rows += '</tr>';
    }
    return '<div class="r32-matrix"><table>' + head + rows + '</table></div>';
  }

  function r32ScoreTip(g, h, a, info, base) {
    return '<h4>' + esc(r32SvName(g.home)) + ' ' + h + '–' + a + ' ' + esc(r32SvName(g.away)) + '</h4>' +
      r32TipBody(info, base);
  }

  /* ---------- interaktion ---------- */
  function r32SetTeam(key) {
    if (key === r32TeamKey) return;
    r32TeamKey = key; r32Fixed = {}; r32OpenGrids = {};
    // uppdatera väljarens markering + snabbtabbar utan full omritning
    var sl = document.getElementById("r32-team"); if (sl) sl.value = key;
    document.querySelectorAll(".r32-quick").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-r32-tab") === key);
    });
    var sel = r32TeamByKey(key);
    var titleEl = document.getElementById("r32-title"); if (titleEl) titleEl.textContent = r32TitleText(sel.team.sv);
    runR32Sim();
  }

  function r32HandleClick(t) {
    if (!legacyR32Open) return false;
    var sortBtn = t.closest && t.closest("[data-r32-sort]");
    if (sortBtn) {
      setUi("r32Sort", sortBtn.getAttribute("data-r32-sort"));
      var grp = sortBtn.parentNode;
      if (grp) grp.querySelectorAll("[data-r32-sort]").forEach(function (b) {
        var on = b === sortBtn;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      renderR32Games();
      return true;
    }
    var tab = t.closest && t.closest("[data-r32-tab]");
    if (tab) { r32SetTeam(tab.getAttribute("data-r32-tab")); return true; }
    if (t.closest && t.closest("[data-r32-reset]")) {
      r32Fixed = {}; r32OpenGrids = {}; runR32Sim(); return true;
    }
    var exp = t.closest && t.closest("[data-r32-expand]");
    if (exp) {
      var gid = exp.getAttribute("data-r32-expand");
      if (r32OpenGrids[gid]) delete r32OpenGrids[gid]; else r32OpenGrids[gid] = true;
      renderR32Games(); return true;
    }
    var cell = t.closest && t.closest("[data-r32-h]");
    if (cell) {
      var cgid = cell.getAttribute("data-r32-gid");
      var ch = parseInt(cell.getAttribute("data-r32-h"), 10), ca = parseInt(cell.getAttribute("data-r32-a"), 10);
      var cur = r32Fixed[cgid];
      if (cur && cur[0] === "score" && cur[1] === ch && cur[2] === ca) delete r32Fixed[cgid];
      else r32Fixed[cgid] = ["score", ch, ca];
      runR32Sim(); return true;
    }
    var chip = t.closest && t.closest("[data-r32-r]");
    if (chip) {
      var ggid = chip.getAttribute("data-r32-gid"), rr = chip.getAttribute("data-r32-r");
      var c2 = r32Fixed[ggid];
      if (c2 && c2[0] === "result" && c2[1] === rr) delete r32Fixed[ggid];
      else r32Fixed[ggid] = ["result", rr];
      runR32Sim(); return true;
    }
    return false;
  }

  /* ====================================================================
     SLUTSPELSKALKYLATORN  (egen vy via top-navet, route "r32")
     Kör HELA slutspelsträdet (assets/bracketengine.js) med ett valt fokuslag
     och ritar en vertikal "resa": Gruppspel → Sextondel → Åttondel → Kvart →
     Semi → Final. Per steg visas chansen att ta sig dit + troligaste
     motståndare (givet att man når dit) + din uppskattade vinstchans. En ren
     kontrollpanel låter dig klicka i hur kvarvarande gruppmatcher slutar.
  ==================================================================== */
  var CALC_POSLBL = { 1: "Vinner gruppen", 2: "Tvåa", 3: "Trea" };

  function setCalcStatus(txt) {
    var el = document.getElementById("calc-status");
    if (el) el.textContent = txt || "";
  }

  // Uppskattad vinstchans i en match: logistisk på styrkan ur vinnarodds (samma
  // modell + K som motorn). Saknas styrka faller den tillbaka på FIFA-ranking.
  function calcWinP(aName, bName) {
    if (bracketStrength && bracketStrength[aName] != null && bracketStrength[bName] != null) {
      return 1 / (1 + Math.exp(-0.6 * (bracketStrength[aName] - bracketStrength[bName])));
    }
    var map = r32EnglishToTeam(), ta = map[aName], tb = map[bName];
    if (!ta || !tb) return null;
    var f = function (x) { return 1500 - 130 * Math.log(x); };
    return 1 / (1 + Math.pow(10, (f(fifaRankOf(tb)) - f(fifaRankOf(ta))) / 400));
  }

  // Kvarvarande (ej färdigspelade) gruppmatcher med odds, för kontrollpanelen.
  function calcRemainingMatches(odds) {
    var playedPairs = {};
    WC.groupLetters.forEach(function (L) {
      playedPairs[L] = {};
      groupFixtures(L).forEach(function (fx) {
        if (!isFinishedMatch(fx.key, getRes(fx.key))) return;
        playedPairs[L][[fx.h, fx.a].slice().sort(function (a, b) { return a - b; }).join(",")] = true;
      });
    });
    var out = [];
    (odds.matches || []).forEach(function (m) {
      if (playedPairs[m.g] && playedPairs[m.g][m.pair]) return;
      out.push({ id: m.id, g: m.g, i: m.i, j: m.j, home: m.home, away: m.away, rp: m.rp });
    });
    return out;
  }

  /* ---------- vy-skelett ---------- */
  function renderCalcView() {
    lastViewSig = null;
    viewEl.innerHTML = '<div class="calc-view">' + calcPanelHtml() + '</div>';
    var sl = document.getElementById("calc-team");
    if (sl) sl.value = r32TeamKey;
    paintCalc();
    return true;
  }

  function calcQuickTab(key) {
    var t = r32TeamByKey(key).team;
    return '<button type="button" class="calc-quick' + (key === r32TeamKey ? " on" : "") +
      '" data-calc-tab="' + key + '">' + flagImg(t.iso) + '<span>' + esc(t.sv) + '</span></button>';
  }

  function calcPanelHtml() {
    var sel = r32TeamByKey(r32TeamKey);
    var optgroups = WC.groupLetters.map(function (L) {
      var opts = WC.groups[L].map(function (t, i) {
        var k = L + ":" + i;
        return '<option value="' + k + '"' + (k === r32TeamKey ? " selected" : "") + '>' + esc(t.sv) + "</option>";
      }).join("");
      return '<optgroup label="Grupp ' + L + '">' + opts + "</optgroup>";
    }).join("");

    return '' +
      '<section class="calc-panel" aria-label="Slutspelskalkylator">' +
        '<div class="calc-head">' +
          '<div class="calc-titlewrap">' +
            '<h3 id="calc-title">Slutspelskalkylator</h3>' +
            '<p class="calc-sub" id="calc-sub">Följ <b>' + esc(sel.team.sv) + '</b> genom slutspelet och se vilka lag de kan möta i varje runda. ' +
              '<span class="calc-status" id="calc-status"></span></p>' +
          '</div>' +
          '<div class="calc-pick">' +
            '<div class="calc-quicktabs">' + calcQuickTab("F:3") + calcQuickTab("H:1") + '</div>' +
            '<label class="calc-select"><span>Lag</span>' +
              '<select id="calc-team">' + optgroups + '</select></label>' +
            '<button type="button" class="calc-reset" data-calc-reset>Återställ</button>' +
          '</div>' +
        '</div>' +
        '<div class="calc-body">' +
          '<div class="calc-board" id="calc-board"></div>' +
          '<div class="calc-boardfoot" id="calc-boardfoot"></div>' +
          '<div class="calc-lower">' +
            '<div class="calc-side" id="calc-side"></div>' +
            '<aside class="calc-controls" id="calc-controls"></aside>' +
          '</div>' +
        '</div>' +
      '</section>';
  }

  function paintCalc() {
    if (r32OddsData === "error") { setCalcStatus("kunde inte hämta data"); return; }
    if (!calcResult) setCalcStatus("laddar …");
    if (!window.BracketEngine) { setCalcStatus("kunde inte räkna ut just nu"); return; }
    bracketEnsureExtras(function () {
      r32EnsureOdds(function () {
        if (!calcOpen) return;
        runCalc();
      });
    });
  }

  function calcEnsureWorker() {
    if (calcWorker) return;
    try {
      calcWorker = new Worker("assets/bracketworker.js?v=6");
      calcWorker.onmessage = function (e) {
        var d = e.data || {};
        if (d.seq !== calcSeq) return;
        if (d.error || !d.result) { setCalcStatus("kunde inte räkna ut just nu"); return; }
        calcResult = d.result; calcKey = d.key;
        renderCalcDynamic();
      };
      calcWorker.onerror = function () { calcWorker = "none"; };
    } catch (err) { calcWorker = "none"; }
  }

  function runCalc() {
    if (!r32OddsData || r32OddsData === "loading" || r32OddsData === "error") return;
    if (!bracketMapData || bracketMapData === "loading" || bracketMapData === "error" || !bracketStrength) return;
    var built = bracketBuildInput(r32OddsData);
    var sel = r32TeamByKey(r32TeamKey);
    built.input.n = CALC_N;
    built.input.focalTeam = sel.team.name;
    var key = built.key + "|" + sel.team.name + "|" + CALC_N;
    if (calcKey === key && calcResult) { renderCalcDynamic(); return; }
    setCalcStatus("räknar …");
    calcSeq++;
    var seq = calcSeq;
    calcEnsureWorker();
    if (calcWorker && calcWorker !== "none") {
      calcWorker.postMessage({ seq: seq, key: key, input: built.input });
    } else {
      setTimeout(function () {
        if (seq !== calcSeq) return;
        try { calcResult = window.BracketEngine.compute(built.input); calcKey = key; renderCalcDynamic(); }
        catch (err) { setCalcStatus("kunde inte räkna ut just nu"); }
      }, 16);
    }
  }

  /* ---------- dynamiskt innehåll ---------- */
  function renderCalcDynamic() {
    r32TipN = 0; r32TipMap = {};
    setCalcStatus("");
    var sel = r32TeamByKey(r32TeamKey);
    var sub = document.getElementById("calc-sub");
    if (sub) sub.innerHTML = 'Följ <b>' + esc(sel.team.sv) + '</b> genom slutspelet och se vilka lag de kan möta i varje runda – styr själv hur de sista gruppmatcherna slutar. ' +
      '<span class="calc-status" id="calc-status"></span>';
    renderCalcBoard(sel);
    renderCalcBoardFoot(sel);
    renderCalcSide(sel);
    // Bygg inte om kontrollerna medan ett resultatfält redigeras – då skulle
    // inmatningen tappa fokus mitt i skrivandet.
    if (!calcScoreFocused()) renderCalcControls();
  }

  function calcScoreFocused() {
    var a = document.activeElement;
    return !!(a && a.classList && a.classList.contains("calc-score"));
  }

  /* ====================================================================
     HUVUDVY: motståndartavlan – en kolumn per slutspelsrunda (1/16 → final)
     med de troligaste motståndarna, plus en "Vinn VM"-ruta. Bygger helt på
     calcResult.focal: per runda dess reachP (chans att nå dit) och opponents
     (motståndarfördelning GIVET att laget når rundan), samt focal.win.
  ==================================================================== */
  var BOARD_ROUNDS = [
    { key: "r32", title: "1/16-final" },
    { key: "r16", title: "1/8-final" },
    { key: "qf", title: "Kvartsfinal" },
    { key: "sf", title: "Semifinal" },
    { key: "final", title: "Final" }
  ];

  // Procent i tavlan, svensk stil: "60,7" · "100" · "0".
  function calcBoardNum(p) {
    var v = (p || 0) * 100;
    if (v >= 99.95) return "100";
    if (v < 0.05) return "0";
    return (Math.round(v * 10) / 10).toFixed(1).replace(".", ",");
  }

  // En motståndarcell: vertikal styrkemätare + flagga + namn + sannolikhet.
  function calcBoardCell(e, sel, maxP, isTop) {
    var map = r32EnglishToTeam(), t = map[e.nm];
    var dim = e.p < 0.005;
    var barH = Math.max(10, Math.min(100, e.p / maxP * 100)).toFixed(0);
    var win = calcWinP(sel.team.name, e.nm);
    var tip = r32TipId('<h4>' + esc(r32SvName(e.nm)) + '</h4>' +
      '<div class="hl"><b>' + r32Pct(e.p) + '</b> chans att mötas här (om ' + esc(teamSvFixture(sel.team)) + ' når rundan)</div>' +
      (win != null ? '<div>~<b>' + Math.round(win * 100) + '%</b> att ' + esc(teamSvFixture(sel.team)) + ' vinner matchen</div>' : ''));
    return '<div class="cb-cell' + (isTop && !dim ? " top" : "") + (dim ? " dim" : "") + '" data-r32-tip="' + tip + '">' +
        '<span class="cb-bar" style="height:' + barH + '%"></span>' +
        '<span class="cb-flag">' + (t ? flagImg(t.iso) : "") + '</span>' +
        '<span class="cb-nm">' + esc(r32SvName(e.nm)) + '</span>' +
        '<span class="cb-pct"><b>' + calcBoardNum(e.p) + '</b><i>%</i></span>' +
      '</div>';
  }

  function renderCalcBoard(sel) {
    var host = document.getElementById("calc-board");
    if (!host || !calcResult) return;
    var focal = calcResult.focal;
    if (!focal) { host.innerHTML = ""; return; }
    var showN = parseInt(ui("calcBoardN", "8"), 10) || 8;

    var perCol = BOARD_ROUNDS.map(function (r) {
      var data = focal[r.key] || { reachP: 0, opponents: {} };
      return { r: r, reach: data.reachP || 0, entries: calcOppEntries(data.opponents) };
    });
    var maxEntries = perCol.reduce(function (m, c) { return Math.max(m, c.entries.length); }, 0);
    var rowsToShow = Math.min(showN, Math.max(1, maxEntries));
    var anyMore = perCol.some(function (c) { return c.entries.length > rowsToShow; });

    var cols = perCol.map(function (c) {
      var faint = (c.reach < 0.005 || !c.entries.length);
      var maxP = c.entries.length ? (c.entries[0].p || 0.0001) : 0.0001;
      var cells = "";
      for (var i = 0; i < rowsToShow; i++) {
        cells += i < c.entries.length
          ? calcBoardCell(c.entries[i], sel, maxP, i === 0)
          : '<div class="cb-cell ghost" aria-hidden="true"></div>';
      }
      return '<div class="cb-col' + (faint ? " faint" : "") + '">' +
          '<div class="cb-colhead"><span class="cb-round">' + c.r.title + '</span>' +
            '<span class="cb-reach">' + (faint ? "osannolikt" : r32Pct(c.reach) + " når hit") + '</span></div>' +
          '<div class="cb-cells">' + cells + '</div>' +
        '</div>';
    }).join("");

    var expanded = showN > 8;
    var moreBtn = (anyMore || expanded)
      ? '<button type="button" class="cb-more" data-calc-boardmore>' + (expanded ? "Visa färre ▴" : "Visa fler ▾") + '</button>'
      : '';

    var winTip = r32TipId('<h4>' + esc(sel.team.sv) + '</h4><div class="hl"><b>' + r32Pct(focal.win || 0) + '</b> chans att vinna hela VM</div>');
    var winBox = '<div class="cb-win" data-r32-tip="' + winTip + '">' +
        '<div class="cb-win-title">Vinn<br>VM</div>' +
        '<div class="cb-win-trophy" aria-hidden="true">🏆</div>' +
        '<div class="cb-win-pct">' + calcBoardNum(focal.win || 0) + ' <span>%</span></div>' +
      '</div>';

    host.innerHTML = '<div class="cb-wrap">' +
        '<div class="cb-main">' +
          '<h3 class="cb-title">Möjliga motståndare i slutspelet</h3>' +
          '<div class="cb-cols">' + cols + '</div>' +
          moreBtn +
        '</div>' + winBox +
      '</div>';
  }

  // Fotnot + utfällbar förklaring av modellen ("Om beräkningarna").
  function renderCalcBoardFoot(sel) {
    var host = document.getElementById("calc-boardfoot");
    if (!host) return;
    host.innerHTML =
      '<p class="cb-note">Procenten vid varje lag visar hur ofta <b>' + esc(teamSvFixture(sel.team)) +
        '</b> möter just det laget i rundan – räknat bara på de simuleringar där laget faktiskt tar sig dit, ' +
        'inte chansen att laget når dit. Rutan <b>Vinn VM</b> visar den totala chansen att gå hela vägen.</p>' +
      '<button type="button" class="cb-about" data-calc-about aria-expanded="false">Om beräkningarna</button>' +
      '<div class="cb-about-panel" id="calc-about" hidden>' + calcAboutHtml(sel) + '</div>';
  }

  function calcAboutHtml(sel) {
    var nm = esc(teamSvFixture(sel.team));
    return 'Siffrorna kommer från en <b>Monte Carlo-simulering</b>: vi spelar VM tusentals gånger utifrån ' +
      'marknadens vinnarodds och exakt-resultatodds för de kvarvarande gruppmatcherna, med FIFA:s officiella ' +
      'särskiljningsregler och det officiella slutspelsträdet. I varje simulering där ' + nm + ' fortfarande är ' +
      'kvar noteras vilket lag de möter – andelen ger sannolikheten per runda. Når ' + nm + ' bara en runda i ' +
      'ett fåtal av simuleringarna (rundor märkta <b>osannolikt</b>) bygger fördelningen på få utfall och ' +
      'ordningen mellan lagen är då osäker. <b>Vinn VM</b> är hur ofta ' + nm +
      ' vinner hela turneringen. Ändra resultaten under tabellen så räknas allt om direkt.';
  }

  // Sorterade motståndarrader { nm, p } (fallande sannolikhet).
  function calcOppEntries(opps) {
    return Object.keys(opps || {}).map(function (nm) { return { nm: nm, p: opps[nm] }; })
      .sort(function (a, b) { return b.p - a.p; });
  }

  /* ---------- bredvid: grupptabellen ---------- */
  function renderCalcSide(sel) {
    var host = document.getElementById("calc-side");
    if (!host || !calcResult) return;
    var focal = calcResult.focal;
    var advance = focal && focal.r32 ? focal.r32.reachP : 0;
    var gp = (focal && focal.groupPositions) || {};
    var table = computeTable(sel.g);
    var rows = table.map(function (r, pos) {
      var me = r.idx === sel.idx;
      return '<tr' + (me ? ' class="me"' : '') + '>' +
        '<td class="nm">' + (pos + 1) + '. ' + flagImg(r.team.iso) + esc(r.team.sv) + '</td>' +
        '<td>' + r.pld + '</td><td>' + (r.gd >= 0 ? "+" : "") + r.gd + '</td>' +
        '<td>' + r.gf + '</td><td>' + r.pts + '</td></tr>';
    }).join("");
    var poschips = [1, 2, 3].map(function (p) {
      return '<span class="calc-poschip"><b>' + r32Pct(gp[p] || 0) + '</b> ' + CALC_POSLBL[p] + '</span>';
    }).join("") + '<span class="calc-poschip out"><b>' + r32Pct(Math.max(0, 1 - advance)) + '</b> Åker ut</span>';

    host.innerHTML = '<div class="calc-card calc-groupcard">' +
        '<div class="calc-cardhead">' +
          '<span class="calc-round">Grupp ' + sel.g + '</span>' +
          '<span class="calc-reach"><b>' + r32Pct(advance) + '</b> går vidare</span>' +
        '</div>' +
        '<div class="calc-reachbar"><div class="fill" style="width:' + (advance * 100).toFixed(1) + '%"></div></div>' +
        '<table class="calc-standings"><tr><th class="nm">Lag</th><th>S</th><th>MV</th><th>GM</th><th>P</th></tr>' + rows + '</table>' +
        '<div class="calc-poschips">' + poschips + '</div>' +
      '</div>';
  }

  /* ---------- interaktiva kontroller: klicka eller skriv resultat ---------- */
  function renderCalcControls() {
    var host = document.getElementById("calc-controls");
    if (!host || r32OddsData === "loading" || r32OddsData === "error" || !r32OddsData) return;
    var sel = r32TeamByKey(r32TeamKey);
    var all = calcRemainingMatches(r32OddsData);
    var mine = all.filter(function (m) { return m.g === sel.g; });
    var others = all.filter(function (m) { return m.g !== sel.g; });
    var showAll = ui("calcAllGroups", "0") === "1";
    var nFixed = Object.keys(r32Fixed).length;

    var html = '<div class="calc-controls-head">' +
      '<h4>Spela klart matcherna</h4>' +
      '<p>Klicka på <b>1</b> / <b>X</b> / <b>2</b> eller skriv in ett exakt resultat – tabellen och motståndaren räknas om direkt.' +
      (nFixed ? ' <button type="button" class="calc-clear" data-calc-reset>Nollställ (' + nFixed + ')</button>' : '') +
      '</p></div>';

    if (!all.length) {
      html += '<div class="calc-faint">Alla gruppmatcher är spelade.</div>';
    } else {
      if (mine.length) {
        html += '<div class="calc-ctrl-group"><div class="calc-ctrl-grouptitle">' + esc(sel.team.sv) + 's grupp (' + sel.g + ')</div>' +
          mine.map(calcMatchRow).join("") + '</div>';
      }
      if (others.length) {
        html += '<div class="calc-ctrl-group">' +
          '<button type="button" class="calc-ctrl-grouptitle toggle" data-calc-allgroups aria-expanded="' + (showAll ? "true" : "false") + '">' +
            'Övriga matcher (påverkar motståndaren) <span class="chev">' + (showAll ? "▾" : "▸") + '</span></button>' +
          (showAll ? others.map(calcMatchRow).join("") : "") +
        '</div>';
      }
    }
    host.innerHTML = html;
  }

  function calcMatchRow(m) {
    var map = r32EnglishToTeam();
    var fx = r32Fixed[m.id];
    var th = map[m.home], ta = map[m.away];
    var sh = (fx && fx[0] === "score") ? fx[1] : "";
    var sa = (fx && fx[0] === "score") ? fx[2] : "";
    var result = null;
    if (fx) {
      if (fx[0] === "result") result = fx[1];
      else if (fx[0] === "score") result = fx[1] > fx[2] ? "1" : (fx[1] === fx[2] ? "X" : "2");
    }

    var opts = ["1", "X", "2"].map(function (r) {
      var on = result === r;
      return '<button type="button" class="calc-opt' + (on ? " on" : "") + '" data-calc-res="' + m.id + '" data-calc-r="' + r + '">' +
        '<span class="cm-r">' + r + '</span><span class="cm-p">' + r32Pct(m.rp[r]) + '</span></button>';
    }).join("");

    var p1 = m.rp["1"] || 0, px = m.rp["X"] || 0, p2 = m.rp["2"] || 0;
    var oddsbar = '<div class="calc-oddsbar" title="Sannolikhet 1 / X / 2">' +
      '<span class="seg s1" style="width:' + (p1 * 100).toFixed(1) + '%"></span>' +
      '<span class="seg sx" style="width:' + (px * 100).toFixed(1) + '%"></span>' +
      '<span class="seg s2" style="width:' + (p2 * 100).toFixed(1) + '%"></span></div>';

    var teams = '<div class="calc-match-teams">' +
        '<span class="cm-side home">' + (th ? flagImg(th.iso) : "") +
          '<span class="cm-nm">' + esc(th ? teamSvFixture(th) : r32SvName(m.home)) + '</span></span>' +
        '<span class="cm-score">' +
          '<input class="calc-score" type="text" inputmode="numeric" maxlength="2" data-calc-score="' + m.id + '" data-side="h" value="' + sh + '" aria-label="Mål hemmalag">' +
          '<span class="cm-dash">–</span>' +
          '<input class="calc-score" type="text" inputmode="numeric" maxlength="2" data-calc-score="' + m.id + '" data-side="a" value="' + sa + '" aria-label="Mål bortalag">' +
        '</span>' +
        '<span class="cm-side away"><span class="cm-nm">' + esc(ta ? teamSvFixture(ta) : r32SvName(m.away)) + '</span>' +
          (ta ? flagImg(ta.iso) : "") + '</span>' +
      '</div>';

    return '<div class="calc-match' + (fx ? " locked" : "") + '" data-calc-mid="' + m.id + '">' +
      teams + oddsbar +
      '<div class="calc-match-opts">' + opts + '</div></div>';
  }

  // Inmatning i ett resultatfält: båda målen krävs för att låsa ett exaktresultat.
  function calcScoreInput(input) {
    var v = input.value.replace(/[^0-9]/g, "").slice(0, 2);
    if (v !== input.value) input.value = v;
    var id = input.getAttribute("data-calc-score");
    var row = input.closest && input.closest("[data-calc-mid]");
    if (!row) return;
    var hEl = row.querySelector('.calc-score[data-side="h"]');
    var aEl = row.querySelector('.calc-score[data-side="a"]');
    var hs = hEl ? hEl.value.trim() : "";
    var as = aEl ? aEl.value.trim() : "";
    if (hs === "" && as === "") {
      if (r32Fixed[id]) { delete r32Fixed[id]; runCalc(); }
      return;
    }
    if (hs === "" || as === "") return; // vänta tills båda fyllts i
    var h = parseInt(hs, 10), a = parseInt(as, 10);
    if (isNaN(h) || isNaN(a)) return;
    var cur = r32Fixed[id];
    if (cur && cur[0] === "score" && cur[1] === h && cur[2] === a) return;
    r32Fixed[id] = ["score", h, a];
    runCalc();
  }

  /* ---------- interaktion ---------- */
  function calcSetTeam(key) {
    if (key === r32TeamKey) return;
    r32TeamKey = key;
    var sl = document.getElementById("calc-team"); if (sl) sl.value = key;
    document.querySelectorAll(".calc-quick").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-calc-tab") === key);
    });
    runCalc();
  }

  function calcHandleClick(t) {
    if (!calcOpen) return false;
    var tab = t.closest && t.closest("[data-calc-tab]");
    if (tab) { calcSetTeam(tab.getAttribute("data-calc-tab")); return true; }
    if (t.closest && t.closest("[data-calc-reset]")) {
      r32Fixed = {}; renderCalcControls(); runCalc(); return true;
    }
    if (t.closest && t.closest("[data-calc-allgroups]")) {
      setUi("calcAllGroups", ui("calcAllGroups", "0") === "1" ? "0" : "1");
      renderCalcControls(); return true;
    }
    if (t.closest && t.closest("[data-calc-boardmore]")) {
      setUi("calcBoardN", ui("calcBoardN", "8") === "8" ? "16" : "8");
      renderCalcBoard(r32TeamByKey(r32TeamKey)); return true;
    }
    var about = t.closest && t.closest("[data-calc-about]");
    if (about) {
      var panel = document.getElementById("calc-about");
      if (panel) {
        var open = panel.hasAttribute("hidden");
        if (open) panel.removeAttribute("hidden"); else panel.setAttribute("hidden", "");
        about.setAttribute("aria-expanded", open ? "true" : "false");
      }
      return true;
    }
    var res = t.closest && t.closest("[data-calc-res]");
    if (res) {
      var id = res.getAttribute("data-calc-res"), r = res.getAttribute("data-calc-r");
      var cur = r32Fixed[id];
      if (cur && cur[0] === "result" && cur[1] === r) delete r32Fixed[id];
      else r32Fixed[id] = ["result", r];
      renderCalcControls(); runCalc(); return true;
    }
    return false;
  }

  // Mest sannolika laget i en fördelning (eller null).
  function topNameOf(dist) {
    if (!dist) return null;
    var bestName = null, bestP = -1;
    Object.keys(dist).forEach(function (n) {
      if (dist[n] > bestP) { bestP = dist[n]; bestName = n; }
    });
    return bestName;
  }

  // Vilken runda matar in i en given runda (barn-positioner = 2p, 2p+1).
  var BRACKET_PREV_ROUND = { r16: "r32", qf: "r16", sf: "qf", final: "sf" };
  var bracketFavCache = null;     // "round:pos" -> lagnamn (oddsfavorit i trädet)

  // Oddsfavoriten i en trädposition – KONSEKVENT uppåt i trädet: en plats kan
  // bara visa ett lag som också är favorit i en av de två matande platserna
  // (annars dök t.ex. Portugal upp i en kvartsfinal utan att synas i någon av
  // åttondelsfinalerna som leder dit). Leder (r32/brons) använder marginalen.
  function bracketFavName(round, pos) {
    if (!bracketProbs || !bracketProbs.nodes) return null;
    if (!bracketFavCache) bracketFavCache = {};
    var key = round + ":" + pos;
    if (key in bracketFavCache) return bracketFavCache[key];
    var dist = bracketProbs.nodes[round] && bracketProbs.nodes[round][pos];
    var prev = BRACKET_PREV_ROUND[round];
    var result;
    if (!prev) {
      result = topNameOf(dist);                       // löv (r32) eller brons
    } else {
      var a = bracketFavName(prev, pos * 2);
      var b = bracketFavName(prev, pos * 2 + 1);
      var pa = (dist && a && dist[a] != null) ? dist[a] : -1;
      var pb = (dist && b && dist[b] != null) ? dist[b] : -1;
      if (pa < 0 && pb < 0) {
        // Ingen av de matande favoriterna finns kvar i den här nodens (beskurna)
        // fördelning. Falla ALDRIG tillbaka till nodens egen topp – då kan ett lag
        // dyka upp i t.ex. en kvartsfinal utan att synas i någon av åttondelarna
        // som leder dit. Välj i stället den matande favorit som är starkast i sin
        // egen ruta, så att vägen genom trädet alltid hänger ihop.
        var prevNodes = bracketProbs.nodes[prev] || [];
        var na = prevNodes[pos * 2], nb = prevNodes[pos * 2 + 1];
        var qa = (na && a && na[a] != null) ? na[a] : -1;
        var qb = (nb && b && nb[b] != null) ? nb[b] : -1;
        result = qa >= qb ? (a || b) : (b || a);
      } else {
        // Den av de två matande favoriterna som troligast tar sig hit visas.
        result = pa >= pb ? a : b;
      }
    }
    bracketFavCache[key] = result || null;
    return bracketFavCache[key];
  }

  // Mest sannolika laget för en matchsida enligt prob-noderna (eller null).
  function nodeTopSide(matchNo, which) {
    if (!bracketProbs || !bracketProbs.nodes) return null;
    if (!bracketPosByMatch) bracketPosByMatch = buildBracketPosMap();
    var pos = bracketPosByMatch[matchNo];
    if (!pos) return null;
    var p = which === "home" ? pos.home : pos.away;
    var bestName = bracketFavName(pos.round, p);
    if (!bestName) return null;
    var dist = bracketProbs.nodes[pos.round] && bracketProbs.nodes[pos.round][p];
    var bestP = dist && dist[bestName] != null ? dist[bestName] : null;
    var t = teamByName(bestName);
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

  // Lagsida som ska visas i trädets matchruta enligt visningsläget. Avgjorda
  // platser visar alltid laget. I oddsläget ersätts oavgjorda platser av
  // oddsfavoriten; i seed-läget faller de tillbaka till platsetiketten
  // (eventuellt provisoriskt ledarlag visas alltså inte i seed-läget).
  function displaySide(res, which, usePrediction) {
    var side = which === "home" ? res.home : res.away;
    if (side.team && side.decided) return side;
    if (usePrediction) {
      var pred = nodeTopSide(res.match.m, which);
      if (pred) return pred;
    }
    return { team: null, decided: false, label: side.label };
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

  // Som fmtPct men ärlig vid extremvärden: ett värde som avrundar till 100 men
  // inte ÄR exakt 100 visas som "~100", och ett värde > 0 som avrundar till 0
  // visas som "~0". Används i sannolikhetspanelen där t.ex. 99,94 % annars
  // skulle se ut som ett säkert "100".
  function fmtProbPct(p) {
    if (p >= 1) return "100";
    var v = p * 100;
    if (v >= 99.5) return "~100";
    if (v >= 9.95) return String(Math.round(v));
    if (v >= 0.05) return (Math.round(v * 10) / 10).toString();
    return v > 0 ? "~0" : "0";
  }

  // Lagdetaljerna som visas i det flytande fönstret vid hovring – innehåll per
  // lag förberäknas i updateAside så att det dyker upp utan fördröjning.
  var asideDetails = {};        // detaljnyckel -> färdig HTML

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

  // Kort, enkel och pedagogisk förklaring: vad platsen är + lagets chans, och
  // en konkret hållpunkt (var laget ligger just nu). Detaljerna visas grafiskt
  // i staplarna nedanför, så texten håller sig till två korta meningar.
  function probDetailText(engName, prob, round, slotLabel, ctx, L) {
    var t = teamByName(engName);
    var nm = t ? t.sv : engName;
    var pct = fmtPct(prob) + " %";
    var parts = [];
    var c0 = slotLabel ? slotLabel.charAt(0) : "";

    if (round === "r32" && c0 === "1") {
      parts.push("Platsen tillhör vinnaren av grupp " + slotLabel.slice(1) + ". " +
        nm + " vinner gruppen i " + pct + " av fallen.");
    } else if (round === "r32" && c0 === "2") {
      parts.push("Platsen tillhör tvåan i grupp " + slotLabel.slice(1) + ". " +
        nm + " blir tvåa i " + pct + ".");
    } else if (round === "r32" && slotLabel && slotLabel.indexOf("3/") === 0) {
      parts.push("Platsen går till en av de bästa grupptreorna. " +
        nm + " tar den i " + pct + ".");
    } else if (round === "bronze") {
      parts.push(nm + " når bronsmatchen i " + pct + " – det kräver en förlorad semifinal.");
    } else {
      var rn = { r16: "åttondelsfinal", qf: "kvartsfinal", sf: "semifinal", final: "final" }[round] || "den här matchen";
      parts.push(nm + " når " + rn + " i " + pct + ".");
    }

    if (L && ctx.tables[L]) {
      var idx = -1, s = null;
      ctx.tables[L].forEach(function (e, i) { if (t && e.team.iso === t.iso) { idx = i; s = e; } });
      if (s) {
        parts.push("Ligger just nu " + (idx + 1) + ":a i grupp " + L + " med " + s.pts +
          " p efter " + s.pld + " matcher.");
      }
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
    // Hela fördelningens summa (även de minsta som inte listas) – så att
    // "övriga lag <0,1 %" kan visas och ett enda lag på 99,94 % inte ser ut
    // som ett säkert 100 %.
    var total = 0;
    Object.keys(dist || {}).forEach(function (n) { total += dist[n]; });
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
      return '<div class="prob-row" data-detail="' + esc(key) + '">' +
        '<span class="team">' + flagImg(iso) + '<span class="t-name">' + esc(nm) + '</span></span>' +
        '<span class="prob-bar"><span style="width:' + w + '%"></span></span>' +
        '<span class="prob-pct">' + fmtProbPct(e[1]) + ' %</span></div>';
    }).join("");
    // Lag med <0,1 % vardera har sållats bort i datan – men de finns. Visa deras
    // sammanlagda andel som en samlad rad så panelen inte påstår 100 % när det
    // egentligen finns andra möjliga utfall.
    var shown = entries.reduce(function (s, e) { return s + e[1]; }, 0);
    var rest = Math.max(0, (total || shown) - shown);
    if (rest >= 0.0005) {
      rows += '<div class="prob-row prob-row-rest">' +
        '<span class="team"><span class="t-name">Övriga lag</span></span>' +
        '<span class="prob-bar"><span style="width:' + (top > 0 ? Math.round((rest / top) * 100) : 0) + '%"></span></span>' +
        '<span class="prob-pct">' + (rest < 0.001 ? "&lt;0,1" : fmtProbPct(rest)) + ' %</span></div>';
    }
    var lab = slotLabel ? '<div class="prob-slot">' + esc(slotLabelText(slotLabel)) + '</div>' : '';
    return '<div class="prob-col">' + lab + (rows || '<div class="prob-empty">–</div>') + '</div>';
  }

  // Bygger sannolikhetsblocket för en match (båda sidor). Lagdetaljerna
  // förberäknas i asideDetails och visas i ett flytande fönster vid hovring.
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
    var sides = '<div class="prob-sides">' +
      asideProbSide(nodes[pos.home], labels ? labels[pos.home] : null, pos.round, "h", ctx) +
      asideProbSide(nodes[pos.away], labels ? labels[pos.away] : null, pos.round, "a", ctx) +
      '</div>';
    return '<div class="aside-section-title">Sannolikhet att nå hit' + stamp + '</div>' +
      sides +
      '<div class="prob-hover-hint">Håll muspekaren över ett lag för läge och chanser</div>';
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
          bracketFavCache = null;     // ny data → räkna om trädets favoriter
          // Trädet ritar om så att oddsfavoriten i "nästa match"-rundan dyker
          // upp (renderBracket återställer även den öppna infopanelen).
          if (ui("view", "groups") === "bracket") renderBracket();
        }
      })
      .catch(function () { /* tyst – panelen funkar utan */ });
  }

  /* ---------- Lokal slutspelsmotor (hela trädet) ----------
   * Ersätter den servergenererade bracket_probs.json med en beräkning på DIN
   * data: exakt-resultatodds + FIFA 2026-tiebreakers (inbördes först) hela vägen
   * genom gruppspel → Annex C → R32 → final. Live-matcher villkoras på sin
   * aktuella ställning och kvarvarande tid, så siffrorna uppdateras efter varje
   * mål. Faller tillbaka på loadBracketProbs() om motorn/datan saknas. */

  // Ladda bracket-karta (officiellt träd + Annex C) och vinnarodds (styrkeankare).
  function bracketEnsureExtras(cb) {
    if (bracketMapData && bracketMapData !== "loading" && bracketMapData !== "error" && bracketStrength) return cb();
    if (bracketMapData === "loading") return;
    bracketMapData = "loading";
    Promise.all([
      fetch("data/bracket_map.json", { cache: "no-store" }).then(function (r) { return r && r.ok ? r.json() : null; }),
      fetch("data/winner_odds.json", { cache: "no-store" }).then(function (r) { return r && r.ok ? r.json() : null; })
    ]).then(function (res) {
      var map = res[0], wo = res[1];
      if (!map || !map.order || !wo || !wo.teams || !window.BracketEngine) { bracketMapData = "error"; loadBracketProbs(); return; }
      bracketMapData = map;
      winnerOddsStamp = wo.updated || null;
      bracketStrength = window.BracketEngine.strengthsFromOutrights(wo.teams);
      cb();
    }).catch(function () { bracketMapData = "error"; loadBracketProbs(); });
  }

  // Aktuell ställning + andel kvarvarande tid för en LIVE gruppmatch (annars null).
  // Används för att villkora matchen i simuleringen efter varje mål.
  function liveMatchState(key) {
    if (!isMatchLive(key)) return null;
    var lv = apiLive[key] || {};
    // Aktuell ställning: results (uppdateras löpande) är pålitligast, annars live.
    var ch = null, ca = null, rr = getRes(key);
    if (rr && rr.h != null && rr.a != null) { ch = rr.h; ca = rr.a; }
    else { var sc = lv.score || {}; ch = (sc.home != null ? sc.home : sc.h); ca = (sc.away != null ? sc.away : sc.a); }
    if (ch == null || ca == null) return null;
    // Kvarvarande andel av ordinarie tid (90 min). Paus/okänd minut → halva kvar.
    var min = (typeof lv.minute === "number") ? lv.minute : null;
    var st = ((lv.status || (rr && rr.status) || "") + "").toUpperCase();
    var frac;
    if (st === "PAUSED" || st === "HT" || st === "HALFTIME") frac = 0.5;
    else if (min == null) frac = 0.5;
    else frac = Math.max(0.04, Math.min(1, (90 - min) / 90));
    return { h: ch, a: ca, frac: frac };
  }

  // Bygg motorns indata för HELA trädet (lag-agnostiskt). Returnerar { input, key }.
  function bracketBuildInput(odds) {
    var names = {}, fifa = {};
    WC.groupLetters.forEach(function (L) {
      names[L] = WC.groups[L].map(function (t) { return t.name; });
      fifa[L] = WC.groups[L].map(function (t) { return fifaRankOf(t); });
    });

    // Färdigspelade matcher = baslinje (låsta resultat). Samtidigt byggs en karta
    // par → fixtur-nyckel så live-läge kan slås upp för odds-matcherna nedan.
    var played = [], playedPairs = {}, fxKeyByPair = {};
    WC.groupLetters.forEach(function (L) {
      playedPairs[L] = {}; fxKeyByPair[L] = {};
      groupFixtures(L).forEach(function (fx) {
        var pair = [fx.h, fx.a].slice().sort(function (a, b) { return a - b; }).join(",");
        fxKeyByPair[L][pair] = fx.key;
        var r = getRes(fx.key);
        if (!isFinishedMatch(fx.key, r)) return;
        played.push({ g: L, i: fx.h, j: fx.a, gi: r.h, gj: r.a });
        playedPairs[L][pair] = true;
      });
    });

    // Ospelade/pågående matcher med odds = simulerade. Live-matcher villkoras på
    // sin aktuella ställning + kvarvarande tid (Poisson på resterande mål).
    var oddsPairs = {}, oddsGames = [], liveSig = [];
    odds.matches.forEach(function (m) {
      oddsPairs[m.g] = oddsPairs[m.g] || {}; oddsPairs[m.g][m.pair] = true;
      if (playedPairs[m.g] && playedPairs[m.g][m.pair]) return;
      var fxKey = fxKeyByPair[m.g] && fxKeyByPair[m.g][m.pair];
      var live = fxKey ? liveMatchState(fxKey) : null;
      var g = { id: m.id, g: m.g, i: m.i, j: m.j, scores: m.scores, fixed: r32Fixed[m.id] || null };
      g = attachLiveOdds(g, m, live);
      if (live) {
        liveSig.push(m.id + "@" + live.h + "-" + live.a + ":" + (g.live.mode || "prematch"));
      }
      oddsGames.push(g);
    });

    // Ospelade matcher utan odds = neutral modell (ovanligt).
    var neutral = [];
    WC.groupLetters.forEach(function (L) {
      groupFixtures(L).forEach(function (fx) {
        if (isFinishedMatch(fx.key, getRes(fx.key))) return;
        var pk = [fx.h, fx.a].slice().sort(function (a, b) { return a - b; }).join(",");
        if (playedPairs[L][pk] || (oddsPairs[L] && oddsPairs[L][pk])) return;
        neutral.push({ g: L, i: fx.h, j: fx.a });
      });
    });

    // Förväntade mål per lag i varje gruppmatch (ur exakt-resultatoddsen) –
    // underlag för att anpassa lagens anfall/försvar för slutspelsmatcherna.
    var ratingMatches = odds.matches.map(function (m) {
      var muH = 0, muA = 0;
      m.scores.forEach(function (s) { muH += s.h * s.p; muA += s.a * s.p; });
      return { home: m.home, away: m.away, g: m.g, muH: muH, muA: muA };
    });

    var input = {
      n: BRACKET_N, seed: 0x9e3779b9,
      groups: names, fifa: fifa,
      annexC: bracketMapData.annexC, annexSlots: bracketMapData.annexCSlots,
      order: bracketMapData.order, labels: bracketMapData.labels,
      strength: bracketStrength, K: 0.6, ratingMatches: ratingMatches,
      koPlayOrders: buildKoPlayOrders(bracketMapData.r32MatchOrder || []),
      koOdds: buildKoOddsMap(odds.knockout),
      played: played, oddsGames: oddsGames, neutral: neutral
    };
    var key = JSON.stringify({
      n: BRACKET_N,
      pl: played.map(function (p) { return p.g + p.i + p.j + ":" + p.gi + "-" + p.gj; }).sort(),
      og: oddsGames.map(function (g) { return g.id + (g.fixed ? ("=" + g.fixed.join(",")) : ""); }).sort(),
      lv: liveSig.sort(),
      ko: Object.keys(input.koOdds || {}).sort().map(function (k) {
        var e = input.koOdds[k];
        return k + (e.finished ? ("=" + e.winner) : "") + (e.live ? ("@" + e.live.h + "-" + e.live.a) : "");
      }),
      ne: neutral.map(function (g) { return g.g + g.i + g.j; }).sort(),
      od: marketOddsStamp || ""
    });
    return { input: input, key: key };
  }

  function bracketEnsureWorker() {
    if (bracketWorker) return;
    try {
      bracketWorker = new Worker("assets/bracketworker.js?v=6");
      bracketWorker.onmessage = function (e) {
        var d = e.data || {};
        if (d.seq !== bracketSeq) return;       // ett nyare anrop har startats
        if (d.error || !d.result) { loadBracketProbs(); return; }
        applyBracketProbs(d.result, d.key);
      };
      bracketWorker.onerror = function () { bracketWorker = "none"; updateBracketProbs(); };
    } catch (err) { bracketWorker = "none"; }
  }

  function applyBracketProbs(result, key) {
    bracketProbs = result;
    bracketEngKey = key;
    bracketFavCache = null;                      // ny data → räkna om trädets favoriter
    if (ui("view", "groups") === "bracket") renderBracket();
  }

  // Räkna om hela trädet lokalt. Dedupar på indata-nyckeln (ställningar/odds/
  // live-läge) så att den är gratis att anropa ofta, t.ex. var 30:e sekund.
  function updateBracketProbs() {
    if (!window.BracketEngine) { loadBracketProbs(); return; }
    bracketEnsureExtras(function () {
      r32EnsureOdds(function (odds) {
        var built = bracketBuildInput(odds);
        if (bracketEngKey === built.key && bracketProbs) return;
        bracketSeq++;
        var seq = bracketSeq, key = built.key;
        bracketEnsureWorker();
        if (bracketWorker && bracketWorker !== "none") {
          bracketWorker.postMessage({ seq: seq, key: key, input: built.input });
        } else {
          setTimeout(function () {
            if (seq !== bracketSeq) return;
            try { applyBracketProbs(window.BracketEngine.compute(built.input), key); }
            catch (e) { loadBracketProbs(); }
          }, 16);
        }
      });
    });
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

  /* ---------- Repriser i kalendern (SVT Play + TV4 Play) ----------
     Samma data som matchmodalen (data/highlights.json), men visad direkt på
     matchraden: en liten kanalfärgad bricka per kanal med en klickbar ikon
     ("logga") för varje reprislängd som finns – hela matchen, längre och
     kortare sammandrag. Färgen säger vilken kanal (SVT grön, TV4 röd). */
  // Visningsordning för reprislänkarna, från vänster: kortare → längre → hela.
  var CAL_HL_TYPES = ["short", "long", "full"];
  var CAL_HL_LABELS = { full: "Hela matchen", long: "Längre sammandrag", short: "Kortare sammandrag" };
  // Distinkta ikoner per längd: spelcirkel (hela), staplar (längre), blixt (kortare).
  var CAL_HL_ICONS = {
    full: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 8.5l5.5 3.5-5.5 3.5z" fill="currentColor"/></svg>',
    long: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="6" width="13" height="2.4" rx="1.2" fill="currentColor"/><rect x="4" y="10.8" width="16" height="2.4" rx="1.2" fill="currentColor"/><rect x="4" y="15.6" width="9" height="2.4" rx="1.2" fill="currentColor"/></svg>',
    short: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13 2L4 14h6l-1 8 9-12h-6z" fill="currentColor"/></svg>'
  };

  function calHighlightsUrl() {
    var CFG = window.VM_CONFIG || {};
    var u = CFG.staticHighlights || "data/highlights.json";
    return u + (u.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
  }

  function loadCalHighlights() {
    return fetch(calHighlightsUrl(), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.byKey) {
          calHighlights = d.byKey;
          var v = ui("view", "groups");
          // Repriserna syns både i kalendern och i "Nyligen spelat" på startsidan.
          if (v === "calendar") renderCalendar();
          else if (v === "home") renderHome();
        }
      })
      .catch(function () { /* tyst – kalendern funkar utan repriser */ });
  }

  // Ett klipp räknas som tillgängligt om det har en url och inte hunnit gå ut.
  function calWatchAvailable(entry) {
    if (!entry || !entry.url) return false;
    return !(entry.until && new Date(entry.until).getTime() <= Date.now());
  }

  // En klickbar reprislänk. Färgklassen (svt/tv4) säger vilken kanal klippet
  // kommer från – det är så man ser SVT (grön) vs TV4 (röd) i en delad modul.
  function calWatchLink(entry, type, ch) {
    var chCls = ch === "SVT" ? "svt" : "tv4";
    var tip = CAL_HL_LABELS[type] + " · " + ch;
    return '<a class="cal-watch-link ' + chCls + '" href="' + esc(entry.url) + '" target="_blank" rel="noopener noreferrer" ' +
      'title="' + esc(tip) + '" aria-label="' + esc(CAL_HL_LABELS[type] + " på " + ch) + '">' +
      CAL_HL_ICONS[type] + "</a>";
  }

  /* Reprisbrickorna (utan ytterhölje) – läggs in i venue-cellen på samma rad
     som matchen och ersätter där TV-kanalmärket.

     SVT prioriteras PER LÄNGD, inte per match: för varje reprislängd
     (kortare/längre/hela) väljs SVT om den finns, annars TV4. SVT trumfar alltså
     alltid TV4 vid överlapp så det aldrig blir två länkar för samma längd, men
     TV4 fyller luckorna SVT saknar. Det är viktigt eftersom SVT i gruppspelet
     ofta bara lägger upp ett kort sammandrag medan TV4 har hela matchen – med en
     ren "SVT vinner allt"-regel försvann då TV4:s "Hela matchen" helt. Varje
     länk färgas efter sin kanal (SVT grön, TV4 röd). */
  function calWatchInner(key) {
    var hl = calHighlights[key];
    if (!hl) return "";
    var links = "";
    CAL_HL_TYPES.forEach(function (t) {
      if (hl.SVT && calWatchAvailable(hl.SVT[t])) links += calWatchLink(hl.SVT[t], t, "SVT");
      else if (hl.TV4 && calWatchAvailable(hl.TV4[t])) links += calWatchLink(hl.TV4[t], t, "TV4");
    });
    if (!links) return ""; // inga tillgängliga repriser ännu
    return '<span class="cal-watch-ch">' + links + "</span>";
  }

  /* Sändningspill med text – berättar VAD som sänds just nu i stället för den
     lilla ikonbrickan. mode "pre" = försnacket/studion rullar (avspark inte
     passerad ännu), mode "live" = matchen är i gång (direktsändning som går att
     spola till början). data-tv-ko-ms låter startsidan rendera om exakt vid
     avspark så att "Försnack" skiftar till "Direktsändning" av sig själv. */
  function tvBcastPill(url, ch, mode, koMs) {
    var chCls = ch === "SVT" ? "svt" : "tv4";
    var pre = mode === "pre";
    var koAttr = (pre && koMs) ? ' data-tv-ko-ms="' + koMs + '"' : "";
    var txt = pre ? "Försnack" : "Direktsändning";
    var tip = pre
      ? "Försnacket har börjat på " + ch
      : "Se matchen direkt på " + ch + " – går att spola till början";
    var dot = pre
      ? '<span class="tv-bcast-dot" aria-hidden="true"></span>'
      : '<span class="live-dot" aria-hidden="true"></span>';
    return '<a class="tv-bcast tv-bcast-' + (pre ? "pre" : "live") + ' ' + chCls + '"' +
      ' href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"' + koAttr +
      ' title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' +
      dot + '<span class="tv-bcast-txt">' + txt + '</span>' +
      '<span class="tv-bcast-ch">' + ch + '</span></a>';
  }

  /* Livesändningslänk (hela matchen, går att spola till början) för en nyss
     avslutad match där sammandragen ännu inte publicerats. Datat kommer från
     samma highlights-fil som repriserna men under typen "live". I läge "pre"
     (försnack) eller "live" (matchen pågår) renderas i stället en tydlig
     textpill via tvBcastPill. */
  function calLiveWatchLink(entry, ch, mode, koMs) {
    if (mode === "pre" || mode === "live") return tvBcastPill(entry.url, ch, mode, koMs);
    var chCls = ch === "SVT" ? "svt" : "tv4";
    var tip = "Hela matchen · " + ch;
    return '<a class="cal-watch-link cal-watch-live ' + chCls + '" href="' + esc(entry.url) + '" target="_blank" rel="noopener noreferrer" ' +
      'title="' + esc(tip) + '" aria-label="' + esc("Hela matchen på " + ch) + '">' +
      CAL_HL_ICONS.full + "</a>";
  }

  function calLiveWatchInner(key, mode, koMs) {
    var hl = calHighlights[key];
    if (!hl) return "";
    var links = "";
    if (hl.SVT && calWatchAvailable(hl.SVT.live)) links += calLiveWatchLink(hl.SVT.live, "SVT", mode, koMs);
    if (hl.TV4 && calWatchAvailable(hl.TV4.live)) links += calLiveWatchLink(hl.TV4.live, "TV4", mode, koMs);
    if (!links) return "";
    // Textpillerna (försnack/direkt) står själva; ikonbrickorna samlas i en ruta.
    if (mode === "pre" || mode === "live") return links;
    return '<span class="cal-watch-ch">' + links + "</span>";
  }

  /* Djuplänk till själva sändningen för en kanal (om den ligger uppe) – används
     för "titta från början" på pågående matcher. */
  function calLiveWatchDeepUrl(key, ch) {
    var hl = calHighlights[key];
    var c = hl && ch && hl[ch];
    if (c && calWatchAvailable(c.live)) return c.live.url;
    return null;
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

  /** Sändningsstart enligt SVT/TV4-tabla (kan ligga före avspark). */
  function tvAirUTC(key, m) {
    var slot = WC.tvAirTime && WC.tvAirTime[key];
    if (slot) {
      var p = slot.split("|");
      return kickoffUTC({ date: p[0], edt: p[1] }).getTime();
    }
    return kickoffUTC(m).getTime();
  }

  var TV_AIR_WINDOW_MS = 3 * 3600 * 1000;

  /** True när sändningen gått live (tablåtid, SVT/TV4-länk eller matchstatus). */
  function tvBroadcastOnAir(key, m, live) {
    if (live) return true;
    if (key && isMatchLive(key)) return true;
    if (key && calLiveWatchInner(key)) return true;
    if (!key || !m) return false;
    var air = tvAirUTC(key, m);
    var now = Date.now();
    return now >= air && now < air + TV_AIR_WINDOW_MS;
  }

  /** Kanalbricka för en kommande match vars sändning inte gått live ännu –
      samma statiska SVT/TV4-logga som spelade matcher, men märkt med tablå-
      tiden (data-tv-air-ms) så att startsidan/kalendern automatiskt byter ut
      den mot live-länken när sändningen drar i gång. */
  function tvWaitingHtml(ch, key, m) {
    return '<span class="cal-tv ' + (ch === "SVT" ? "svt" : "tv4") + ' tv-waiting"' +
      ' data-tv-air-ms="' + tvAirUTC(key, m) + '">' + ch + "</span>";
  }

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

  /* Gravstensbild per spotlight-lag (visas när drömmen är begravd). */
  var GRAVE_IMG = { se: "assets/grave-se.png", uy: "assets/grave-uy.png" };

  /* ---------- Begravningen: avgör om Sverige/Uruguay åkt ur ---------- */

  /** Förlorade laget matchen? (slutspel avgörs även på straffar via r.pw) */
  function teamLostMatch(isHome, r) {
    if (!r || r.h == null || r.a == null) return false;
    if (r.h === r.a) {
      if (r.pw === "h") return !isHome;
      if (r.pw === "a") return isHome;
      return false; // oavgjort utan straffvinnare slår inte ut någon
    }
    return isHome ? r.h < r.a : r.a < r.h;
  }

  /** Antal hela dagar mellan två "YYYY-MM-DD"-datum (aldrig negativt). */
  function daysBetween(startStr, endStr) {
    var ms = parseDateUTC(endStr).getTime() - parseDateUTC(startStr).getTime();
    return Math.max(0, Math.round(ms / 86400000));
  }

  /** "15 juni". */
  function fmtGraveDay(dateStr) {
    var d = parseDateUTC(dateStr);
    return d.getUTCDate() + " " + MONTHS_LONG[d.getUTCMonth()];
  }

  /** Värdigt datumintervall, t.ex. "15–27 juni 2026" eller "28 juni – 3 juli 2026". */
  function fmtGraveRange(startStr, endStr) {
    var s = parseDateUTC(startStr), e = parseDateUTC(endStr);
    var year = e.getUTCFullYear();
    if (s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth()) {
      return s.getUTCDate() + "–" + e.getUTCDate() + " " + MONTHS_LONG[e.getUTCMonth()] + " " + year;
    }
    return fmtGraveDay(startStr) + " – " + fmtGraveDay(endStr) + " " + year;
  }

  /** Kort dödsorsak till gravstenen. */
  function graveCause(f) {
    if (f.stage === "ko") {
      var rk = f.lastMatch && f.lastMatch.m ? f.lastMatch.m.round : null;
      var round = rk && WC.roundNames[rk] ? WC.roundNames[rk].toLowerCase() : "";
      return round ? "Slogs ut i " + round + "en" : "Utslagen i slutspelet";
    }
    if (f.pos === 4) return "Sist i grupp " + f.group;
    if (f.pos === 3) return "Trea i grupp " + f.group + " – räckte inte hela vägen";
    return "Utslagen i gruppspelet";
  }

  /** Lagets öde: null om laget fortfarande lever, annars gravdata.
      Drömmen "föds" vid första matchen och "dör" den dag laget åker ur. */
  function spotlightFate(iso, ctx) {
    var info = findTeamByIso(iso);
    if (!info) return null;
    var team = info.team, L = info.group;
    var matches = teamMatches(team, L, ctx);
    if (!matches.length) return null;
    var playedMatches = matches.filter(function (m) { return m.played && m.home && m.away; });
    if (!playedMatches.length) return null; // VM har inte börjat för laget ännu

    var startDate = matches[0].date; // första matchen (gruppspelets omgång 1)

    function buildFate(deathDate, stage, lastMatch, pos) {
      return {
        team: team, iso: iso, group: L,
        startDate: startDate, deathDate: deathDate,
        days: daysBetween(startDate, deathDate),
        range: fmtGraveRange(startDate, deathDate),
        stage: stage, pos: pos || null, lastMatch: lastMatch || null
      };
    }

    // 1) Slutspel: senast spelade slutspelsmatch avgör – förlust = begravd.
    var lastKo = null;
    for (var i = playedMatches.length - 1; i >= 0; i--) {
      if (playedMatches[i].kind === "ko") { lastKo = playedMatches[i]; break; }
    }
    if (lastKo && teamLostMatch(lastKo.isHome, lastKo.r)) {
      return buildFate(lastKo.date, "ko", lastKo);
    }

    // 2) Gruppspel klart och laget går inte vidare (fyra, eller trea utan plats).
    if (ctx.groupComplete[L]) {
      var st = ctx.tables[L], pos = 0;
      for (var k = 0; k < st.length; k++) { if (st[k].team === team) { pos = k + 1; break; } }
      var out = (pos === 4) || (pos === 3 && ctx.allComplete && !isThirdQ(ctx, L));
      if (out) {
        var lastGroup = null;
        playedMatches.forEach(function (m) { if (m.kind === "group") lastGroup = m; });
        return buildFate(lastGroup ? lastGroup.date : startDate, "group", lastGroup, pos);
      }
    }
    return null; // lever vidare
  }

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
      // Spoilerfritt: hoppa över matcher från senaste dygnet (även pågående).
      if (isSpoilerHidden(key)) continue;
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
        groupLetter: mm.kind === "group" ? info.group : null,
        channel: channel,
        team: info.team,
        key: key,
        m: m
      };
    }
    return null;
  }

  // Var man kan se sändningen (svensk WC-sändare). Saknas djuplänk per match,
  // så vi länkar till spelartjänstens startsida där den pågående matchen ligger.
  var TV_LIVE_URL = { SVT: "https://www.svtplay.se/", TV4: "https://www.tv4play.se/" };

  /** TV-bricka/livesändningslänk – visas först när sändningen startat enligt
      tablå. Sändningen kan gå live före avspark: då rullar försnacket/studion
      ("Försnack"), och när avsparken passerats skiftar det till matchen
      ("Direktsändning", går att spola till början). */
  function matchTvHtml(key, ch, m, live) {
    if (!ch) return '<span class="cal-tv cal-tv-empty" aria-hidden="true"></span>';
    var onAir = tvBroadcastOnAir(key, m, live);
    if (!onAir) {
      // Sändningen har inte börjat: visa den statiska kanalloggan (SVT/TV4).
      return tvWaitingHtml(ch, key, m);
    }
    var ko = m ? kickoffUTC(m).getTime() : 0;
    var inPlay = !!(live || (key && isMatchLive(key)));
    var pre = !inPlay && ko && Date.now() < ko; // sändning uppe men avspark inte passerad → försnack
    var mode = pre ? "pre" : (inPlay ? "live" : "full");
    var liveInner = key ? calLiveWatchInner(key, mode, ko) : "";
    if (liveInner) return '<span class="cal-watch">' + liveInner + "</span>";
    if (TV_LIVE_URL[ch]) {
      if (mode === "pre" || mode === "live") {
        return '<span class="cal-watch">' + tvBcastPill(TV_LIVE_URL[ch], ch, mode, ko) + "</span>";
      }
      var lbl = "Se matchen live på " + ch;
      return '<a class="cal-tv tv-live ' + (ch === "SVT" ? "svt" : "tv4") +
        '" href="' + TV_LIVE_URL[ch] + '" target="_blank" rel="noopener"' +
        ' title="' + esc(lbl) + '" aria-label="' + esc(lbl) + '">' +
        '<span class="tv-live-ico" aria-hidden="true"></span>' + ch + "</a>";
    }
    return tvChHtml(ch);
  }

  function spotlightTvHtml(ch, live, key, m) {
    return matchTvHtml(key || "", ch, m || { date: "", edt: "" }, !!live);
  }

  /** Ett lag i matchraden – fokuslaget (Sverige/Uruguay) lyfts fram. Flaggan
      vänds inåt mot mitten precis som i hjälten: hemma = namn+flagga, borta =
      flagga+namn (solo = enskilt lag, centrerat). */
  function tsTeamName(name, iso, focusIso, side) {
    var focus = iso && iso === focusIso;
    var flag = '<span class="ts-tflag">' + flagImg(iso) + '</span>';
    var nm = '<span class="ts-tname">' + esc(name) + '</span>';
    side = side || "home";
    var inner = side === "home" ? nm + flag : flag + nm;
    return '<span class="ts-team ts-' + side + (focus ? " is-focus" : "") + '">' + inner + '</span>';
  }

  /** Grupp-/rondetikett – grupper återanvänder den färgade group-pill:en. */
  function tsGroupChip(m) {
    if (m.groupLetter) {
      return '<span class="' + groupPillClass(m.groupLetter, "ts-grp") + '">' + esc(m.label) + '</span>';
    }
    return '<span class="ts-grp ts-grp-round">' + esc(m.label) + '</span>';
  }

  /** En lag-cell i den smala Sverige/Uruguay-remsan (sekundär under hjälten).
      Speglar hjältekortet i miniatyr: topprad (grupp + status), mittrad med
      flaggorna vända mot varandra, och en TV-rad i foten. */
  function teamStripItem(tp) {
    var accent = tp.accent ? ' style="--ts-accent: ' + tp.accent + '"' : "";
    var m = tp.match;
    if (!m) {
      return '<button type="button" class="ts-item is-empty team-open" data-team-open="' + tp.iso + '"' + accent + '>' +
        '<div class="ts-top"><span class="ts-grp ts-grp-round">VM 2026</span>' +
          '<span class="ts-when nm-muted"><span class="ts-when-time">Ingen kommande match</span></span></div>' +
        '<div class="ts-main ts-main-solo">' + tsTeamName(tp.title, tp.iso, tp.iso, "solo") + '</div>' +
        '</button>';
    }
    var status = m.live
      ? '<span class="ts-when is-live"><span class="live-dot"></span><span class="ts-when-time">Pågår nu</span></span>'
      : '<span class="ts-when"><span class="ts-when-time">' + esc(m.whenText) + '</span></span>';
    var teamsTitle = (m.teamsFull && m.teamsFull !== m.teams) ? ' title="' + esc(m.teamsFull) + '"' : "";
    var center = '<span class="ts-vs" aria-hidden="true">' + (m.live ? "–" : "vs") + '</span>';
    // Båda lagen med flagga vänd inåt; fokuslaget framhävt. Fall tillbaka på platt text.
    var teamsInner = m.homeName
      ? tsTeamName(m.homeName, m.homeIso, tp.iso, "home") + center + tsTeamName(m.awayName, m.awayIso, tp.iso, "away")
      : esc(m.teams);
    var inner =
      '<div class="ts-top">' + tsGroupChip(m) + status + '</div>' +
      '<div class="ts-main"' + teamsTitle + '>' + teamsInner + '</div>' +
      '<div class="ts-foot">' + matchTvHtml(m.key, m.channel, m.m, m.live) + '</div>';
    // Med matchnyckel öppnar cellen matchinfo-modalen; annars laget (fallback).
    var open = m.key ? matchOpenAttr(m.key) : { attr: "", cls: "" };
    if (open.attr) {
      return '<div class="ts-item' + (m.live ? " is-live" : "") + open.cls + '"' + accent + open.attr + '>' + inner + '</div>';
    }
    return '<button type="button" class="ts-item team-open' + (m.live ? " is-live" : "") + '" data-team-open="' + tp.iso + '"' + accent + '>' +
      inner + '</button>';
  }

  /** Gravsten-memorial: ersätter lagets kort i remsan när drömmen är begravd. */
  function teamGraveItem(tp) {
    var f = tp.fate;
    var accent = tp.accent ? ' style="--ts-accent: ' + tp.accent + '"' : "";
    var img = GRAVE_IMG[tp.iso] || "";
    var dayWord = f.days === 1 ? "dag" : "dagar";
    var cause = graveCause(f);
    var inner =
      '<img class="grave-stone" src="' + img + '" alt="Gravsten för ' + esc(tp.title) + 's VM-dröm 2026" loading="lazy">' +
      '<span class="grave-epitaph">' +
        '<span class="grave-rip">Vila i frid</span>' +
        '<span class="grave-team">' + esc(tp.title) + '</span>' +
        (cause ? '<span class="grave-cause">' + esc(cause) + '</span>' : "") +
        '<span class="grave-range">' + esc(f.range) + '</span>' +
        '<span class="grave-days">Drömmen varade i <strong>' + f.days + ' ' + dayWord + '</strong></span>' +
      '</span>';
    return '<button type="button" class="ts-item ts-grave team-open" data-team-open="' + tp.iso + '"' +
      accent + ' title="' + esc(tp.title) + ' – ' + esc(f.range) + '">' + inner + '</button>';
  }

  /** Smal spotlight-remsa: nästa relevanta match för Sverige och Uruguay.
      Sekundär – ligger under hjälten och konkurrerar inte med "Match i fokus".
      Har laget åkt ur ersätts kortet av en värdig gravsten. */
  function teamsSpotlightStrip(ctx) {
    var teams = TEAM_SPOTLIGHT.map(function (t) {
      var fate = spotlightFate(t.iso, ctx);
      return {
        title: t.title, iso: t.iso, accent: t.accent,
        fate: fate,
        match: fate ? null : findTeamNextMatch(ctx, t.iso)
      };
    });
    var anyLive = teams.some(function (t) { return t.match && t.match.live; });
    var anyGrave = teams.some(function (t) { return t.fate; });
    var h = '<section class="teams-strip' + (anyLive ? " is-live" : "") + (anyGrave ? " has-grave" : "") +
      '" id="teamsSpotlight" aria-label="Sverige och Uruguay">';
    h += '<span class="ts-strip-title">VM-drömmarna</span>';
    h += '<div class="ts-items">';
    teams.forEach(function (tp) { h += tp.fate ? teamGraveItem(tp) : teamStripItem(tp); });
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

  /* Avslutad match ligger kvar i hjälten 30 min efter (uppskattad) slutsignal –
     med nedräkning till nästa match – sen tar den sedvanliga nästa-match-
     hjälten över. */
  var FOCUS_FT_GRACE_MS = 30 * 60 * 1000;

  /** Grunddata för en kalenderpost (lag, etikett, kanal) – delas av hjälten
      och "Nyligen spelat". Returnerar null om lagen ännu inte är kända. */
  function scheduleFocusEntry(it, ctx) {
    var key, label, home, away, m, channel, groupLetter = null;
    if (it.kind === "group") {
      var fx = it.fx;
      key = fx.key; m = fx;
      home = WC.groups[it.letter][fx.h];
      away = WC.groups[it.letter][fx.a];
      label = "Grupp " + it.letter;
      groupLetter = it.letter;
      channel = tvLookupGroup(fx, home, away);
    } else {
      var res = ctx.resolved[it.m.m];
      key = "k:" + it.m.m;
      m = res.match;
      home = res.home.team;
      away = res.away.team;
      label = koRoundLabel(m);
      channel = tvLookupKo(m);
    }
    if (!home || !away) return null;
    return {
      key: key, label: label, groupLetter: groupLetter,
      home: home, away: away, m: m, channel: channel
    };
  }

  /** Vilken match hjälten ("Match i fokus") ska visa och i vilket läge.
      Hjälten avslöjar aldrig ett resultat direkt: den visar antingen den/de
      pågående matchen/matcherna (med live-länk men dold ställning) eller nästa
      avspark (nedräkning). För pågående matcher krävs ett klick + bekräftelse
      för att se ställningen. Nyss avslutade matcher hamnar i stället i "Nyligen
      spelat" (också utan resultat). Två samtidiga matcher (t.ex. sista
      gruppomgången) returneras båda. */
  function findFocusMatch(ctx) {
    var items = buildSchedule();
    var now = Date.now();
    var live = [], upcoming = [];

    items.forEach(function (it) {
      var entry = scheduleFocusEntry(it, ctx);
      if (!entry) return;
      var key = entry.key;
      // Spoilerfritt läge: dölj matcher från det senaste dygnet helt ur hjälten
      // (även de som just nu spelas) så varken resultat eller "LIVE" avslöjas.
      if (isSpoilerHidden(key)) return;

      var r = getRes(key);
      var ko = kickoffUTC(entry.m).getTime();
      var liveNow = isMatchLive(key);
      var played = !liveNow && isPlayed(r) && !isLiveStatus(r && r.status);
      var lv = apiLive[key];
      entry.ko = ko;
      entry.r = r || {};
      entry.time = entry.m.edt || "";
      entry.minute = lv && lv.minute != null ? lv.minute : null;

      if (liveNow || (!played && now >= ko && now < ko + LIVE_MATCH_MS)) {
        entry.state = "live";
        entry.paused = matchIsPaused(key);
        live.push(entry);
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

  /* "Avslutade matcher": ALLA färdigspelade matcher (ej pågående). Vi läser det
     verkliga resultatet (rawRes) för att veta att matchen är spelad – men visar
     aldrig siffrorna i korten; man får klicka in sig för resultat och repriser.
     Matcher utan publicerad repris tas också med (nyss avslutade), och får i
     stället en livelänk eller en kort notis i repriskolumnen. Sorterad senast
     först (nyast hamnar längst ned i listan via CSS column-reverse). */
  function findRecentMatches(ctx) {
    var items = buildSchedule();
    var now = Date.now();
    var out = [];
    items.forEach(function (it) {
      var entry = scheduleFocusEntry(it, ctx);
      if (!entry) return;
      var ko = kickoffUTC(entry.m).getTime();
      if (ko > now) return;                                // avspark måste ha varit
      var raw = rawRes(entry.key);
      if (!isPlayed(raw)) return;                          // måste ha ett resultat
      if (apiLive[entry.key] || isLiveStatus(raw.status) || isMatchLive(entry.key)) return; // pågår → hjälten
      entry.ko = ko;
      out.push(entry);
    });
    out.sort(function (a, b) { return b.ko - a.ko; });
    return out;
  }

  /* "Kommande matcher": de närmaste matcherna som ännu inte sparkats igång,
     begränsat till samma dag/natt som nästa avspark (~24h-fönster) så att listan
     speglar "Avslutade matcher" men för det som komma skall. Matcher som redan
     lyfts fram i hjälten ("Match i fokus"/"Nästa match") hoppas över så att samma
     match inte visas dubbelt på startsidan. Sorterad tidigast först. */
  function findUpcomingMatches(ctx) {
    var focus = findFocusMatch(ctx);
    var skip = {};
    if (focus.state === "next" || focus.state === "live") {
      focus.matches.forEach(function (e) { skip[e.key] = true; });
    }
    var items = buildSchedule();
    var now = Date.now();
    var out = [];
    var nextKo = Infinity;                                  // absolut nästa avspark (även hjältens)
    items.forEach(function (it) {
      var entry = scheduleFocusEntry(it, ctx);
      if (!entry) return;
      var ko = kickoffUTC(entry.m).getTime();
      if (ko <= now) return;                               // får inte ha sparkats igång
      var raw = rawRes(entry.key);
      if (isPlayed(raw)) return;                           // redan spelad
      if (apiLive[entry.key] || isLiveStatus(raw && raw.status) || isMatchLive(entry.key)) return; // pågår → hjälten
      if (ko < nextKo) nextKo = ko;                        // ankra fönstret på nästa avspark
      if (skip[entry.key]) return;                         // visas redan i hjälten
      entry.ko = ko;
      out.push(entry);
    });
    out.sort(function (a, b) { return a.ko - b.ko; });
    if (out.length && isFinite(nextKo)) {
      // Bara kvällens/nattens matcher: allt fram till nästa förmiddag (svensk
      // tid 12:00). En sen nattmatch (t.ex. 03:00) hör hit, men nästa kvälls
      // matcher (t.ex. 18:00 dagen efter) faller utanför fönstret. VM-matcher
      // spelas aldrig på svensk förmiddag, så middagsgränsen skiljer rent.
      var SWE = 2 * 60 * 60 * 1000;                        // tider lagras som CEST (UTC+2)
      var swed = new Date(nextKo + SWE);                   // svensk väggklocka via UTC-fälten
      var cutoff = Date.UTC(swed.getUTCFullYear(), swed.getUTCMonth(), swed.getUTCDate(), 12) - SWE;
      if (nextKo >= cutoff) cutoff += 24 * 60 * 60 * 1000; // nästa avspark är på kvällen → nästa dags 12:00
      out = out.filter(function (e) { return e.ko < cutoff; });
    }
    return out;
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
    var name = '<span class="fh-name" title="' + esc(team.sv) + '">' + esc(teamSvDisplay(team)) + '</span>';
    return '<div class="fh-team fh-' + side + '">' + (side === "home" ? name + flag : flag + name) + '</div>';
  }

  /** Minutmärkning för ett mål, t.ex. "45+2'" med markör för straff/självmål. */
  function goalMinuteToken(g) {
    var min = (g.minute != null ? g.minute : "") + (g.injuryTime ? "+" + g.injuryTime : "");
    var tok = min !== "" ? min + "'" : "";
    if (g.type === "PENALTY") tok += " (str)";
    else if (g.type === "OWN") tok += " (självmål)";
    return tok;
  }

  /** Alla målskyttar i hjälten – grupperade per lag, en rad per skytt med
      hopslagna minuter (t.ex. "Mbappé 12', 45'"). */
  function focusScorers(e, extraCls) {
    var det = focusDetails[e.key];
    if (!det || !det.goals || !det.goals.length) return "";
    var sides = { h: [], a: [] };
    var idx = { h: {}, a: {} };
    det.goals.forEach(function (g) {
      var side = g.team === "a" ? "a" : "h";
      var name = g.scorer || "Mål";
      if (idx[side][name] == null) {
        idx[side][name] = sides[side].length;
        sides[side].push({ name: name, tokens: [] });
      }
      sides[side][idx[side][name]].tokens.push(goalMinuteToken(g));
    });
    function render(side) {
      return sides[side].map(function (s) {
        return '<span class="fh-sc-line">' +
          '<span class="fh-sc-name">' + esc(s.name) + '</span>' +
          '<span class="fh-sc-min">' + esc(s.tokens.filter(Boolean).join(", ")) + '</span>' +
          '</span>';
      }).join("");
    }
    if (!sides.h.length && !sides.a.length) return "";
    return '<div class="fh-scorers' + (extraCls ? " " + extraCls : "") + '" aria-label="Målskyttar">' +
      '<div class="fh-sc-side fh-sc-home">' + render("h") + '</div>' +
      '<span class="fh-sc-ball" aria-hidden="true">⚽</span>' +
      '<div class="fh-sc-side fh-sc-away">' + render("a") + '</div>' +
      '</div>';
  }

  function focusCountdown(kickoff, id, prefix, above) {
    id = id || "focusTimer";
    prefix = prefix || "fh";
    var p = countdownParts(kickoff);
    return '<div class="fh-countdown' + (above ? " fh-countdown-above" : "") +
      '" id="' + id + '" data-kickoff="' + (kickoff || "") + '" aria-live="polite">' +
      nextMatchTimerUnit(prefix + "-d", p.d, "dygn") +
      nextMatchTimerUnit(prefix + "-h", pad(p.h), "tim") +
      nextMatchTimerUnit(prefix + "-m", pad(p.m), "min") +
      nextMatchTimerUnit(prefix + "-s", pad(p.s), "sek") +
      "</div>";
  }

  /** Grupp-/rondetikett i hjälten – grupper får sin riktiga färg (group-pill). */
  function focusGroupChip(e, cls) {
    if (e.groupLetter) {
      return '<span class="' + groupPillClass(e.groupLetter, cls) + '">' + esc(e.label) + '</span>';
    }
    return '<span class="' + cls + '">' + esc(e.label) + '</span>';
  }

  /** Säkerställ att live/avslutade matcher alltid är klickbara (modalen fyller
      på tomma flikar via pollningen även i glappet vid avspark). Pågående och
      avslutade matcher går via en spoilervarning (data-match-confirm) så att
      resultatet aldrig avslöjas av misstag; kommande matcher öppnas direkt. */
  function focusOpenAttr(e) {
    if (e.state === "live" || e.state === "ft") {
      return {
        attr: ' data-match-confirm="' + e.key + '" role="button" tabindex="0"',
        cls: " match-openable"
      };
    }
    return matchOpenAttr(e.key);
  }

  /** Dolt resultat i hjälten – pips i stället för siffror, plus en liten
      uppmaning om att klicka för att avslöja. */
  function focusHiddenScore(cls) {
    return '<span class="fh-score-hidden ' + (cls || "") + '" aria-label="Resultat dolt – klicka för att visa">' +
      '<span class="fh-hidden-pip" aria-hidden="true"></span>' +
      '<span class="fh-hidden-pip" aria-hidden="true"></span>' +
      '</span>';
  }

  /** "Se matchen live"-länk för en pågående match – samma kanalfärgade knapp
      som i kalendern, fast i hjälteformat. Saknas en sändningslänk (kanalen är
      inte känd än) visar vi i stället en kort, smart platshållartext. */
  function focusWatchLive(e) {
    var ch = e.channel;
    // Föredra djuplänken till själva sändningen (går att spola till början);
    // annars spelartjänstens startsida där den pågående matchen ligger överst.
    var deep = e.key ? calLiveWatchDeepUrl(e.key, ch) : null;
    var url = deep || (ch && TV_LIVE_URL[ch] ? TV_LIVE_URL[ch] : null);
    if (ch && url) {
      var lbl = "Se direktsändningen på " + ch + (deep ? " – går att spola till början" : "");
      return '<a class="fh-watch ' + (ch === "SVT" ? "svt" : "tv4") + '" href="' + esc(url) +
        '" target="_blank" rel="noopener" title="' + esc(lbl) + '" aria-label="' + esc(lbl) + '">' +
        '<span class="live-dot" aria-hidden="true"></span>' +
        '<span class="fh-watch-txt">Direktsändning</span>' +
        '<span class="fh-watch-ch">' + ch + '</span></a>';
    }
    return '<span class="fh-watch is-tba" title="Sändaren är inte spikad än">' +
      '<span class="tv-live-ico" aria-hidden="true"></span>Livesändning meddelas snart</span>';
  }

  /** Stort hjältekort – ett huvudnummer per läge (nästa/pågående/avslutad). */
  function focusBigCard(e, state, kickoff) {
    var open = focusOpenAttr(e);
    var when = whenLabels(e.m);
    // Resultatet döljs alltid på startsidan – klick öppnar varningsrutan.
    var center, status = "";
    if (state === "next") {
      center = '<span class="fh-vs" aria-hidden="true">vs</span>';
    } else {
      center = focusHiddenScore("fh-score");
    }
    if (state === "live") status = focusLiveBadge(e);
    else if (state === "ft") status = '<span class="fh-ftbadge">Färdigspelad</span>';

    var h = '<article class="focus-card fc-' + state + open.cls + '"' + open.attr + '>';
    h += '<div class="fh-top">' +
      '<span class="fh-eyebrow">' + esc(FOCUS_HEADINGS[state].one) + '</span>' +
      '<span class="fh-top-right">' + focusGroupChip(e, "fh-group") + status + '</span>' +
      '</div>';
    if (state === "next") h += focusCountdown(kickoff != null ? kickoff : e.ko, "focusTimer", "fh", true);
    h += '<div class="fh-main">' +
      focusTeamSide(e.home, "home") + center + focusTeamSide(e.away, "away") +
      '</div>';
    if (state === "live" || state === "ft") {
      h += '<div class="fh-reveal-hint">Klicka för att visa resultatet</div>';
    }
    h += '<div class="fh-meta">' +
      '<span class="fh-when">' + esc(when.dateLabel + " · " + when.time) + '</span>' +
      (state === "live" ? "" : matchTvHtml(e.key, e.channel, e.m, false)) +
      '</div>';
    if (state === "live") h += '<div class="fh-watch-row">' + focusWatchLive(e) + '</div>';
    h += '</article>';
    return h;
  }

  /** Kompakt hjältekort när två matcher delar fokus (samtidiga avsparkar).
      Lagen ligger horisontellt bredvid varandra (hemma | mitten | borta),
      i samma anda som "Senaste matchen"-rutan. */
  function focusMiniCard(e, state) {
    var open = focusOpenAttr(e);
    var status = state === "live" ? focusLiveBadge(e)
      : state === "ft" ? '<span class="fm-ft">Slut</span>'
        : '<span class="fm-time">' + esc(e.time || whenLabels(e.m).time) + '</span>';
    // Resultatet döljs alltid på startsidan – klick öppnar varningsrutan.
    var center;
    if (state === "next") {
      center = '<span class="fm-vs" aria-hidden="true">vs</span>';
    } else {
      center = focusHiddenScore("fm-score");
    }
    function teamSide(team, side, cls) {
      var flag = '<span class="fm-flag">' + flagImg(team.iso) + '</span>';
      var name = '<span class="fm-name" title="' + esc(team.sv) + '">' + esc(teamSvFixture(team)) + '</span>';
      return '<span class="fm-team fm-' + side + cls + '">' +
        (side === "home" ? name + flag : flag + name) + '</span>';
    }
    var h = '<article class="focus-mini fm-' + state + open.cls + '"' + open.attr + '>';
    h += '<div class="fm-top">' + focusGroupChip(e, "fm-group") + status + '</div>';
    h += '<div class="fm-teams">' +
      teamSide(e.home, "home", "") + center + teamSide(e.away, "away", "") +
      '</div>';
    if (state === "live" || state === "ft") {
      h += '<div class="fh-reveal-hint fm-reveal-hint">Klicka för att visa resultatet</div>';
    }
    h += '<div class="fm-foot">' +
      (state === "live" ? focusWatchLive(e) : matchTvHtml(e.key, e.channel, e.m, false)) +
      '</div>';
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
        '</div>';
      if (f.state === "next") h += focusCountdown(f.kickoff, "focusTimer", "fh", true);
      h += '<div class="focus-mini-grid">';
      f.matches.forEach(function (e) { h += focusMiniCard(e, f.state); });
      h += '</div>';
    }
    h += '</section>';
    return h;
  }

  /* ---------- "Nyligen spelat" ----------
     Spoilerfri lista över matcher från det senaste dygnet: korten visar lagen
     men aldrig resultatet. Man klickar in på kortet för att se matchen (och
     välja att avslöja resultatet) och repris-ikonerna leder direkt till
     SVT/TV4 precis som i kalendern. */

  /* Reprisbrickorna (SVT/TV4) för ett kort – eller en kort, smart text om
     repriserna ännu inte publicerats. */
  function recentWatchHtml(key) {
    var inner = calWatchInner(key);
    if (inner) return '<span class="cal-watch">' + inner + '</span>';
    // Ingen repris ännu – erbjud livesändningen (hela matchen från början) om
    // den fortfarande ligger kvar, annars en kort notis.
    var live = calLiveWatchInner(key);
    if (live) return '<span class="cal-watch">' + live + '</span>';
    return '<span class="rm-norepris" title="Livesändningen är slut och repriser har inte publicerats ännu">' +
      'Sändning slut · repris dröjer</span>';
  }

  /* En rad i "Nyligen spelat" – byggd som kalenderns matchrader (på rad i
     stället för i ett smalt rutnät) så att långa landsnamn som "Nederländerna"
     och "Elfenbenskusten" får plats utan att radbrytas eller klippas. Längst
     till vänster sitter ett kompakt datum/tid-block i samma navy/röda stil som
     kalenderns datumruta. Resultatet är dolt (inga siffror); man klickar på
     raden för att se matchen, och repriserna ligger till höger precis som i
     kalendern. */
  function recentRow(e, variant) {
    // Variant "next" = kommande match (inget resultat att spoila): klick öppnar
    // matchen direkt. Annars (avslutad) öppnar klicket en varningsruta som låter
    // användaren välja att avslöja resultatet eller avbryta (spoilerskydd).
    var isNext = variant === "next";
    var open = isNext ? matchOpenAttr(e.key) : {
      attr: ' data-match-confirm="' + e.key + '" role="button" tabindex="0"',
      cls: " match-openable"
    };
    var d = parseDateUTC(e.m.date);
    var when = whenLabels(e.m);
    // Kompakt datumrad ("TORS 25 JUN") + klockslag under – tydligt vilken dag
    // matchen spelades utan att skriva ut "fre 26 juni kl 04:00" i klartext.
    var dateTxt = (WEEKDAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " +
      MONTHS[d.getUTCMonth()].slice(0, 3)).toLocaleUpperCase("sv-SE");
    function teamSide(team, side) {
      var flag = '<span class="rp-flag">' + flagImg(team.iso) + '</span>';
      var name = '<span class="rp-name" title="' + esc(team.sv) + '">' + esc(teamSvFixture(team)) + '</span>';
      return '<span class="rp-team rp-' + side + '">' +
        (side === "home" ? name + flag : flag + name) + '</span>';
    }
    var h = '<div class="rp-row' + (isNext ? " rp-row--next" : "") + open.cls + '"' + open.attr + '>';
    // Vänster zon: kompakt datum/tid + gruppbricka. Wrappas så att zonen får
    // samma flexvikt som högerzonen och lagblocket alltid centreras i raden.
    h += '<span class="rp-side rp-side-left">' +
      '<span class="rp-when">' +
        '<span class="rp-date">' + esc(dateTxt) + '</span>' +
        '<span class="rp-time">' + esc(when.time) + '</span></span>' +
      focusGroupChip(e, "rp-group") +
      '</span>';
    h += '<span class="rp-teams">' +
      teamSide(e.home, "home") +
      '<span class="rp-vs" aria-hidden="true">vs</span>' +
      teamSide(e.away, "away") + '</span>';
    // Höger zon: för kommande matcher visas TV-kanalen/sändningen (var man ser
    // matchen), för avslutade matcher reprisbrickorna (SVT/TV4).
    var rightInner = isNext ? matchTvHtml(e.key, e.channel, e.m, false) : recentWatchHtml(e.key);
    h += '<span class="rp-side rp-side-right">' +
      '<span class="rp-watch">' + rightInner + '</span></span>';
    h += '</div>';
    return h;
  }

  /** Sektionerna med nattens (kommande) + avslutade matcher. "Nattens matcher"
      (grön) ligger i en egen ruta direkt under nästa-match-hjälten, och
      "Avslutade matcher" (röd) i en helt egen ruta under den – samma radgrafik
      för båda. Tom sträng om det varken finns kommande eller avslutade matcher
      att visa. */
  function recentMatchesPanel(ctx) {
    var recent = findRecentMatches(ctx);
    var upcoming = findUpcomingMatches(ctx);
    if (!recent.length && !upcoming.length) return "";
    var h = "";
    if (upcoming.length) {
      var un = upcoming.length;
      var uHeading = un === 1 ? "Nattens match" : "Nattens matcher";
      h += '<section class="recent-played recent-played--next" aria-label="Nattens matcher">';
      h += '<div class="rp-head rp-head--next">' +
        '<span class="fh-eyebrow fh-eyebrow--next">' + uHeading + '</span>' +
        '</div>';
      h += '<div class="rp-list rp-list--next">';
      upcoming.forEach(function (e) { h += recentRow(e, "next"); });
      h += '</div>';
      h += '</section>';
    }
    if (recent.length) {
      var n = recent.length;
      var heading = n === 1 ? "Avslutad match" : "Avslutade matcher";
      h += '<section class="recent-played recent-played--ft" aria-label="Avslutade matcher">';
      h += '<div class="rp-head">' +
        '<span class="fh-eyebrow">' + heading + '</span>' +
        '</div>';
      h += '<div class="rp-list">';
      recent.forEach(function (e) { h += recentRow(e); });
      h += '</div>';
      h += '</section>';
    }
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
    updatePanelCountdown("ftNextTimer", "ftn");
    updateTvOnAirState();
  }

  /** När sändningen går live enligt tablå – uppdatera startsidan utan att vänta på poll. */
  function updateTvOnAirState() {
    if (ui("view", "home") !== "home") return;
    var now = Date.now();
    var waiting = document.querySelectorAll(".tv-waiting[data-tv-air-ms]");
    for (var i = 0; i < waiting.length; i++) {
      if (now >= parseInt(waiting[i].getAttribute("data-tv-air-ms"), 10)) {
        lastViewSig = null;
        renderHome();
        return;
      }
    }
    // Försnack → direktsändning: rendera om exakt vid avspark så att brickan skiftar.
    var pre = document.querySelectorAll("[data-tv-ko-ms]");
    for (var j = 0; j < pre.length; j++) {
      if (now >= parseInt(pre[j].getAttribute("data-tv-ko-ms"), 10)) {
        lastViewSig = null;
        renderHome();
        return;
      }
    }
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
      jumpLabel = jumpLive ? "Till matchen som pågår" : "Dagens matcher";
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

  /* Aktivt "hopp" till en matchdag. Vi minns målet en kort stund så att en
     omritning (live-synken ritar om kalendern) eller headerns automatiska
     ihopfällning inte kapar den mjuka scrollen och kastar tillbaka oss till
     toppen mitt i hoppet. */
  var calJumpDate = null;
  var calJumpUntil = 0;
  var calJumpTimer = null;

  function calDayTargetTop(el) {
    var topbar = document.querySelector(".topbar");
    var offset = (topbar ? topbar.offsetHeight : 72) + 8;
    return Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset);
  }

  function applyCalendarJump(smooth) {
    if (!calJumpDate || !viewEl) return;
    var el = viewEl.querySelector('.cal-day[data-date="' + calJumpDate + '"]');
    if (!el) return;
    window.scrollTo({ top: calDayTargetTop(el), left: 0, behavior: smooth ? "smooth" : "instant" });
  }

  function scrollCalendarToDate(dateStr, smooth) {
    if (!dateStr || !viewEl) return;
    calJumpDate = dateStr;
    calJumpUntil = Date.now() + 1600;
    headerScrollLock = true; // håll headern stilla så scrollen inte kapas
    clearTimeout(calJumpTimer);
    calJumpTimer = setTimeout(function () {
      headerScrollLock = false;
      calJumpDate = null;
      syncHeaderCompact(); // sätt rätt header-läge när hoppet landat
    }, 1600);
    requestAnimationFrame(function () { applyCalendarJump(smooth); });
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
    var html = '<div class="page-intro cal-intro">' + pageIntroMainHtml("calendar") + jumpBtn +
      '</div>' +
      '<div class="calendar-layout">' +
      '<div class="cal-shell"><div class="cal">';
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
    var wrote = setViewHtml(html);
    if (wrote) updateNextCountdown();

    if (calScrollPending) {
      calScrollPending = false;
      scrollCalendarTop(); // börja alltid högst upp – knappen tar dig till idag/nästa match
    } else if (calJumpDate && Date.now() < calJumpUntil) {
      // Omritning mitt i ett pågående hopp – återställ målet istället för att
      // låta scrollen studsa tillbaka till toppen.
      requestAnimationFrame(function () { applyCalendarJump(false); });
    }
    if (wrote && calGroupOpen) renderCalGroupPopup();
    return wrote;
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

  function calVenueCell(channel, isNext, watch, key, m) {
    // Finns repriser tar de TV-kanalmärkets plats på matchraden – kanalen
    // framgår ändå av reprisbrickans färg (SVT grön, TV4 röd).
    var slot;
    if (watch) {
      slot = '<span class="cal-watch">' + watch + "</span>";
    } else if (channel && key && m && !tvBroadcastOnAir(key, m, false)) {
      // Sändningen har inte börjat: visa den statiska kanalloggan (SVT/TV4).
      slot = tvWaitingHtml(channel, key, m);
    } else {
      slot = channel ? tvChHtml(channel) : '<span class="cal-tv cal-tv-empty" aria-hidden="true"></span>';
    }
    // En spelad match med repriser är aldrig "nästa", så då behövs ingen
    // Nästa-platshållare – det ger reprisbrickorna plats att ligga på en rad.
    var nextEl = isNext
      ? '<span class="cal-next">Nästa</span>'
      : (watch ? '' : '<span class="cal-next cal-next-slot" aria-hidden="true">Nästa</span>');
    return '<span class="cal-venue' + (watch ? ' has-watch' : '') + '">' +
      nextEl +
      slot +
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
      calVenueCell(tvLookupGroup(fx, th, ta), isNext, calWatchInner(fx.key), fx.key, fx) +
      '</div>';
  }

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
      '<span class="cal-badge ' + m.round + '">' + koRoundLabel(m) + '</span>' +
      '<span class="cal-match">' + hHome + score + hAway + '</span>' +
      calVenueCell(tvLookupKo(m), isNext, calWatchInner("k:" + m.m), "k:" + m.m, m) +
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
        kind: "group", key: fx.key, date: fx.date, edt: null, m: fx,
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
        kind: "ko", key: "k:" + mt.m, date: res.match.date, edt: res.match.edt, m: res.match,
        home: res.home.team, away: res.away.team, isHome: isHome,
        played: res.bothTeams && isPlayed(r), r: r,
        label: koRoundLabel(mt), venue: WC.venues[mt.venue],
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

    // Hook: laguppställningsbläddraren (assets/teamlineups.js) injicerar ett
    // kort där man kan bläddra mellan lagets spelade matcher och se startelvan
    // visualiserad på en plan. Läggs före trupplistan nedan.
    if (window.VMTeamLineups && typeof window.VMTeamLineups.onTeamDrawer === "function") {
      try { window.VMTeamLineups.onTeamDrawer(team, L, drawer, playedMatches); } catch (e) {}
    }

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
    var h = '<div class="tip-head"><b>' + koRoundLabel(m) + '</b></div>';
    h += '<div class="tip-row"><span>📍</span>' + esc(v.stadium) + ', ' + esc(v.city) + ' (' + esc(v.country) + ')</div>';
    h += '<div class="tip-row tip-dim"><span>🏟️</span>' + esc(v.real) + '</div>';

    tipEl.innerHTML = h;
    tipEl.classList.remove("r32");
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
    else if (e.target.id === "calc-team") calcSetTeam(e.target.value);
    else if (e.target.id === "r32-team") r32SetTeam(e.target.value);
    else if (e.target.classList && e.target.classList.contains("calc-score")) calcScoreInput(e.target);
  }

  /* ---------- Spoilervarning på startsidan ----------
     Klick på ett "Nyligen spelat"-kort öppnar inte matchen direkt. I stället
     visas en ruta som frågar om man verkligen vill se resultatet, med ett
     tydligt avbryt-val så att man inte blir spoilad av misstag. */
  var confirmKey = null;
  function openMatchConfirm(key) {
    confirmKey = key;
    var overlay = document.getElementById("matchConfirm");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "matchConfirm";
      overlay.className = "mc-overlay";
      overlay.innerHTML =
        '<div class="mc-box" role="dialog" aria-modal="true" aria-labelledby="mcTitle">' +
          '<div class="mc-ic" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle>' +
            '<line x1="3" y1="3" x2="21" y2="21"></line></svg>' +
          '</div>' +
          '<h3 id="mcTitle" class="mc-title">Vill du se resultatet?</h3>' +
          '<p class="mc-msg" id="mcMsg"></p>' +
          '<div class="mc-actions">' +
            '<button type="button" class="mc-btn mc-cancel" data-mc-cancel>Avbryt</button>' +
            '<button type="button" class="mc-btn mc-reveal" data-mc-reveal>Visa resultatet</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
    }
    var live = isMatchLive(key);
    var msg = overlay.querySelector("#mcMsg");
    if (msg) {
      msg.textContent = live
        ? "Matchen pågår just nu. Öppnar du den avslöjas den aktuella ställningen och matchhändelserna."
        : "Matchen är färdigspelad. Öppnar du den avslöjas resultatet och matchhändelserna.";
    }
    overlay.classList.add("show");
    var btn = overlay.querySelector("[data-mc-cancel]");
    if (btn) btn.focus();
  }
  function closeMatchConfirm() {
    confirmKey = null;
    var overlay = document.getElementById("matchConfirm");
    if (overlay) overlay.classList.remove("show");
  }
  function revealMatchConfirm() {
    var key = confirmKey;
    closeMatchConfirm();
    if (key && window.VMMatchInfo && typeof window.VMMatchInfo.open === "function") {
      window.VMMatchInfo.open(key);
    }
  }

  function onClick(e) {
    var t = e.target;

    if (t.closest && t.closest("[data-mc-cancel]")) { closeMatchConfirm(); return; }
    if (t.closest && t.closest("[data-mc-reveal]")) { revealMatchConfirm(); return; }
    if (t.id === "matchConfirm") { closeMatchConfirm(); return; }

    var nav = t.closest && t.closest("[data-nav]");
    if (nav) {
      if (spoilerPanelOpen()) closeSpoilerPanel();
      var v = nav.getAttribute("data-nav");
      if (v === "calendar") calScrollPending = true;
      if (v !== "calendar") hideCalGroupPopup();
      setUi("view", v);
      hoverMatch = null;
      render();
      return;
    }

    if (r32HandleClick(t)) return;
    if (calcHandleClick(t)) return;
    var sr = t.closest && t.closest(".sr-item");
    if (sr) {
      if (sr.hasAttribute("data-player-id")) openSearchPlayer(sr.getAttribute("data-player-id"));
      else if (sr.hasAttribute("data-team-open")) openTeamByIso(sr.getAttribute("data-team-open"));
      else openTeam(sr.getAttribute("data-team-group"), parseInt(sr.getAttribute("data-team-idx"), 10));
      return;
    }

    var bToggle = t.closest && t.closest("[data-bracket-toggle]");
    if (bToggle) {
      /* En enda på/av-toggle: av = platshållare ("seed"), på = oddsfavoriter.
         Rita bara om trädet (inte hela vyn) så att scroll-läget och den
         hopfällda toppheadern bevaras – annars hoppar sidan vid växling. */
      setUi("bracketMode", bracketMode() === "odds" ? "seed" : "odds");
      renderBracket();
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

    // En riktig länk (t.ex. "se live på SVT/TV4") ska bara följa sin href –
    // inte även öppna matchinfo-modalen.
    if (t.closest && t.closest("a[href]")) return;

    // klick på "Nyligen spelat"-kort → fråga först (spoilerskydd)
    var confirmEl = t.closest && t.closest("[data-match-confirm]");
    if (confirmEl) {
      openMatchConfirm(confirmEl.getAttribute("data-match-confirm"));
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

  // Hovring i sannolikhetslistan → visa lagets detaljer i ett flytande fönster
  // bredvid sidopanelen (i stället för längre ner i samma ruta).
  function onProbHover(e) {
    var row = e.target.closest && e.target.closest(".prob-row[data-detail]");
    if (!row) return;
    var pop = document.getElementById("probPopup");
    if (!pop) return;
    var key = row.getAttribute("data-detail");
    var html = asideDetails[key];
    if (html == null) return;
    if (pop.getAttribute("data-key") !== key) {
      pop.innerHTML = html;
      pop.setAttribute("data-key", key);
    }
    document.querySelectorAll("#bracketAside .prob-row.active").forEach(function (r) {
      r.classList.remove("active");
    });
    row.classList.add("active");
    positionProbPopup(row);
    pop.classList.add("show");
  }

  // Dölj detaljfönstret när muspekaren lämnar lagraderna (men inte när den
  // bara flyttas mellan två rader).
  function onProbOut(e) {
    var to = e.relatedTarget;
    if (to && to.closest && to.closest(".prob-row[data-detail]")) return;
    hideProbPopup();
  }

  function hideProbPopup() {
    var pop = document.getElementById("probPopup");
    if (pop) { pop.classList.remove("show"); pop.removeAttribute("data-key"); }
    document.querySelectorAll("#bracketAside .prob-row.active").forEach(function (r) {
      r.classList.remove("active");
    });
  }

  // Placera fönstret bredvid sidopanelen (åt skärmens mitt). Får det inte plats
  // vid sidan (smal skärm/bottenpanel) centreras det ovanför panelen i stället.
  function positionProbPopup(row) {
    var pop = document.getElementById("probPopup");
    var aside = document.getElementById("bracketAside");
    if (!pop || !aside) return;
    pop.style.maxHeight = "";
    var vw = window.innerWidth, vh = window.innerHeight;
    var margin = 10, gap = 12;
    var ar = aside.getBoundingClientRect();
    var pw = pop.offsetWidth || 320;
    var roomLeft = ar.left - margin;
    var roomRight = vw - ar.right - margin;
    var asideOnRight = ar.left >= vw - ar.right;
    var left, beside = true;
    if (asideOnRight && roomLeft >= pw + gap) left = ar.left - gap - pw;
    else if (!asideOnRight && roomRight >= pw + gap) left = ar.right + gap;
    else if (roomLeft >= pw + gap) left = ar.left - gap - pw;
    else if (roomRight >= pw + gap) left = ar.right + gap;
    else beside = false;

    var ph = pop.offsetHeight;
    var maxH = vh - 2 * margin;
    if (ph > maxH) { pop.style.maxHeight = maxH + "px"; ph = maxH; }

    var top;
    if (beside) {
      var rr = row.getBoundingClientRect();
      top = rr.top;
    } else {
      left = (vw - pw) / 2;
      if (ar.top - gap - ph >= margin) top = ar.top - gap - ph;          // ovanför bottenpanelen
      else if (ar.bottom + gap + ph <= vh - margin) top = ar.bottom + gap; // under topp-panelen
      else top = (vh - ph) / 2;
    }
    left = Math.max(margin, Math.min(left, vw - pw - margin));
    top = Math.max(margin, Math.min(top, vh - ph - margin));
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function onOver(e) {
    var mc = e.target.closest && e.target.closest("[data-m]");
    if (mc) {
      var no = parseInt(mc.getAttribute("data-m"), 10);
      if (ui("view", "groups") === "bracket") setBracketLineage(no);
      showTip(no, e.clientX, e.clientY);
      return;
    }
    var rt = e.target.closest && e.target.closest("[data-r32-tip]");
    if (rt) {
      var html = r32TipMap[rt.getAttribute("data-r32-tip")];
      if (html != null) { tipEl.innerHTML = html; tipEl.classList.add("show", "r32"); positionTip(e.clientX, e.clientY); }
    }
  }
  function onMove(e) {
    if (tipEl.classList.contains("show")) positionTip(e.clientX, e.clientY);
  }
  function onOut(e) {
    var mc = e.target.closest && e.target.closest("[data-m]");
    if (mc && (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest("[data-m]"))) {
      hideTip();
      if (hoverLineage != null) setBracketLineage(null);
    }
    var rt = e.target.closest && e.target.closest("[data-r32-tip]");
    if (rt && (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest("[data-r32-tip]"))) {
      tipEl.classList.remove("show", "r32");
    }
  }

  function onDocClick(e) {
    if (!e.target.closest || !e.target.closest(".search")) {
      var box = document.getElementById("searchResults");
      if (box) { box.hidden = true; }
    }
    // Spoilerskydd-panelen: stäng vid klick utanför panel/knapp.
    if (spoilerPanelOpen() && e.target.closest &&
        !e.target.closest("#spoilerPanel") && !e.target.closest("#spoilerBtn")) {
      closeSpoilerPanel();
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

  /* ====================================================================
     SPOILERSKYDD (header) – ersätter gamla på/av-switchen "Dölj resultat".
     En knapp i headern öppnar en panel där man väljer hur mycket som visas:
       • Av – allt live & aktuellt.
       • Senaste dygnet (standard) – rullande dygnsskydd.
       • Välj datum & match – egen brytpunkt: visa resultat/tabeller/statistik
         t.o.m. ett valt datum, ända ner till en specifik match.
     Allt skydd går via isSpoilerHidden → spoilerHidesKo, så panelen behöver bara
     sätta state (spoilerOn/spoilerCutoff) och rita om vyn.
  ==================================================================== */
  function spoilerMode() {
    if (!spoilerFreeOn()) return "off";
    return spoilerCutoffMs() != null ? "custom" : "auto";
  }

  /* Matcher som redan sparkat igång (avspark <= nu), i kronologisk ordning med
     avspark (ms) + läsbar etikett. Bara en startad match kan vara brytpunkt:
     framtida matcher har inget resultat att spoila (spoilerHidesKo släpper alltid
     igenom ko > nu), så de ska aldrig gå att välja i väljarna. */
  function spoilerScheduleList() {
    var ctx = getCtx(), now = Date.now(), out = [];
    buildSchedule().forEach(function (it) {
      var ko = kickoffUTC(scheduleItemMatch(it, ctx)).getTime();
      if (ko > now) return; // inte påbörjad än – kan inte vara brytpunkt
      var label, sub;
      if (it.kind === "ko") {
        var res = ctx.resolved[it.m.m];
        var hn = res.home.team ? teamSvFixture(res.home.team) : res.home.label;
        var an = res.away.team ? teamSvFixture(res.away.team) : res.away.label;
        label = hn + " – " + an;
        sub = koRoundLabel(it.m);
      } else {
        var th = WC.groups[it.letter][it.fx.h], ta = WC.groups[it.letter][it.fx.a];
        label = teamSvFixture(th) + " – " + teamSvFixture(ta);
        sub = "Grupp " + it.letter;
      }
      out.push({ date: it.date, edt: it.edt, ko: ko, label: label, sub: sub });
    });
    return out;
  }
  function spoilerDayMaxKo(list, date) {
    var mx = -Infinity;
    list.forEach(function (r) { if (r.date === date && r.ko > mx) mx = r.ko; });
    return mx === -Infinity ? null : mx;
  }
  function spoilerDefaultDate(list) {
    // Senaste matchdagen som redan börjat (annars turneringens första dag).
    var now = Date.now(), date = null;
    list.forEach(function (r) { if (r.ko <= now) date = r.date; });
    return date || (list.length ? list[0].date : null);
  }
  function spoilerCutoffDate(list, cutoff) {
    var date = null;
    list.forEach(function (r) { if (r.ko <= cutoff) date = r.date; });
    return date;
  }
  function spoilerHiddenCount(list) {
    var n = 0;
    list.forEach(function (r) { if (spoilerHidesKo(r.ko)) n++; });
    return n;
  }
  function spoilerShortDate(dateStr) {
    var d = parseDateUTC(dateStr);
    return d.getUTCDate() + "/" + (d.getUTCMonth() + 1);
  }

  /* ----- Headerknappens text/klass ----- */
  function syncSpoilerBtnLabel() {
    var btn = document.getElementById("spoilerBtn");
    var stateEl = document.getElementById("spoilerBtnState");
    if (!btn) return;
    var mode = spoilerMode();
    var on = mode !== "off";
    btn.classList.toggle("is-on", on);
    btn.classList.toggle("is-custom", mode === "custom");
    document.documentElement.classList.toggle("spoiler-free", on);
    if (!stateEl) return;
    if (mode === "off") { stateEl.textContent = "Av"; return; }
    if (mode === "auto") { stateEl.textContent = "24 h"; return; }
    var date = spoilerCutoffDate(spoilerScheduleList(), spoilerCutoffMs());
    stateEl.textContent = date ? "≤ " + spoilerShortDate(date) : "Eget val";
  }

  /* ----- Gemensam omräkning när skyddet ändras ----- */
  function applySpoilerChange() {
    // Fair play (kort) och spelar-/lag-/regionstatistik beror på vilka matcher
    // som är dolda – räkna om och skicka in det filtrerade underlaget igen.
    recomputeFairPlay();
    pushVisibleDetailsToStats();
    lastViewSig = null; // tvinga full omritning trots oförändrad HTML-signatur
    refresh({ full: true });
    if (window.VMMatchInfo && typeof window.VMMatchInfo.onSpoilerChange === "function") {
      try { window.VMMatchInfo.onSpoilerChange(); } catch (e) {}
    }
    syncSpoilerBtnLabel();
  }

  function setSpoilerMode(mode) {
    if (mode === "off") {
      setUi("spoilerOn", false);
    } else if (mode === "auto") {
      setUi("spoilerOn", true);
      setUi("spoilerCutoff", null);
    } else { // custom
      setUi("spoilerOn", true);
      if (spoilerCutoffMs() == null) {
        var list = spoilerScheduleList();
        var date = spoilerDefaultDate(list);
        setUi("spoilerCutoff", date != null ? spoilerDayMaxKo(list, date) : Date.now());
      }
    }
    applySpoilerChange();
    renderSpoilerPanel(); // lägesbyte → bygg om hela panelen (visa/dölj väljarna)
    if (spoilerPanelOpen()) positionSpoilerPanel(); // höjden ändras → flytta vid behov
  }

  /* ----- Panelinnehåll ----- */
  function spoilerOptionRow(val, active, title) {
    return '<button type="button" class="spoiler-opt' + (active ? " is-active" : "") +
      '" data-spoiler-mode="' + val + '" role="radio" aria-checked="' + (active ? "true" : "false") + '">' +
      '<span class="spoiler-opt-radio" aria-hidden="true"></span>' +
      '<span class="spoiler-opt-txt"><strong>' + esc(title) + '</strong></span>' +
      '</button>';
  }
  function spoilerDateOptions(list, selDate) {
    var counts = {}, order = [];
    list.forEach(function (r) {
      if (counts[r.date] === undefined) { counts[r.date] = 0; order.push(r.date); }
      counts[r.date]++;
    });
    return order.map(function (date) {
      var d = parseDateUTC(date), cnt = counts[date];
      var lbl = WEEKDAYS_LONG[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS_LONG[d.getUTCMonth()];
      return '<option value="' + date + '"' + (date === selDate ? " selected" : "") + '>' +
        esc(lbl) + " · " + cnt + (cnt === 1 ? " match" : " matcher") + "</option>";
    }).join("");
  }
  function spoilerMatchOptions(list, date, cutoff) {
    var dayMax = spoilerDayMaxKo(list, date);
    var wholeSel = cutoff == null || (dayMax != null && cutoff >= dayMax);
    var out = '<option value="all"' + (wholeSel ? " selected" : "") + '>Hela dagen</option>';
    list.forEach(function (r) {
      if (r.date !== date) return;
      var t = r.edt || "tid TBC";
      var sel = !wholeSel && cutoff === r.ko;
      out += '<option value="' + r.ko + '"' + (sel ? " selected" : "") + '>' +
        esc(t + "  " + r.label) + "</option>";
    });
    return out;
  }
  /* Etikett för den senast visade matchen (brytpunkten) i custom-läget. */
  function spoilerCutoffMatch(list, cutoff) {
    if (cutoff == null) return null;
    for (var i = 0; i < list.length; i++) if (list[i].ko === cutoff) return list[i];
    return null;
  }
  /* Statusrad längst ner – kort och tydlig om vad som visas/döljs. Returnerar
     HTML (lyfter fram den senast visade matchen) så innerHTML används. */
  function spoilerStatusHtml(list) {
    list = list || spoilerScheduleList();
    if (!spoilerFreeOn()) return "Allt visas – inget döljs.";
    var n = spoilerHiddenCount(list);
    var hidden = n === 0 ? "" :
      ' <span class="spoiler-status-hide">Döljer ' + n + (n === 1 ? " senare match." : " senare matcher.") + "</span>";
    if (spoilerMode() === "auto") {
      return n === 0 ? "Inget från det senaste dygnet att dölja just nu."
        : "Döljer " + n + (n === 1 ? " match" : " matcher") + " från det senaste dygnet.";
    }
    var m = spoilerCutoffMatch(list, spoilerCutoffMs());
    if (m) {
      var lbl = (m.edt ? m.edt + "  " : "") + m.label;
      return 'Visar t.o.m. <strong>' + esc(lbl) + "</strong> – den matchen syns." + hidden;
    }
    return "Allt fram till din brytpunkt visas." + hidden;
  }
  function updateSpoilerStatus(list) {
    var el = document.getElementById("spoilerStatus");
    if (el) el.innerHTML = spoilerStatusHtml(list);
  }
  function renderSpoilerPanel() {
    var panel = document.getElementById("spoilerPanel");
    if (!panel) return;
    var mode = spoilerMode();
    var list = spoilerScheduleList();
    var cutoff = spoilerCutoffMs();
    var selDate = (mode === "custom" && cutoff != null) ? spoilerCutoffDate(list, cutoff) : null;
    if (!selDate) selDate = spoilerDefaultDate(list);

    var html = '<div class="spoiler-panel-head">' +
        '<h3 id="spoilerPanelTitle">Spoilerskydd</h3>' +
        '<button type="button" class="spoiler-panel-close" data-spoiler-close title="Stäng" aria-label="Stäng">×</button>' +
      '</div>' +
      '<div class="spoiler-opts" role="radiogroup" aria-labelledby="spoilerPanelTitle">' +
        spoilerOptionRow("off", mode === "off", "Visa allt") +
        spoilerOptionRow("auto", mode === "auto", "Senaste dygnet") +
        spoilerOptionRow("custom", mode === "custom", "Välj brytpunkt") +
      '</div>' +
      '<div class="spoiler-pick"' + (mode === "custom" ? "" : " hidden") + '>' +
        '<label class="spoiler-field"><span>Datum</span>' +
          '<select class="spoiler-select" data-spoiler-date>' + spoilerDateOptions(list, selDate) + '</select>' +
        '</label>' +
        '<label class="spoiler-field"><span>Sista match som visas</span>' +
          '<select class="spoiler-select" data-spoiler-match>' + spoilerMatchOptions(list, selDate, cutoff) + '</select>' +
        '</label>' +
      '</div>' +
      '<div class="spoiler-status" id="spoilerStatus">' + spoilerStatusHtml(list) + '</div>';
    panel.innerHTML = html;
  }

  /* ----- Öppna/stäng + positionering (dropp-panel under knappen) ----- */
  function spoilerPanelOpen() {
    var panel = document.getElementById("spoilerPanel");
    return !!(panel && panel.classList.contains("open"));
  }
  function positionSpoilerPanel() {
    var panel = document.getElementById("spoilerPanel");
    var btn = document.getElementById("spoilerBtn");
    if (!panel || !btn) return;
    var r = btn.getBoundingClientRect();
    var margin = 10, gap = 8;
    var pw = panel.offsetWidth || 320, ph = panel.offsetHeight || 320;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(margin, Math.min(r.right - pw, vw - pw - margin));
    var top = r.bottom + gap;
    if (top + ph > vh - margin) top = Math.max(margin, vh - ph - margin);
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  }
  function openSpoilerPanel() {
    var panel = document.getElementById("spoilerPanel");
    var btn = document.getElementById("spoilerBtn");
    if (!panel || !btn) return;
    renderSpoilerPanel();
    panel.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    positionSpoilerPanel();
  }
  function closeSpoilerPanel() {
    var panel = document.getElementById("spoilerPanel");
    var btn = document.getElementById("spoilerBtn");
    if (panel) panel.classList.remove("open");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function onSpoilerPanelClick(e) {
    // Klick inuti panelen ska aldrig nå dokumentets "stäng vid utanförklick".
    // (Viktigt: setSpoilerMode bygger om panelens innehåll, vilket lösgör
    //  e.target – då skulle onDocClick annars tro att klicket skedde utanför.)
    e.stopPropagation();
    if (e.target.closest("[data-spoiler-close]")) { closeSpoilerPanel(); return; }
    var opt = e.target.closest("[data-spoiler-mode]");
    if (opt) setSpoilerMode(opt.getAttribute("data-spoiler-mode"));
  }
  function onSpoilerPanelChange(e) {
    var t = e.target, list = spoilerScheduleList();
    if (t.matches("[data-spoiler-date]")) {
      var date = t.value;
      setUi("spoilerCutoff", spoilerDayMaxKo(list, date)); // nytt datum → hela dagen
      var matchSel = document.querySelector("#spoilerPanel [data-spoiler-match]");
      if (matchSel) matchSel.innerHTML = spoilerMatchOptions(list, date, spoilerCutoffMs());
      applySpoilerChange();
      updateSpoilerStatus(list);
    } else if (t.matches("[data-spoiler-match]")) {
      var dateSel = document.querySelector("#spoilerPanel [data-spoiler-date]");
      var date2 = dateSel ? dateSel.value : spoilerCutoffDate(list, spoilerCutoffMs());
      if (t.value === "all") setUi("spoilerCutoff", spoilerDayMaxKo(list, date2));
      else setUi("spoilerCutoff", parseInt(t.value, 10));
      applySpoilerChange();
      updateSpoilerStatus(list);
    }
  }
  function setupSpoilerControl() {
    var btn = document.getElementById("spoilerBtn");
    if (!btn) return;
    syncSpoilerBtnLabel();
    btn.addEventListener("click", function (e) {
      e.stopPropagation(); // egen toggle – låt inte onDocClick stänga direkt
      if (spoilerPanelOpen()) closeSpoilerPanel();
      else openSpoilerPanel();
    });
    var panel = document.getElementById("spoilerPanel");
    if (panel) {
      panel.addEventListener("click", onSpoilerPanelClick);
      panel.addEventListener("change", onSpoilerPanelChange);
    }
    window.addEventListener("resize", function () { if (spoilerPanelOpen()) positionSpoilerPanel(); });
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

    // Spoilerskydd-panel (öppnas från headerknappen)
    var spoilerPanel = document.createElement("div");
    spoilerPanel.id = "spoilerPanel";
    spoilerPanel.className = "spoiler-panel";
    spoilerPanel.setAttribute("role", "dialog");
    spoilerPanel.setAttribute("aria-modal", "false");
    spoilerPanel.setAttribute("aria-labelledby", "spoilerPanelTitle");
    document.body.appendChild(spoilerPanel);

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
    // Flytande detaljfönster som visas bredvid sidopanelen vid hovring.
    var probPopup = document.createElement("div");
    probPopup.id = "probPopup";
    probPopup.className = "prob-popup";
    document.body.appendChild(probPopup);
    // Direkt (utan webbläsarens title-fördröjning) visa detaljfönstret vid hovring.
    aside.addEventListener("mouseover", onProbHover);
    aside.addEventListener("mouseout", onProbOut);
    aside.addEventListener("scroll", function () {
      if (!probPopup.classList.contains("show")) return;
      var active = aside.querySelector(".prob-row.active");
      if (active) positionProbPopup(active); else hideProbPopup();
    }, { passive: true });
    document.body.addEventListener("input", onInput);
    document.body.addEventListener("click", onClick);
    document.addEventListener("click", onDocClick);
    viewEl.addEventListener("mouseover", onOver);
    viewEl.addEventListener("mousemove", onMove);
    viewEl.addEventListener("mouseout", onOut);
    // Tangentbord: tänd härstamningen när en slutspelsruta får fokus.
    viewEl.addEventListener("focusin", function (e) {
      if (ui("view", "groups") !== "bracket") return;
      var mc = e.target.closest && e.target.closest("[data-m]");
      if (mc) setBracketLineage(parseInt(mc.getAttribute("data-m"), 10));
    });
    viewEl.addEventListener("focusout", function (e) {
      if (hoverLineage == null) return;
      var to = e.relatedTarget;
      if (!to || !to.closest || !to.closest("[data-m]")) setBracketLineage(null);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (spoilerPanelOpen()) { closeSpoilerPanel(); return; }
        var mc = document.getElementById("matchConfirm");
        if (mc && mc.classList.contains("show")) { closeMatchConfirm(); return; }
        closeTeam(); hideTip();
        hideCalGroupPopup();
        hideProbPopup();
        if (hoverMatch) { hoverMatch = null; hideAside(); syncExpandButtons(); }
      }
      // Aktivera "Nyligen spelat"-kort med Enter/Space → visa varningsrutan.
      if ((e.key === "Enter" || e.key === " ") && document.activeElement) {
        var cEl = document.activeElement.closest && document.activeElement.closest("[data-match-confirm]");
        if (cEl) {
          e.preventDefault();
          openMatchConfirm(cEl.getAttribute("data-match-confirm"));
          return;
        }
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
      hideProbPopup();
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
    window.addEventListener("scroll", function () { if (spoilerPanelOpen()) closeSpoilerPanel(); }, { passive: true });

    setupSpoilerControl();

    if (standaloneView()) {
      document.documentElement.classList.add("standalone-page");
      setUi("view", standaloneView());
    }

    if (ui("view", "groups") === "calendar") calScrollPending = true;
    render();
    updateSyncBadge();

    bracketPosByMatch = buildBracketPosMap();
    loadCalHighlights();                      // repriser (SVT/TV4) till kalenderraderna
    setInterval(loadCalHighlights, 180000);   // plocka upp nya klipp under turneringen
    updateBracketProbs();                    // lokal motor på din data (med statisk fallback)
    setInterval(updateBracketProbs, 300000); // periodisk omräkning under turneringen
    setInterval(function () {
      if (anyLiveOddsPoll()) reloadMarketOdds();
    }, 45000); // plocka upp nya scrapes under live (math tills dess)
  }

  window.VMApp = {
    mergeRemoteResults: mergeRemoteResults,
    setSyncStatus: setSyncStatus,
    autoSync: autoSync,
    describeMatch: describeMatch,
    setMatchDetails: setMatchDetails,
    // Matchdetaljer (laguppställning/händelser) för en resultatnyckel, om de
    // hämtats av assets/matchinfo.js. Används av lag-lådans uppställningsbläddrare.
    getMatchDetail: function (key) { return (focusDetails && focusDetails[key]) || null; },
    groupTableHtml: groupTableHtml,
    // Läsbar för felsökning: var kommer slutspelssiffrorna ifrån + ett stickprov.
    debugBracketProbs: function () {
      if (!bracketProbs) return null;
      return { note: bracketProbs.note, nSims: bracketProbs.nSims, r32pos0: bracketProbs.nodes && bracketProbs.nodes.r32 && bracketProbs.nodes.r32[0], champ: bracketProbs.rounds && Object.keys(bracketProbs.rounds).length };
    }
  };

  document.addEventListener("DOMContentLoaded", init);
})();
