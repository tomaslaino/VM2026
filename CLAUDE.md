# VM2026 – Projektöversikt för Claude

## Vad är det här?
Webbapp för att följa fotbolls-VM 2026 (USA, Mexiko, Kanada). Visar grupptabeller, slutspelsträd, kalender och live-matchstatistik. Publicerad på **gravergrav.se** via GitHub Pages.

## Arkitektur

### Två driftlägen
1. **GitHub Pages (standard)** – ren statisk frontend. GitHub Actions kör `npm run sync:static` var 3:e minut och uppdaterar `data/results.json` + `data/matchdetails.json`. Ingen server behövs.
2. **Med backend (Render)** – Node.js-server med WebSocket, pollar ESPN-API och pushar uppdateringar till klienten i realtid. Valfri Neon Postgres-databas.

### Datakällor
- **ESPN öppet API** – resultat, livehändelser (mål/kort/byten), matchstatistik. Ingen API-nyckel.
- **Wikipedia** – truppdata (position, ålder, klubb, landskamper) via `scripts/fetch_player_details.py`.
- **API-Football** (valfritt, betald) – spelarstatistik samt **spelartillgänglighet** (skador/avstängningar/osäkra, `/injuries`) via `API_FOOTBALL_KEY` i `.env`.
- **FotMob öppet webb-API** – Opta-baserade **spelarbetyg** per match (fångar även defensivt spel som ESPN:s gratisdata saknar) samt **xG** (förväntade mål) per lag och spelare. Ingen nyckel.

### Nyckelkommandon
```bash
npm start          # starta server (http://localhost:3000)
npm run dev        # starta med --watch (auto-restart)
npm run sync       # synka resultat till server/data/results.json
npm run sync:static # synka till data/results.json + data/matchdetails.json (GitHub Pages)
npm run sync:availability # bygg spelartillgänglighet → data/wc2026_player_status.json (avstängningar ur matchdatan + skadenyheter ur ländernas medier, ingen nyckel)
npm run sync:status # legacy: samma fil från API-Football /injuries (kräver API_FOOTBALL_KEY; workflowen kör numera sync:availability)
npm run sync:news  # synka landslagsnyheter per land → data/team_news.json (Google Nyheter-RSS, ingen nyckel)
npm run sync:summaries # skriv "Redaktionens analys" automatiskt → data/news_summaries.json (Gemini skriver en svensk analysartikel per match ur färska källor och avslutar med en prognos/troligt slutresultat; kräver GEMINI_API_KEY). --dry-run testar utan nyckel
npm run sync:reviews # skriv "Facit" per spelad slutspelsmatch → data/match_reviews.json (Gemini jämför förhandsprognosen med utfallet + statistik/rapporter, betygsätter och drar lärdomar; kräver GEMINI_API_KEY). Bygger även data/analysis_lessons.json (träffsäkerhet + lärdomskorpus som matas in i kommande förhandsanalyser). --dry-run testar utan nyckel
npm run sync:lineups # synka troliga/bekräftade startelvor för kommande matcher → data/lineups_prelim.json (365Scores, ingen nyckel)
npm run sync:metrics # synka betting-metrik per spelare → data/wc2026_player_metrics.json (marknadsvärde + porträtt från Transfermarkt, klubbform 2025/26 matcher+mål från Wikipedia, ingen nyckel)
npm run sync:fotmob # synka FotMobs spelarbetyg + xG per match → data/fotmob_ratings.json (Opta-baserade betyg, lag-xG/xGOT och spelar-xG ur shotmap för färdiga matcher, kopplas till ESPN-spelarnamn, ingen nyckel)
```

