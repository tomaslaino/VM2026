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

### Nyckelkommandon
```bash
npm start          # starta server (http://localhost:3000)
npm run dev        # starta med --watch (auto-restart)
npm run sync       # synka resultat till server/data/results.json
npm run sync:static # synka till data/results.json + data/matchdetails.json (GitHub Pages)
npm run sync:status # synka spelarstatus (skador/avstängningar) → data/wc2026_player_status.json (kräver API_FOOTBALL_KEY)
```

## Viktiga filer
| Fil/mapp | Roll |
|---|---|
| `index.html` | Ingångspunkt, innehåller `window.VM_CONFIG` |
| `assets/app.js` | Huvudlogik: tabeller, slutspelsträd, kalender |
| `assets/matchinfo.js` | Matchmodal med detaljer/statistik |
| `assets/r32engine.js` | Monte Carlo-motor: simulerar vem man möter i R32 utifrån odds (delas av huvudtråd + worker) |
| `assets/r32worker.js` | Web Worker som kör `r32engine.js` utanför huvudtråden |
| `data/odds.json` | Exakta resultat-odds för de återstående gruppmatcherna (indata till R32-motorn) |
| `assets/players.js` | Statiskt datalager för truppdata + spelarstatus (`window.VMPlayers`) |
| `assets/live.js` | Trupp i lag-lådan + spelarprofil-modal (visar skade-/avstängningsstatus) |
| `data/wc2026_player_status.json` | Spelartillgänglighet (skador/avstängningar/osäkra) per spelar-id |
| `server/scripts/syncPlayerStatus.js` | Synkar spelarstatus från API-Football `/injuries` |
| `assets/playerstats.js` | Spelarstatistik |
| `assets/styles.css` | All CSS |
| `server/index.js` | Express-server + WebSocket |
| `server/espnSync.js` | ESPN API-synk |
| `server/mapResults.js` | Mappar ESPN-data till interna nycklar |
| `data/results.json` | Statisk resultatfil (uppdateras av Actions) |
| `data/matchdetails.json` | Statisk matchdetaljer (uppdateras av Actions) |
| `data/bracket_probs.json` | Sannolikheter för slutspelet (statisk fallback, byggd av `gen_bracket_probs.mjs`) |
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
FD_POLL_LIVE_SECONDS=  # Pollintervall live (default 120)
FD_POLL_MATCHDAY_SECONDS= # Pollintervall matchdag (default 300)
FD_POLL_IDLE_SECONDS=  # Pollintervall vila (default 900)
```

## Deploy
- **Frontend:** GitHub Pages, branch `main`, rot `/`. Domän: `gravergrav.se` (CNAME i reporoten).
- **Backend:** Render, start command `npm start`.
- **GitHub Actions:** Synkar ESPN-data automatiskt, committar ändringar till repot.
