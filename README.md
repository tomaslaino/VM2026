# VM 2026 – Grupper, slutspel & kalender

Webbapp för att följa fotbolls-VM 2026 (USA, Mexiko, Kanada): grupptabeller, slutspelsträd, kalender och **automatiskt uppdaterade resultat, livehändelser & matchstatistik** via ESPN:s öppna API (ingen API-nyckel behövs).

Grupptabellerna och slutspelsträdet räknas ut från matchresultat i realtid – samma logik som vid manuell inmatning, men resultaten hämtas automatiskt från API:t.

## Auto-uppdatering på GitHub Pages (standard, ingen server)

Sidan körs på GitHub Pages och uppdateras automatiskt utan att någon server behöver vara igång:

```
GitHub Actions (var 3:e min)  →  ESPN (öppet API)  →  data/results.json + data/matchdetails.json
                                                                ↓
                              GitHub Pages serverar filerna  →  app.js (tabeller, träd, kalender, matchmodal)
```

- En schemalagd workflow (`.github/workflows/sync-results.yml`) kör `npm run sync:static`, som hämtar alla VM-matcher och skriver **`data/results.json`** (resultat/schema/tabeller) samt **`data/matchdetails.json`** (mål, kort, byten, statistik).
- Ändras något committas filerna automatiskt. GitHub Pages publicerar dem och sidan läser dem direkt (`window.VM_CONFIG.staticResults` / `staticDetails`).
- Tabeller hämtas från ESPN:s officiella ställning och räknas dessutom ut i webbläsaren från resultaten.
- **Ingen API-nyckel eller secret behövs** – ESPN:s API är öppet.

**Uppdateringsfrekvens (smart):**

| Läge | GitHub Actions (hämtar API) | Sidan (läser results.json) |
|------|----------------------------|----------------------------|
| Live-match pågår | Var 3:e min (alltid) | Var 30:e sekund |
| Match startar inom 90 min | Var 3:e min (alltid) | Var 60:e sekund |
| Match nyligen avslutad | Var 3:e min (alltid) | Var 90:e sekund |
| Matchdag, lugnt | Var 5:e min | Var 3:e minut |
| Ingen match idag | Var 30:e min | Var 10:e minut |
| Utanför VM-perioden | Var 6:e timme | Var 30:e minut |

Workflowen körs var 3:e minut men **hoppar över API-anrop** i lugna perioder för att spara kvot.

## Snabbstart (lokalt med auto-uppdatering)

Förutsätter [Node.js](https://nodejs.org/) 18+.

```bash
npm install
npm start
```

Öppna **http://localhost:3000**. Badgen **Auto** i topbaren visar att resultat synkas. Grupper, tabeller och slutspel uppdateras automatiskt – ingen API-nyckel behövs.

### ESPN (primär datakälla)

Resultat, livehändelser (mål/kort/byten) och matchstatistik hämtas från ESPN:s öppna API – samma data som espn.com visar, utan nyckel och utan kvotbegränsning i praktiken. Appen pollar smart:

| Läge | Intervall (standard) |
|------|----------------------|
| Live-matcher pågår | 120 s |
| Turnering pågår (11 jun – 19 jul 2026) | 300 s |
| Utanför turneringen | 900 s |

Justera i `.env`: `FD_POLL_LIVE_SECONDS`, `FD_POLL_MATCHDAY_SECONDS`, `FD_POLL_IDLE_SECONDS`.

Manuell synk:

```bash
npm run sync          # uppdaterar serverns datalager (server/data/results.json)
npm run sync:static   # skriver data/results.json + data/matchdetails.json (GitHub Pages)
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
ESPN (öppet API)  →  sync-jobb (scheduler)  →  results store  →  /api/results + WebSocket
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
   - `DATABASE_URL` (rekommenderad – Neon)
   - `API_FOOTBALL_KEY` (valfritt – spelarstatistik)
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

### Egen domän (gravergrav.se)

Filen `CNAME` i reporoten pekar GitHub Pages mot **gravergrav.se**.

1. **DNS** hos domänregistratorn (ersätt ev. gamla gravaguld.se-poster):
   - **A** för `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - valfritt **CNAME** för `www` → `tomaslaino.github.io`
2. När DNS svarar: **GitHub → Settings → Pages → Custom domain** → `gravergrav.se`, aktivera **Enforce HTTPS**.
3. Ta bort `gravaguld.se` från Custom domain om den fortfarande ligger kvar.

Lägg **inte** till Custom domain förrän DNS är aktiv. Om `github.io` omdirigerar till en domän som inte svarar: ta bort Custom domain under **Settings → Pages**.