## Viktiga filer
| Fil/mapp | Roll |
|---|---|
| `index.html` | Ingångspunkt, innehåller `window.VM_CONFIG` |
| `assets/app.js` | Huvudlogik: tabeller, slutspelsträd, kalender |
| `assets/matchinfo.js` | Matchmodal med detaljer/statistik. För ospelade matcher är fliken **"Redaktionens analys"** default och längst till vänster: automatgenererad svensk analysartikel per match ur `data/news_summaries.json` som väger samman båda lägren och **avslutas med en prognos** (`prediction` = troligt slutresultat + `predictionNote`, renderas som "Redaktionens dom"-ruta) – rubrik/ingress/fet/kursiv + upphöjda `[[n]]`-källhänvisningar, renderas av `miInlineNews`/`newsSummaryHtml`. Saknas analysen faller fliken tillbaka till rubriklista ur `data/team_news.json`. Fliken **"Fakta & odds"** (f.d. "Inför", data från `VMApp.matchPreview` i app.js) visar odds/sannolikheter, form och nyckelspelare + "Avbräck & frågetecken inför matchen" (`availSectionHtml`, med orsak + källänk) ur spelarstatusen; "Formen i VM" är xGscore-inspirerad (`pvXgList`): per spelad match resultat + xG för/emot (ur `data/fotmob_ratings.json`, lagets sida via `key`/`side` som `teamFormFor` i app.js sätter på formposterna) med snitt och Effektivitet (mål − xG) i botten – utan xG-underlag faller listan tillbaka till ren resultatlista. För SPELADE slutspelsmatcher med färdigt facit visas en **"Facit"-flik** (näst efter Händelser, ej default) ur `data/match_reviews.json`: prognos-vs-utfall-kort med träff/miss, redaktionens självbetyg, efteranalys med källor, lärdomar och löpande träffsäkerhet (`reviewTabHtml`) |
| `assets/r32engine.js` | Monte Carlo-motor: simulerar vem man möter i R32 utifrån odds (delas av huvudtråd + worker) |
| `assets/r32worker.js` | Web Worker som kör `r32engine.js` utanför huvudtråden |
| `data/odds.json` | Exakta resultat-odds för de återstående gruppmatcherna (indata till R32-motorn) |
| `assets/players.js` | Statiskt datalager för truppdata + spelarstatus + betting-metrik (`window.VMPlayers`, bl.a. `getPlayerMetrics`) |
| `assets/live.js` | Trupp i lag-lådan + spelarprofil-modal (visar skade-/avstängningsstatus, porträttfoto, "Marknad & form"-kortet: marknadsvärde + klubbform 2025/26 ur `data/wc2026_player_metrics.json`, samt **FotMob-betyg** (matchbetyg) + match-för-match-logg med betyg per match ur `VMPlayerStats.getPlayerStats`) |
| `data/wc2026_player_metrics.json` | Betting-metrik per spelar-id: `market_value_eur`/`market_value` (Transfermarkt), `photo` (porträtt) med `photo_src` (`transfermarkt` primärt, `wikipedia` som reserv), `season` = klubbform 2025/26 (`league`/`total` {apps, goals} + `gpa` mål per match, från Wikipedia). Uppslag (`tm_id`/`wiki_title`) cachas; `*_checked`-flaggor skiljer "ingen data finns" från "hämtning misslyckades → prova igen". Poster med `manual: true` bevaras |
| `server/scripts/syncPlayerMetrics.js` | Bygger spelarmetriken: slår upp spelaren på Transfermarkt (tolerant nationalitetsverifiering + omvänd namnordning för koreanska/japanska namn) för marknadsvärde/klubb/porträtt + parsar klubbform 2025/26 (matcher/mål, liga + totalt) och infobox-porträtt (reserv) ur spelarens Wikipedia-artikel. Inkrementell/resumbar, ingen nyckel. Körs dagligen av `sync-player-metrics.yml`. Assist/minuter/skott ingår inte (finns inte robust gratis) |
| `data/wc2026_player_status.json` | Spelartillgänglighet (skador/avstängningar/osäkra) per spelar-id, med `source: {name, url}` och `detail` – visas i matchmodalens "Senaste nytt" (Avbräck & frågetecken), Inför-fliken, spelarprofilen och statistikfiltren. Poster med `manual: true` bevaras av synken |
| `server/scripts/syncAvailability.js` | Bygger spelartillgängligheten: avstängningar beräknas ur `results.json`/`matchdetails.json` (röda kort, ackumulerade gula – enstaka gula rensas efter kvartsfinal; källänk till ESPN-matchsidan) + skador/frågetecken ur ländernas egna medier via Google Nyheter-RSS (spelarnamnsmatchning mot truppen, svensk översättning, artikeln som källa; rykten kastas när spelaren spelat en senare match). Körs varje timme av `sync-player-status.yml` |
| `server/scripts/syncPlayerStatus.js` | Legacy: samma fil från API-Football `/injuries` (körs inte längre av workflow) |
| `data/team_news.json` | Landslagsnyheter per lag från respektive lands egna medier (Google Nyheter-RSS, lokala sökfrågor) med svensk sammanfattning per rubrik (`title_sv`, gratis Google Translate-gtx) – driver fliken "Senaste nytt" i matchmodalen |
| `server/scripts/syncTeamNews.js` | Synkar landslagsnyheterna (körs varannan timme av `sync-team-news.yml`) |
| `data/news_summaries.json` | "Redaktionens analys" per kommande slutspelsmatch (`k:NN`) i artikelform: `headline` (rubrik) + `lead` (ingress) + `paragraphs` + numrerade `references` (källa+rubrik+url) + **`prediction`** (troligt slutresultat, t.ex. "2–1 Brasilien") + **`predictionNote`** (kort brasklapp). **Skrivs automatiskt** av `syncNewsSummaries.js` (Gemini) ur färska källor: en stram analys (~315–390 ord) som lyfter fram de mest resultatavgörande faktorerna ur båda lägren och avslutas med en argumenterad prognos. Texten använder tre markörer som `matchinfo.js` (`miInlineNews`) renderar: `**fet**` (nyckelnamn/fakta), `*kursiv*` (citat/smeknamn) och `[[3]]`/`[[3,4]]` (upphöjd källhänvisning – siffran länkar till referens nr 3 i listan; `prediction`/`predictionNote` är rena, utan citat). Bara citerade källor hamnar i `references` (renumreras 1..N i citatordning). Poster med `manual: true` rörs aldrig (kan handskrivas); auto-poster får `generated: true` + `refsHash`. Driver matchmodalens "Redaktionens analys"-flik som förstahandsval; saknas matchen eller är `written` äldre än 5 dygn faller fliken tillbaka till rubriklistan ur `team_news.json` |
| `server/scripts/syncNewsSummaries.js` | Bygger "Redaktionens analys" automatiskt. Läser kommande slutspelsmatcher ur `results.json` (fixtures, båda lag klara + avspark inom 6 dygn), samlar färska referenser (ländernas egna medier för båda lagen + en matchspecifik lokal sökning som nämner motståndaren + internationell förhandssökning + en sökning om spelavgörande förhållanden (höjd/värme/plan) + avbräck ur spelarstatusen; dedupas, åldersfiltreras, rankas – lokala/konkreta upp, rena listningar/logistik ned, översätts till svenska med gratis gtx). **Läser dessutom artiklarnas brödtext**: löser ut Google Nyheters omdirigeringslänkar till riktiga URL:er (batchexecute), hämtar sidan och extraherar ren prosa (bäst-möjligt, faller tillbaka på rubriken). **Matar även in ett deterministiskt xG-underlag** per lag (`loadXgProfiles`/`xgSection` ur `fotmob_ratings.json`: mål/xG, insläppta/xGA, effektivitet, senaste matcherna) med tolkningsinstruktion, så prognosen väger vem som faktiskt skapar chanser mot vem som över-/underpresterar; xG-fingeravtrycket ingår i `refsHash` så artikeln regenereras när nytt xG landat. Låter sedan Gemini skriva en fyllig analysartikel `{headline, lead, paragraphs, prediction, predictionNote}` (~315–390 ord, 4–5 stycken, ingress ~35–50 ord) med `[[n]]`-citat och `**fet**`/`*kursiv*`, som väger samman så många källor/perspektiv som möjligt (båda ländernas hemmamedier framhävs) och **avslutas med en argumenterad prognos** (`prediction` = troligt slutresultat, `predictionNote` = brasklapp; renumreras/saneras i `renumberCitations`). **Läser även `data/analysis_lessons.json`** och matar in lärdomar + löpande träffsäkerhet (`lessonsSection`) i prompten så prognoserna lär av tidigare facit. **Trappa mot avspark**: regenererar glesare långt bort (var 24:e h) och tätare nära (ned till var 45:e min < 6 h kvar), bara när referenserna ändrats (`refsHash`). Slår primärmodellen i kvottaket (429) faller den över till `GEMINI_FALLBACK_MODEL` (gemini-2.0-flash). Körs var 30:e min av `sync-news-summaries.yml`. Exporterar sina hjälpare (fetch/översättning/artikeltext/Gemini) till `syncMatchReviews.js`; `main()` körs bara vid direktstart. Kräver `GEMINI_API_KEY`; `--dry-run`/`--force`/`--match k:NN` för test |
| `data/match_reviews.json` | "Facit" per spelad slutspelsmatch (`k:NN`): efteranalys som jämför förhandsprognosen med utfallet. Per match: `headline`/`lead`/`paragraphs`/`references` (samma markörer som analysen), `predicted` (tolkad prognos) + `actual` (facit ur matchdetails, inkl. **`actual.xg`** = matchens lag-xG som visas i Facit-kortet) + `verdict` ({winner, score} = hit/miss/na, **deterministiskt uträknat i kod**), `grade` ({verdict, score 0–5} = redaktionens självbetyg) och `lessons` (1–3 generella lärdomar, gärna xG-grundade). Toppnivå `accuracy` = redaktionens totala träffsäkerhet. Driver matchmodalens "Facit"-flik. Poster med `manual: true` rörs ej |
| `data/analysis_lessons.json` | Lärdomskorpus + träffsäkerhet, byggd **ur** `match_reviews.json` (derivat, dedupas, senaste först, cap 40). Läses av `syncNewsSummaries.js` och matas in i förhandsanalysernas prompt – återkopplingsslingan som gör att prognoserna lär av tidigare misstag |
| `server/scripts/syncMatchReviews.js` | Bygger "Facit" automatiskt. Läser spelade slutspelsmatcher ur `results.json` som HAR en färdig förhandsprognos i `news_summaries.json`. **Betygsätter prognosen deterministiskt** (`parsePrediction` tolkar "2–1 Brasilien"/"1–1, X på straffar", `gradePrediction` jämför vinnare + resultat mot facit ur `matchdetails.json`). Samlar färska matchrapporter/spelarbetyg/reaktioner (lokala medier + internationell rapportsökning; publicerade efter avspark) + statistik (matchdetails) + FotMob-betyg och **matchens xG** (lag-xG/xGOT + störst spelar-xG per lag, ur `fotmob_ratings.json`; xG:t ingår i `sourceHash` så sent backfillat xG triggar omskrivning, och Gemini instrueras skilja förtjänt seger/stulen vinst/brända lägen samt gärna göra en lärdom statistisk – missar på marginaler ska inte överkorrigeras). Låter Gemini skriva `{headline, lead, paragraphs, grade, lessons}` (~180–270 ord, 2–4 stycken, ingress ~20–30 ord) som förklarar VARFÖR prognosen slog in/missade. Bygger om `analysis_lessons.json` ur alla facit. Återanvänder hjälparna ur `syncNewsSummaries.js`. Regenererar bara när underlaget ändrats (`sourceHash`). Körs var 30:e min av `sync-match-reviews.yml`. Kräver `GEMINI_API_KEY`; `--dry-run`/`--force`/`--match k:NN` |
| `data/lineups_prelim.json` | Troliga startelvor för kommande matcher (≤48 h) från 365Scores webb-API; `status` slår om `probable` → `confirmed` när de officiella elvorna släpps (~1 h före avspark). Visas i matchmodalens "Laguppställning"-flik tills ESPN:s officiella lineups tar över i `matchdetails.json`; spelare med skade-/avstängningsstatus får varningsprick |
| `server/scripts/syncLineups.js` | Synkar troliga startelvor (körs var 15:e min av `sync-lineups.yml`; committar bara vid faktisk ändring). OBS: Sofascore ger 403 server-side – 365Scores är den öppna källan |
| `assets/playerstats.js` | Spelarstatistik: Spelare/Lag/Region/Ligor. **Betyget är FotMobs Opta-baserade matchbetyg** (ur `data/fotmob_ratings.json`, kopplat på ESPN-lineupnamn i `addSideMatch`, minutviktat via ESPN-minuter i `rSum`/`rMin`) – fångar defensivt spel som ESPN:s gratisdata saknar. Samma betyg driver spelar-, lag-, regions- och ligasnitt samt Ligor-flikens ±Renommé/scatter (betyg ~ renommé-regression). Spelare utan FotMob-betyg visas som "–". **xG-effektivitet** ur samma fil: Spelare-fliken har xG + ±xG (mål − xG, mål/xG räknat i matcher MED xG-underlag via `xgApps`/`xgGoals` så diffen jämför äpplen med äpplen), Lag-fliken xG/±xG/xGA/±xGA (±xGA = xGA − insläppta, positivt = försvar/målvakt över förväntan) + topplistekorten "Kliniska lag/avslutare" – fångar Marocko/Norge-arketypen: få chanser men effektiva. (Det tidigare egna transparenta VM-betyget är borttaget – se git-historik om det behövs igen) |
| `data/fotmob_ratings.json` | FotMobs spelarbetyg + xG per match för färdigspelade matcher, nycklat på matchnyckel → `players.{h,a}.{espnNormNamn: betyg}` + `teamRating` + `fotmobId` + **`xg`/`xgot`** ({h,a} lag-xG ur Opta-matchstatistiken) + **`playerXg.{h,a}.{espnNormNamn: {xg, xgot, shots, goals}}`** (summerad skott-för-skott ur shotmap; straffläggning + självmål exkl., matchstraffar ingår). Nycklas på ESPN:s normaliserade spelarnamn så frontenden bara slår upp exakt. ~96% täckning av startspelare (luckor = arabisk translitterering + sena inhopp FotMob inte betygsatt). Driver xG-formen i matchmodalens "Fakta & odds" + xG-kolumnerna i statistiken |
| `server/scripts/syncFotmobRatings.js` | Bygger FotMob-betygen + xG:t: matchar VM-matcher via FotMobs datum-API (`parentLeagueId === 77`) → hämtar `matchDetails` → kopplar `performance.rating` och shotmap-xG till ESPN-lineupens namn (`data/matchdetails.json`) med greedy namnmatchare (exakt → sorterad token-mängd för koreanska/japanska rotationer → token-subset för kortnamn); lag-xG/xGOT ur `content.stats` (skottsummor som reserv). Inkrementell (färdiga matchers betyg behålls; poster utan xg-fält hämtas om en gång = backfill), ingen nyckel. Körs var 30:e min av `sync-fotmob-ratings.yml` |
| `assets/styles.css` | All CSS |
| `server/index.js` | Express-server + WebSocket |
| `server/espnSync.js` | ESPN API-synk |
| `server/mapResults.js` | Mappar ESPN-data till interna nycklar |
| `data/results.json` | Statisk resultatfil (uppdateras av Actions) |
| `data/matchdetails.json` | Statisk matchdetaljer (uppdateras av Actions) |
| `data/bracket_probs.json` | Sannolikheter för slutspelet (statisk fallback, byggd av `gen_bracket_probs.mjs`) |
| `data/bracket_probs_pre.json` | Fryst förväntansbaslinje (turneringsstartens rundsannolikheter) för Ligor-flikens Δ Förväntan – ändra ej |
| `data/club_leagues.json` | Klubb → liga (land + division 2025/26) för alla klubbar i trupperna; driver Ligor-fliken i statistiken. `rep` = ligans renommé 0–100 inför VM (fryst baslinje för ±Renommé – ändra ej under turneringen) |
| `scripts/prob/gen_bracket_probs.mjs` | Bygger `bracket_probs.json` med SAMMA motor/data/seed som frontend |
| `scripts/prob/` | Odds-hämtning + karta (bracket_map). `vm_sannolikheter.py` är pensionerad referens |
| `.github/workflows/` | GitHub Actions-workflows |
| `render.yaml` | Deploy-config för Render |

