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

  /* Klubb → liga (data/club_leagues.json). Laddas lätt i bakgrunden när
     lag-lådan öppnas; profilfliken fylls på i efterhand om datan inte hunnit
     fram när modalen öppnas. */
  var leaguesData = null;
  var leaguesPromise = null;

  function ensureLeagues() {
    if (!leaguesPromise) {
      leaguesPromise = fetch("data/club_leagues.json", { headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { leaguesData = d; })
        .catch(function () {});
    }
    return leaguesPromise;
  }

  /** Ligaposten ({country,name,tier,rep,iso}) för en klubb, eller null. */
  function leagueOf(club) {
    if (!club || !leaguesData || !leaguesData.clubs || !leaguesData.leagues) return null;
    var lid = leaguesData.clubs[club];
    return lid ? (leaguesData.leagues[lid] || null) : null;
  }

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

  function onTeamDrawer(team, group, panel) {
    lastTeam = { team: team, group: group, panel: panel };
    if (!panel) return;
    ensureLeagues(); // förladda ligadatan så spelarprofilen har den direkt

    var card = document.createElement("div");
    card.className = "drawer-card players-card";
    card.innerHTML = '<div class="dc-title">Trupp</div>' +
      '<p class="squad-source">Landslagsstatistik från Wikipedia, inhämtad före VM-slutspelet.' +
        ' Siffran vid varje spelare är antalet landskamper – ' +
        '<span class="pr-caps-legend"><span class="pr-caps-ico" aria-hidden="true"></span>fler kamper = mer rutin</span>, ' +
        '<span class="pr-caps-debut pr-caps-legend">Debut</span> = ännu ingen landskamp.</p>' +
      '<div class="players-status">Laddar trupp …</div>';
    panel.appendChild(card);

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

  /** Erfarenhetsnivå (0–4) utifrån antal landskamper – styr färgtonen på
      landskampsmärket så att man snabbt ser vilka som är rutinerade. */
  function capsTier(caps) {
    if (caps >= 100) return 4;
    if (caps >= 50) return 3;
    if (caps >= 25) return 2;
    if (caps >= 1) return 1;
    return 0;
  }

  /** Landskampsmärke i trupplistan: visar hur många landskamper spelaren har
      (före VM-slutspelet), markerar landslagsdebutanter (0 kamper) och visar
      ett dämpat streck när antalet är okänt. */
  function squadCaps(p) {
    if (p.caps == null) {
      return '<span class="pr-caps pr-caps-unknown" title="Antal landskamper okänt">–</span>';
    }
    if (p.caps === 0) {
      return '<span class="pr-caps pr-caps-debut" ' +
        'title="Har inte spelat någon landskamp ännu – landslagsdebutant">Debut</span>';
    }
    var label = p.caps === 1 ? "1 landskamp" : p.caps + " landskamper";
    return '<span class="pr-caps tier-' + capsTier(p.caps) +
      '" title="' + esc(label) + ' för landslaget (före VM-slutspelet)">' +
      '<span class="pr-caps-ico" aria-hidden="true"></span>' +
      '<span class="pr-caps-num">' + esc(p.caps) + '</span></span>';
  }

  function squadRow(p) {
    var meta = squadMeta(p);
    var metaTitle = p.club && p.age == null ? ' title="' + esc(p.club) + '"' : "";
    var st = statusOf(p.id);
    return '<button class="player-row' + (st ? " has-pstat" : "") + '" data-pid="' + esc(p.id) + '">' +
      '<span class="pr-name">' +
        '<span class="pr-name-text">' + esc(p.name) + '</span>' +
        (p.captain ? '<span class="pr-cap" title="Lagkapten">C</span>' : "") +
        statusPill(st) +
      '</span>' +
      squadCaps(p) +
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

  /* ---------- VM-betyg & matchlogg (presentation) ---------- */

  function flagImg(iso) {
    if (!iso) return "";
    return '<img class="flag" loading="lazy" src="https://flagcdn.com/' + esc(iso) + '.svg" alt="" ' +
      'onerror="this.style.visibility=\'hidden\'">';
  }

  /** 10-gradigt betyg med en decimal, "–" när det saknas. */
  function fmtRating(v) {
    return (v == null || !isFinite(v)) ? "–" : (Math.round(v * 10) / 10).toFixed(1);
  }

  /** Färgklass för ett betyg (guld/grön/neutral/röd). */
  function rtClass(v) {
    if (v == null || !isFinite(v)) return "rt-none";
    if (v >= 7.5) return "rt-top";
    if (v >= 6.5) return "rt-good";
    if (v >= 5.5) return "rt-mid";
    return "rt-low";
  }

  /** Speltidstext för en matchloggrad: "hela matchen" / byten / utvisning. */
  function logRole(e) {
    if ((e.rd || e.yr) && e.off < e.full) {
      return (e.starter ? "" : "inbytt " + e.on + "′ · ") + "utvisad " + e.off + "′";
    }
    if (e.starter) return e.off < e.full ? "utbytt " + e.off + "′" : "hela matchen";
    var s = "inbytt " + e.on + "′";
    if (e.off < e.full) s += " · utbytt " + e.off + "′";
    return s;
  }

  /** Händelseikoner (mål/assist/kort/räddningar) för en matchloggrad. */
  function logEvents(e, isGk) {
    var out = [];
    if (e.g) {
      out.push('<span class="pm-ev" title="' + e.g + " mål" +
        (e.pen ? " (varav " + e.pen + " på straff)" : "") + '">⚽' +
        (e.g > 1 ? "×" + e.g : "") + "</span>");
    }
    if (e.og) out.push('<span class="pm-ev pm-ev-og" title="Självmål">⚽SM</span>');
    if (e.a) out.push('<span class="pm-ev pm-ev-a" title="' + e.a + ' assist">A' + (e.a > 1 ? "×" + e.a : "") + "</span>");
    if (isGk && e.sv) out.push('<span class="pm-ev" title="' + e.sv + ' räddningar">🧤' + e.sv + "</span>");
    if (e.y) out.push('<span class="pm-mini-card y" title="Gult kort"></span>');
    if (e.yr) out.push('<span class="pm-mini-card yr" title="Utvisad – andra gula kortet"></span>');
    if (e.rd) out.push('<span class="pm-mini-card r" title="Rött kort"></span>');
    return out.join("");
  }

  /** Resultatpill (grön vinst / grå oavgjort / röd förlust) ur lagets perspektiv. */
  function logScore(e) {
    if (e.gf == null || e.ga == null) return '<span class="pm-log-score res-x">–</span>';
    var cls = e.res === 1 ? "res-w" : e.res === -1 ? "res-l" : e.res === 0 ? "res-d" : "res-x";
    var txt = e.res === 1 ? "Vinst" : e.res === -1 ? "Förlust" : "Oavgjort";
    return '<span class="pm-log-score ' + cls + '" title="' + txt + " " + e.gf + "–" + e.ga + '">' +
      e.gf + "–" + e.ga + "</span>";
  }

  /** En rad i matchloggen – klickbar (data-match-open) och öppnar matchrapporten. */
  function logRow(e, isGk) {
    return '<button type="button" class="pm-log-row" data-match-open="' + esc(e.key) + '" ' +
        'title="Öppna matchrapporten">' +
      '<span class="pm-log-flag">' + flagImg(e.oppIso) + '</span>' +
      '<span class="pm-log-main">' +
        '<span class="pm-log-opp">' + esc(e.oppSv) + '</span>' +
        '<span class="pm-log-sub">' + esc((e.label ? e.label + " · " : "") + logRole(e)) + '</span>' +
      '</span>' +
      '<span class="pm-log-ev">' + logEvents(e, isGk) + '</span>' +
      logScore(e) +
      '<span class="pm-log-rt ' + rtClass(e.rating) + '">' + fmtRating(e.rating) + '</span>' +
      '</button>';
  }

  /** Ligarad på profilfliken: flagga + liganamn (+ nivå) med land under. */
  function leagueRowHtml(lg) {
    var name = lg.name + (lg.tier > 1 ? " (nivå " + lg.tier + ")" : "");
    return '<div class="pm-row"><span class="pm-row-lbl">Liga</span>' +
      '<span class="pm-row-val pm-row-league">' +
        '<span class="pm-league-name">' + flagImg(lg.iso) + esc(name) + '</span>' +
        '<span class="pm-league-country">' + esc(lg.country) + '</span>' +
      '</span></div>';
  }

  /** Ligans renommé (0–100) som liten mätare – samma skala som Ligor-fliken. */
  function leagueRepHtml(lg) {
    if (lg.rep == null) return "";
    return '<div class="pm-row" title="Ligans renommé inför VM på skalan 0–100, där 100 = Premier League.">' +
      '<span class="pm-row-lbl">Ligarenommé</span>' +
      '<span class="pm-row-val pm-rep">' +
        '<span class="pm-rep-bar"><span class="pm-rep-fill" style="width:' +
          Math.max(2, Math.min(100, lg.rep)) + '%"></span></span>' +
        '<span class="pm-rep-num">' + esc(lg.rep) + '/100</span>' +
      '</span></div>';
  }

  /** Betting-metrik (marknadsvärde + klubbform 2025/26) för ett spelar-id, eller null. */
  function metricsOf(id) {
    return (window.VMPlayers && VMPlayers.getPlayerMetrics) ? VMPlayers.getPlayerMetrics(id) : null;
  }

  /* Målform 0–100 som liten mätare: mål per match skalat mot 1.0 (elitanfallare
     ligger runt 0,7–1,0). Ger en snabb visuell känsla för målhotet. */
  function formGaugeCls(gpa) {
    if (gpa >= 0.5) return "hot";
    if (gpa >= 0.25) return "warm";
    return "cool";
  }

  /**
   * "Marknad & form"-kortet på profilfliken: marknadsvärde (kvalitetsproxy) och
   * klubbform innevarande säsong (mål/matcher + mål per match). Betting-data som
   * inte finns någon annanstans på sidan. Tomt om ingen metrik hämtats.
   */
  function marketPanelHtml(player) {
    var m = metricsOf(player.id);
    if (!m || (m.market_value == null && !m.season)) return "";
    var html = '<div class="pm-market">';

    if (m.market_value) {
      var meta = ["Transfermarkt"];
      if (m.club) meta.push(m.club);
      html += '<div class="pm-mv">' +
        '<span class="pm-mv-val">' + esc(m.market_value) + '</span>' +
        '<span class="pm-mv-lbl"><strong>Marknadsvärde</strong>' +
          '<span>' + esc(meta.join(" · ")) + '</span></span>' +
        '</div>';
    }

    if (m.season) {
      var s = m.season;
      var gpa = s.gpa == null ? 0 : s.gpa;
      var pct = Math.max(2, Math.min(100, Math.round(gpa * 100)));
      var lg = s.league || {};
      html += '<div class="pm-form">' +
        '<div class="pm-form-head"><strong>Klubbform ' + esc(s.season) + '</strong>' +
          (lg.comp ? '<span>' + esc(lg.comp) + ' + cuper</span>' : "") + '</div>' +
        '<div class="pm-form-stats">' +
          '<div class="pm-fstat"><b>' + esc(s.total.goals) + '</b><span>Mål</span></div>' +
          '<div class="pm-fstat"><b>' + esc(s.total.apps) + '</b><span>Matcher</span></div>' +
          '<div class="pm-fstat"><b>' + (s.gpa == null ? "–" : s.gpa.toFixed(2)) +
            '</b><span>Mål / match</span></div>' +
        '</div>' +
        '<div class="pm-form-gauge" title="Mål per match, skalat mot 1,0">' +
          '<span class="pm-form-fill ' + formGaugeCls(gpa) + '" style="width:' + pct + '%"></span>' +
        '</div>' +
        (lg.apps != null ? '<div class="pm-form-league">I ligan: <strong>' + esc(lg.goals) +
          '</strong> mål på ' + esc(lg.apps) + ' matcher</div>' : "") +
        '</div>';
    }

    html += '</div>';
    return html;
  }

  /** Profilfliken: Wikipedia-bas + VM-tillskott på landskamper/landslagsmål. */
  function profilPanelHtml(player, wc) {
    var lg = leagueOf(player.club);
    return marketPanelHtml(player) +
      '<div class="pm-stats">' +
        statCell(player.age, "Ålder") +
        statCellPlus(player.caps, wc ? wc.apps : 0, "Landskamper") +
        statCellPlus(player.goals, wc ? wc.goals : 0, "Landslagsmål") +
      '</div>' +
      '<div class="pm-info">' +
        infoRow("Tröjnummer", player.shirt_number) +
        infoRow("Position", player.position_sv) +
        infoRow("Födelsedatum", fmtDate(player.date_of_birth)) +
        infoRow("Klubb", player.club) +
        (lg ? leagueRowHtml(lg) + leagueRepHtml(lg)
            : infoRow("Klubbland", player.club_country)) +
      '</div>' +
      '<div class="pm-note">Stora talet är totalen. Raden under visar antalet ' +
        'före VM-slutspelet (från Wikipedia) + grönt tillägg ' +
        '<span class="pm-plus pm-plus-inline">+N</span> under VM 2026.</div>';
  }

  /** VM 2026-fliken: betyg, statistik och match-för-match-logg för detta VM. */
  function vmPanelHtml(wc, player) {
    if (!wc || !wc.played) {
      return '<div class="pm-empty-vm">Har inte spelat någon match i VM 2026 ännu.</div>';
    }
    var isGk = (wc.pos || (player && player.pos_code)) === "GK";
    var html = "";

    if (wc.rating != null) {
      html += '<div class="pm-rating ' + rtClass(wc.rating) + '">' +
        '<span class="pm-rating-val">' + fmtRating(wc.rating) + '</span>' +
        '<span class="pm-rating-txt"><strong>VM-betyg</strong>' +
          '<span>' + (wc.ratingQ
            ? "Minutviktat snitt över " + wc.apps + (wc.apps === 1 ? " match" : " matcher")
            : "Under 90 spelade minuter – osäkert betyg") + '</span>' +
        '</span></div>';
    }

    var goalsTitle = [];
    if (wc.pens) goalsTitle.push(wc.pens + " på straff");
    if (wc.og) goalsTitle.push(wc.og + " självmål (räknas ej)");
    var cards = "";
    if (wc.y) cards += '<span class="pm-card-pill y">' + wc.y + ' gul' + (wc.y === 1 ? "t" : "a") + '</span>';
    if (wc.r) cards += '<span class="pm-card-pill r">' + wc.r + ' röd' + (wc.r === 1 ? "tt" : "a") + '</span>';

    html += '<div class="pm-stats pm-stats-vm">' +
        statCell(wc.apps, "Matcher") +
        statCell(wc.min ? wc.min + "'" : 0, "Minuter") +
        statCell(wc.goals, "Mål") +
        statCell(wc.assists, "Assist") +
      '</div>';

    var rows = "";
    if (goalsTitle.length) rows += infoRow("Varav", goalsTitle.join(" · "));
    if (cards) {
      rows += '<div class="pm-row"><span class="pm-row-lbl">Kort</span>' +
        '<span class="pm-row-val">' + cards + '</span></div>';
    }
    if (wc.sh || wc.sg) rows += infoRow("Skott (varav på mål)", wc.sh + " (" + wc.sg + ")");
    if (isGk) rows += infoRow("Räddningar", wc.sv);
    if (wc.fc || wc.fs) rows += infoRow("Fouls · utsatt för fouls", wc.fc + " · " + wc.fs);
    if (wc.ratingQ && (wc.goals || wc.assists)) {
      rows += infoRow("Mål + assist per 90 min", (Math.round(wc.gi90 * 100) / 100).toFixed(2));
    }
    if (rows) html += '<div class="pm-info">' + rows + '</div>';

    if (wc.log && wc.log.length) {
      html += '<div class="pm-log"><div class="pm-log-head">Match för match</div>' +
        wc.log.map(function (e) { return logRow(e, isGk); }).join("") +
        '</div>';
    }

    html += '<div class="pm-note">Ur matchrapporterna (ESPN). Betyget är 10-gradigt ' +
      '(bas 6,0) per match och väger mål, assist, resultat medan spelaren var på ' +
      'planen, hållen nolla, räddningar, skott, fouls och kort. ' +
      'Klicka på en match för hela matchrapporten.</div>';
    return html;
  }

  function openPlayer(player, team) {
    var m = ensureModal();
    var sub = [];
    if (player.shirt_number != null) sub.push("#" + player.shirt_number);
    sub.push(player.position_sv || "");

    var wc = wcStatsFor(player.id);
    var hasWc = !!(wc && wc.played);
    var st = statusOf(player.id);

    var mm = metricsOf(player.id);
    var initial = esc((player.name || "?").charAt(0));
    var avatar = (mm && mm.photo)
      ? '<img class="pm-photo" src="' + esc(mm.photo) + '" alt="' + esc(player.name) + '" ' +
        'loading="lazy" referrerpolicy="no-referrer" ' +
        // Faller tillbaka till bokstavsplattan om porträttet inte kan laddas.
        'onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),' +
        '{className:\'pm-photo placeholder\',textContent:\'' + initial + '\'}))">'
      : '<div class="pm-photo placeholder">' + initial + '</div>';

    var card = m.querySelector(".pm-card");
    card.setAttribute("data-pid", player.id == null ? "" : String(player.id));
    card.innerHTML =
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
        '<div class="pm-tab-panel" data-pm-panel="vm">' + vmPanelHtml(wc, player) + '</div>' +
      '</div>';

    m.querySelector(".pm-close").addEventListener("click", closePlayer);
    m.classList.add("open");

    // Ligadatan kan komma efter att modalen ritats – fyll då på profilfliken
    // (bara om modalen fortfarande visar samma spelare).
    if (!leaguesData) {
      ensureLeagues().then(function () {
        if (!leaguesData || !m.classList.contains("open")) return;
        if (card.getAttribute("data-pid") !== String(player.id)) return;
        var panel = card.querySelector('[data-pm-panel="profil"]');
        if (panel) panel.innerHTML = profilPanelHtml(player, wc);
      });
    }
  }

  /** Flikbyte + matchloggsklick i spelarmodalen (delegerat). */
  function onModalClick(e) {
    // Klick på en matchloggrad: stäng spelarmodalen och låt klicket bubbla
    // vidare till app.js body-lyssnare som öppnar matchinfo-modalen
    // (den ligger under spelarmodalen i z-led, därför stängs vi först).
    var mo = e.target.closest && e.target.closest("[data-match-open]");
    if (mo) { closePlayer(); return; }

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
