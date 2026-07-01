/*
  VM 2026 – laguppställningsbläddrare i lag-lådan (window.VMTeamLineups).

  Injicerar ett kort i lag-lådan (hook från app.js: onTeamDrawer) där man kan
  bläddra mellan ett landslags spelade matcher och se startelvan visualiserad
  på en fotbollsplan – med tröjnummer, namn och mål/kort/byten per spelare.
  Spelarna är klickbara och öppnar samma spelarprofil som övriga vyer
  (assets/live.js → VMLive.openPlayer).

  Datakälla: matchdetaljerna som assets/matchinfo.js redan hämtat
  (window.VMApp.getMatchDetail), samt den statiska truppen (window.VMPlayers)
  för att koppla en uppställningsrad till en klickbar spelarprofil.
*/
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function flagImg(iso) {
    if (!iso) return '<span class="tl-flag-ph"></span>';
    return '<img class="flag" loading="lazy" src="https://flagcdn.com/' + esc(iso) + '.svg" alt="" ' +
      'onerror="this.style.visibility=\'hidden\'">';
  }

  function getDetail(key) {
    if (!key || !window.VMApp || typeof window.VMApp.getMatchDetail !== "function") return null;
    try { return window.VMApp.getMatchDetail(key); } catch (e) { return null; }
  }

  /* ---------- Färg på nummerbrickorna (måste synas mot den gröna planen) ---------- */

  var PITCH_GREEN = "#2f7d4d";
  var DEFAULT_COLOR = "#c41e3a";

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
  function textOn(hex) {
    var c = hexRgb(hex);
    return (c.r * 299 + c.g * 587 + c.b * 114) / 1000 >= 150 ? "#0a1628" : "#fff";
  }
  /* Lagets primärfärg, men byt till alternativet (eller en kontrastfärg) om den
     är för lik gräsplanen och annars skulle smälta in. */
  function jerseyColor(iso) {
    var pair = (window.WC && window.WC.teamColors && iso && window.WC.teamColors[iso]) || [DEFAULT_COLOR];
    if (colorDist(pair[0], PITCH_GREEN) >= 70) return pair[0];
    if (pair[1] && colorDist(pair[1], PITCH_GREEN) >= 70) return pair[1];
    return colorDist(pair[0], PITCH_GREEN) >= colorDist(pair[1] || "#ffffff", PITCH_GREEN)
      ? pair[0] : (pair[1] || "#ffffff");
  }

  /* ---------- Placering på planen utifrån positionskod ---------- */

  // Lodrätt band: 0 målvakt (nederst) … 5 anfall (överst). Lagen anfaller uppåt.
  var BAND_Y = { 0: 90, 1: 72, 2: 59, 3: 45, 4: 31, 5: 14 };

  function bandOf(pos) {
    var p = String(pos || "").toUpperCase();
    if (p === "G" || p === "GK") return 0;
    if (p === "F" || p === "ST" || p.indexOf("CF") >= 0 || p === "LF" || p === "RF") return 5;
    if (p.indexOf("AM") >= 0) return 4;
    if (p.indexOf("DM") >= 0) return 2;
    if (p === "M" || p === "LM" || p === "RM" || p.indexOf("CM") >= 0) return 3;
    if (p === "SW" || p === "LB" || p === "RB" || p.indexOf("CD") >= 0 || p.indexOf("CB") >= 0 || p === "D") return 1;
    return 3;
  }

  // Sidled: negativt = vänster, positivt = höger. Större magnitud = ytterposition.
  function sideOf(pos) {
    var p = String(pos || "").toUpperCase();
    if (p.indexOf("-L") >= 0) return -1;
    if (p.indexOf("-R") >= 0) return 1;
    var c = p.charAt(0);
    if (c === "L") return -2;
    if (c === "R") return 2;
    return 0;
  }

  /* Startelvan → [{p, x, y}] i procent av planens bredd/höjd. */
  function layout(starters) {
    var bands = {};
    starters.forEach(function (p, i) {
      var b = bandOf(p.pos);
      (bands[b] = bands[b] || []).push({ p: p, i: i });
    });
    var out = [];
    Object.keys(bands).forEach(function (b) {
      var row = bands[b];
      row.sort(function (a, c) {
        var sa = sideOf(a.p.pos), sc = sideOf(c.p.pos);
        return sa - sc || a.i - c.i;
      });
      var n = row.length;
      row.forEach(function (item, idx) {
        out.push({ p: item.p, x: ((idx + 1) / (n + 1)) * 100, y: BAND_Y[b] });
      });
    });
    return out;
  }

  /* ---------- Koppla uppställningsrad → klickbar spelarprofil ---------- */

  function normWords(s) {
    return String(s || "").toLowerCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  function normName(s) {
    return normWords(s).replace(/ /g, "");
  }

  function squadIndex(iso) {
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
  function resolvePlayer(idx, name, jersey) {
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

  /* ---------- Mål / kort / byten per spelare (för den valda matchens sida) ---------- */

  var CARD_CLS = { YELLOW: "yellow", RED: "red", YELLOW_RED: "yellow-red" };
  var CARD_TXT = { YELLOW: "Gult kort", RED: "Rött kort", YELLOW_RED: "Andra gula → rött" };

  function eventsFor(det, side) {
    var map = {};
    function ensure(name) {
      var k = normName(name);
      if (!map[k]) map[k] = { goals: 0, cards: [], subOut: false, subIn: false };
      return map[k];
    }
    (det.goals || []).forEach(function (g) {
      if (g.team === side && g.scorer && g.type !== "OWN") ensure(g.scorer).goals++;
    });
    (det.bookings || []).forEach(function (b) {
      if (b.team === side && b.player) ensure(b.player).cards.push(b.card);
    });
    (det.subs || []).forEach(function (s) {
      if (s.team !== side) return;
      if (s.out) ensure(s.out).subOut = true;
      if (s.in) ensure(s.in).subIn = true;
    });
    return map;
  }

  function badgesHtml(ev) {
    if (!ev) return "";
    var parts = [];
    var i;
    for (i = 0; i < ev.goals; i++) parts.push('<span class="tl-ic goal" title="Mål">⚽</span>');
    ev.cards.forEach(function (c) {
      parts.push('<span class="tl-ic card ' + (CARD_CLS[c] || "yellow") + '" title="' + esc(CARD_TXT[c] || "Kort") + '"></span>');
    });
    if (ev.subOut) parts.push('<span class="tl-ic sub out" title="Utbytt">▼</span>');
    if (ev.subIn) parts.push('<span class="tl-ic sub in" title="Inbytt">▲</span>');
    if (!parts.length) return "";
    return '<span class="tl-badges">' + parts.join("") + "</span>";
  }

  /* ---------- Hjälp: namn, resultat ---------- */

  function shortName(name) {
    var parts = String(name || "").trim().split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : (parts[0] || "");
  }

  function outcomeFor(match) {
    var r = match.r || {};
    if (r.h == null || r.a == null) return null;
    var my = match.isHome ? r.h : r.a, op = match.isHome ? r.a : r.h;
    var cls = my > op ? "v" : (my < op ? "f" : "o");
    if (my === op && r.pw) cls = (r.pw === (match.isHome ? "h" : "a")) ? "v" : "f";
    return { my: my, op: op, cls: cls };
  }

  /* ---------- Rendering ---------- */

  function optionsFor(team, playedMatches) {
    // Endast spelade matcher där det finns en uppställning för rätt lag-sida.
    var opts = [];
    (playedMatches || []).forEach(function (mm) {
      if (!mm || !mm.key || !mm.home || !mm.away) return;
      var det = getDetail(mm.key);
      var side = mm.isHome ? "h" : "a";
      var lu = det && det.lineups && det.lineups[side];
      if (!lu || !(lu.starters && lu.starters.length)) return;
      opts.push({ match: mm, det: det, side: side });
    });
    return opts;
  }

  function chipsHtml(opts, selectedKey) {
    var h = '<div class="tl-chips" role="tablist">';
    opts.forEach(function (o) {
      var mm = o.match;
      var opp = mm.isHome ? mm.away : mm.home;
      var oc = outcomeFor(mm);
      var resTxt = oc ? oc.my + "–" + oc.op : "";
      var resCls = oc ? oc.cls : "o";
      var active = mm.key === selectedKey;
      h += '<button type="button" class="tl-chip' + (active ? " active" : "") + '" role="tab" ' +
        'aria-selected="' + active + '" data-tl-key="' + esc(mm.key) + '" ' +
        'title="' + esc((mm.label || "") + (opp ? " · " + opp.sv : "")) + '">' +
        flagImg(opp && opp.iso) +
        '<span class="tl-chip-res ' + resCls + '">' + esc(resTxt) + '</span>' +
        '</button>';
    });
    h += '</div>';
    return h;
  }

  function pitchHtml(team, o) {
    var lu = o.det.lineups[o.side];
    var color = jerseyColor(team.iso);
    var txt = textOn(color);
    var idx = squadIndex(team.iso);
    var ev = eventsFor(o.det, o.side);

    var spots = layout(lu.starters || []);
    var markers = spots.map(function (s) {
      var p = s.p;
      var sp = resolvePlayer(idx, p.name, p.jersey);
      var open = sp ? ' data-tl-pid="' + esc(sp.id) + '" role="button" tabindex="0" title="Visa profil: ' + esc(p.name) + '"' : ' title="' + esc(p.name) + '"';
      var cls = "tl-marker" + (sp ? " openable" : "");
      var cap = (sp && sp.captain) ? '<span class="tl-cap" title="Lagkapten">C</span>' : "";
      return '<div class="' + cls + '" style="left:' + s.x.toFixed(1) + '%;top:' + s.y + '%"' + open + '>' +
        '<span class="tl-dot" style="background:' + color + ';color:' + txt + '">' + esc(p.jersey || "") + cap + '</span>' +
        badgesHtml(ev[normName(p.name)]) +
        '<span class="tl-pname" style="--tl-name-bg:' + color + '">' + esc(shortName(p.name)) + '</span>' +
        '</div>';
    }).join("");

    return '<div class="tl-pitch"><div class="tl-pitch-lines" aria-hidden="true"></div>' + markers + '</div>';
  }

  function benchHtml(team, o) {
    var lu = o.det.lineups[o.side];
    var bench = lu.bench || [];
    if (!bench.length) return "";
    var idx = squadIndex(team.iso);
    var ev = eventsFor(o.det, o.side);
    var rows = bench.map(function (p) {
      var sp = resolvePlayer(idx, p.name, p.jersey);
      var open = sp ? ' data-tl-pid="' + esc(sp.id) + '" role="button" tabindex="0" title="Visa profil: ' + esc(p.name) + '"' : "";
      var cls = "tl-bench-row" + (sp ? " openable" : "");
      return '<span class="' + cls + '"' + open + '>' +
        '<span class="tl-bench-nr">' + esc(p.jersey || "") + '</span>' +
        '<span class="tl-bench-name">' + esc(p.name) + '</span>' +
        badgesHtml(ev[normName(p.name)]) +
        '</span>';
    }).join("");
    return '<div class="tl-bench"><div class="tl-bench-head">Avbytare</div><div class="tl-bench-list">' + rows + '</div></div>';
  }

  function stageHtml(team, o) {
    var mm = o.match;
    var opp = mm.isHome ? mm.away : mm.home;
    var oc = outcomeFor(mm);
    var lu = o.det.lineups[o.side];
    var meta = '<div class="tl-meta">' +
      '<span class="tl-meta-match">' + (mm.isHome ? "" : "borta · ") +
        flagImg(opp && opp.iso) + '<span class="tl-meta-opp">' + esc(opp ? opp.sv : "?") + '</span></span>' +
      (oc ? '<span class="tl-meta-res ' + oc.cls + '">' + oc.my + '–' + oc.op + '</span>' : "") +
      (lu.formation ? '<span class="tl-meta-form">' + esc(lu.formation) + '</span>' : "") +
      '</div>';
    return meta + pitchHtml(team, o) + benchHtml(team, o);
  }

  function renderInto(card, st) {
    if (!st) return;
    var team = st.team;
    var opts = st.options;
    var body = '<div class="dc-title">Laguppställningar</div>';
    if (!opts.length) {
      body += '<div class="dc-empty">Startelvor visas här när laget spelat sin första match.</div>';
      card.innerHTML = body;
      return;
    }
    // Säkra att valt alternativ finns kvar (annars senaste matchen).
    if (!opts.some(function (o) { return o.match.key === st.selectedKey; })) {
      st.selectedKey = opts[0].match.key;
    }
    var sel = opts.filter(function (o) { return o.match.key === st.selectedKey; })[0];
    body += chipsHtml(opts, st.selectedKey);
    body += '<div class="tl-stage">' + stageHtml(team, sel) + '</div>';
    body += '<div class="tl-note">Uppställning: ESPN · klicka på en spelare för profil</div>';
    card.innerHTML = body;
  }

  function bindCard(card, st) {
    card.addEventListener("click", function (e) {
      var chip = e.target.closest && e.target.closest("[data-tl-key]");
      if (chip) {
        st.selectedKey = chip.getAttribute("data-tl-key");
        renderInto(card, st);
        return;
      }
      var pl = e.target.closest && e.target.closest("[data-tl-pid]");
      if (pl) openProfile(st, pl.getAttribute("data-tl-pid"));
    });
    card.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var pl = e.target.closest && e.target.closest("[data-tl-pid]");
      if (pl) { e.preventDefault(); openProfile(st, pl.getAttribute("data-tl-pid")); }
    });
  }

  function openProfile(st, pid) {
    if (!st || !window.VMPlayers || !window.VMLive || typeof window.VMLive.openPlayer !== "function") return;
    var p = window.VMPlayers.getPlayerById(pid);
    if (p) window.VMLive.openPlayer(p, st.team);
  }

  /* Hook från app.js. panel = "Trupp"-flikens tomma behållare i lag-lådan.
     playedMatches = lagets spelade matcher (senaste först), försedda med
     .key så vi kan slå upp matchdetaljerna. */
  function onTeamDrawer(team, group, panel, playedMatches) {
    if (!panel) return;

    var card = document.createElement("div");
    card.className = "drawer-card tl-card";
    panel.appendChild(card);

    var st = {
      team: team, group: group,
      options: optionsFor(team, playedMatches),
      selectedKey: null
    };
    bindCard(card, st);

    var ensureSquad = window.VMPlayers && window.VMPlayers.load
      ? window.VMPlayers.load() : Promise.resolve();
    ensureSquad.then(function () {
      // Lag-lådan kan ha bytts ut under tiden – rita bara om kortet finns kvar.
      if (card.isConnected) renderInto(card, st);
    }).catch(function () {});

    renderInto(card, st);

    // Matchdetaljerna kan dröja någon sekund efter sidladdning. Försök igen några
    // gånger om inga uppställningar fanns när lådan öppnades.
    if (!st.options.length) retryUntilDetails(team, playedMatches, card, st, 0);
  }

  function retryUntilDetails(team, playedMatches, card, st, n) {
    if (n > 6 || !card.isConnected) return;
    setTimeout(function () {
      if (!card.isConnected) return;
      var opts = optionsFor(team, playedMatches);
      if (opts.length) {
        st.options = opts;
        renderInto(card, st);
      } else {
        retryUntilDetails(team, playedMatches, card, st, n + 1);
      }
    }, 700);
  }

  window.VMTeamLineups = { onTeamDrawer: onTeamDrawer };
})();
