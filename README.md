# VM 2026 – Grupper, slutspel & kalender

Webbapp för att följa fotbolls-VM 2026 (USA, Mexiko, Kanada): grupptabeller, slutspelsträd, kalender och **automatiskt uppdaterade resultat** via [football-data.org](https://www.football-data.org/).

Grupptabellerna och slutspelsträdet räknas ut från matchresultat i realtid – samma logik som vid manuell inmatning, men resultaten hämtas automatiskt från API:t.

## Auto-uppdatering på GitHub Pages (standard, ingen server)

Sidan körs på GitHub Pages och uppdateras automatiskt utan att någon server behöver vara igång:

```
GitHub Actions (var 10:e min)  →  football-data.org  →  data/results.json (committas)
                                                                ↓
                              GitHub Pages serverar filen  →  app.js (tabeller, träd, kalender)
```

- En schemalagd workflow (`.github/workflows/sync-results.yml`) kör `npm run sync:static`, som hämtar alla VM-matcher och skriver **`data/results.json`**.
- Ändras något committas filen automatiskt. GitHub Pages publicerar den och sidan läser den direkt (`window.VM_CONFIG.staticResults`).
- Tabeller räknas ut i webbläsaren från resultaten – ingen separat standings-API behövs.

**Engångsuppsättning – lägg in API-token som secret:**

1. Skaffa gratis token: [football-data.org/client/register](https://www.football-data.org/client/register)
2. På GitHub: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `FOOTBALL_DATA_TOKEN`
   - Value: din token
3. Kör workflowen första gången manuellt: **Actions → Synka VM-resultat → Run workflow** (sen sköts allt automatiskt).

> football-data.org gratisplan är **fördröjd** (inte sekundsnabbt live). Det räcker gott för grupptabeller och slutspel. GitHub Actions kör schemat "best effort", oftast var 10:e minut.

## Snabbstart (lokalt med auto-uppdatering)

Förutsätter [Node.js](https://nodejs.org/) 18+.

```bash
npm install
copy .env.example .env   # PowerShell/CMD – eller cp på mac/linux
# Fyll i FOOTBALL_DATA_TOKEN i .env
npm start
```

Öppna **http://localhost:3000**. Badgen **Auto** i topbaren visar att resultat synkas. Grupper, tabeller och slutspel uppdateras automatiskt.

### football-data.org (primär datakälla)

Gratis token: [football-data.org/client/register](https://www.football-data.org/client/register)

```
FOOTBALL_DATA_TOKEN=din_token
FD_COMPETITION=WC
FD_SEASON=2026
```

På gratisplanen är resultat **fördröjda** (inte live under match). Under VM kan du uppgradera till deras live-plan (~€12/mån) om du vill ha mål i realtid. Appen pollar ändå smart:

| Läge | Intervall (standard) |
|------|----------------------|
| Live-matcher pågår | 120 s |
| Turnering pågår (11 jun – 19 jul 2026) | 300 s |
| Utanför turneringen | 900 s |

Justera i `.env`: `FD_POLL_LIVE_SECONDS`, `FD_POLL_MATCHDAY_SECONDS`, `FD_POLL_IDLE_SECONDS`.

Manuell synk:

```bash
npm run sync          # uppdaterar serverns datalager (server/data/results.json)
npm run sync:static   # skriver data/results.json som GitHub Pages-sidan läser
```

### API-Football (valfritt – spelarstatistik)

Kräver betald plan för VM 2026. Utan nyckel fungerar resultat-synken ändå.

```
API_FOOTBALL_KEY=din_nyckel
```

```bash
npm run squads   # hämtar trupper (nattligt via schemaläggaren)
```

## Hur det fungerar

```
football-data.org  →  sync-jobb (scheduler)  →  results store  →  /api/results + WebSocket
                                                                        ↓
                                                              app.js (tabeller, träd, kalender)
```

- **Resultat** mappas till samma nycklar som manuell inmatning (`g:A:0`, `k:73` …).
- **Tabeller** beräknas i webbläsaren från resultaten (`computeTable`) – ingen separat standings-API behövs.
- **WebSocket** (`/ws`) skickar `results:updated` så sidan uppdateras direkt efter varje sync.
- **Lager:** `server/data/results.json` lokalt, eller **Neon Postgres** med `DATABASE_URL`.

### Neon (valfritt, rekommenderat i drift)

1. Skapa databas på [neon.tech](https://neon.tech).
2. Kopiera connection string till `.env`:

```
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
```

Tabellen `vm_results` skapas automatiskt vid första sync. Utan `DATABASE_URL` sparas allt i JSON-fil (fungerar på Render men försvinner vid redeploy på free tier).

## Bara frontend (utan backend)

På GitHub Pages läser sidan automatiskt `data/results.json` (uppdateras av GitHub Actions) – ingen server behövs. Vill du testa lokalt utan server, servera mappen via t.ex. `npx serve` så att `data/results.json` kan läsas (öppnar du filen direkt via `file://` blockerar webbläsaren ibland inläsningen).

## Deploya backend

GitHub Pages kan **inte** köra Node. Använd t.ex. [Render](https://render.com/) (gratis tier räcker för VM):

1. Pusha repot till GitHub.
2. Render → **New Web Service** → koppla repot (eller använd `render.yaml` i roten).
3. Miljövariabler:
   - `FOOTBALL_DATA_TOKEN` (obligatorisk)
   - `DATABASE_URL` (rekommenderad – Neon)
   - `API_FOOTBALL_KEY` (valfritt)
4. Start command: `npm start`
5. Öppna din Render-URL – sidan och API:t serveras från samma host.

**Frontend på GitHub Pages + backend på Render:** sätt backend-URL i `index.html`:

```html
<script>window.VM_CONFIG = { backend: "https://din-app.onrender.com" };</script>
```

## Publicera på GitHub Pages

1. Ladda upp repot till GitHub.
2. **Settings → Pages** → branch `main`, mapp **/ (root)**.
3. Sidan: **https://tomaslaino.github.io/VM2026/**

Utan `VM_CONFIG.backend` läser sidan den statiska `data/results.json` som GitHub Actions uppdaterar (se [Auto-uppdatering på GitHub Pages](#auto-uppdatering-på-github-pages-standard-ingen-server) ovan) – det är standardläget och kräver ingen server.

### Egen domän (gravaguld.se)

Lägg **inte** till Custom domain förrän DNS är aktiv. Om `github.io` omdirigerar till en domän som inte svarar: ta bort Custom domain under **Settings → Pages**.