## Sannolikheter – EN motor överallt
All sannolikhet/odds på sidan kommer från **en** motor: `assets/bracketengine.js`.
- Slutspelsträdet, slutspelskalkylatorn och sextondelskollen kör alla med **n = 40000** (`SIM_N` i `app.js`) och **seed 0x9e3779b9** → identisk slumptalsström → exakt samma siffror i alla vyer. Ändra aldrig n/seed på ett ställe utan de andra (inkl. `VM_N_SIMS` i `sync-bracket-probs.yml`).
- Kalkylatorns körning matar även trädets `bracketProbs` (fokuslaget påverkar inte siffrorna eftersom fokus-spårningen inte drar slumptal).
- Visade vinstchanser ("ni vinner X %") går genom `matchWinP()` i `app.js`: marknadsodds/facit för riktiga slutspelsmatcher → motorns analytiska Poisson-modell (`BracketEngine.buildMatchModel`) → logistisk på vinnarodds → FIFA-ranking. Samma prioritetsordning som simuleringen själv.
- Statiska `data/bracket_probs.json` byggs av `scripts/prob/gen_bracket_probs.mjs` (GitHub Actions) med samma motor, data och seed – fallbacken kan inte avvika från lokal beräkning. Indata-bygget är en 1:1-portering av `bracketBuildInput()` i `app.js`; ändras den ena ska den andra ändras.

## Miljövariabler (.env)
```
DATABASE_URL=          # Neon Postgres (valfritt)
API_FOOTBALL_KEY=      # Spelarstatistik (valfritt)
GEMINI_API_KEY=        # Skriver matchartiklarna (sync:summaries). Gratis nyckel från Google AI Studio. I GitHub Actions läggs den som repo-secret GEMINI_API_KEY
GEMINI_MODEL=          # Modell för artiklarna (default gemini-2.5-flash)
FD_POLL_LIVE_SECONDS=  # Pollintervall live (default 120)
FD_POLL_MATCHDAY_SECONDS= # Pollintervall matchdag (default 300)
FD_POLL_IDLE_SECONDS=  # Pollintervall vila (default 900)
```

## Deploy
- **Frontend:** GitHub Pages, branch `main`, rot `/`. Domän: `gravergrav.se` (CNAME i reporoten).
- **Backend:** Render, start command `npm start`.
- **GitHub Actions:** Synkar ESPN-data automatiskt, committar ändringar till repot.
