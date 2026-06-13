#!/usr/bin/env node
/*
  Genererar scripts/prob/bracket_map.json ur de AUKTORITATIVA repo-källorna:
    - assets/data.js   -> WC.knockout (FIFA:s officiella R32-parningar + trädet)
    - assets/annexc.js -> ANNEX_C (FIFA Annex C, 495 kombinationer för bästa treorna)

  Detta är sanningskällan för vm_sannolikheter.py:s build_bracket(). Inget i
  R32-strukturen hårdkodas här – allt härleds. Kör om när data.js/annexc.js ändras:

    node scripts/prob/gen_bracket_map.mjs
*/
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// Eval:a JS-filerna i en vm-kontext där window === globalThis (browser-stil),
// så att både `window.WC = {}` och senare bara `WC` fungerar.
function loadGlobals(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

const { WC } = loadGlobals("assets/data.js");
const annex = loadGlobals("assets/annexc.js");
const ANNEX_C = annex.ANNEX_C;
const ANNEX_C_SLOTS = annex.ANNEX_C_SLOTS;          // ["A","B","D","E","G","I","K","L"]
const ANNEX_C_SLOT_MATCH = annex.ANNEX_C_SLOT_MATCH; // {A:79,...}

const byNo = {};
WC.knockout.forEach((m) => (byNo[m.m] = m));

// Vilken winner-slot (A,B,D,...) hör en R32-match till? (omvänd ANNEX_C_SLOT_MATCH)
const matchToSlot = {};
for (const [slot, mno] of Object.entries(ANNEX_C_SLOT_MATCH)) matchToSlot[mno] = slot;

// Linjärisera slutspelsträdet: in-order-traversal från finalen ned till R32,
// så att position-paren (0,1),(2,3)... i motorn matchar de riktiga R16/QF/...-paren.
function expand(no) {
  const m = byNo[no];
  if (m.round === "R32") return [no];
  return [...expand(m.home.m), ...expand(m.away.m)];
}
const FINAL = WC.knockout.find((m) => m.round === "FINAL");
const r32MatchOrder = expand(FINAL.m); // 16 R32-matchnummer i linjär ordning

if (r32MatchOrder.length !== 16) {
  throw new Error(`Förväntade 16 R32-matcher, fick ${r32MatchOrder.length}`);
}

// Bygg spec + label per R32-position (32 st: home,away för varje match i ordning).
function slotSpec(side, mno) {
  if (side.t === "w") return { kind: "dir", code: `1${side.g}`, label: `1${side.g}` };
  if (side.t === "r") return { kind: "dir", code: `2${side.g}`, label: `2${side.g}` };
  if (side.t === "3") {
    const slot = matchToSlot[mno];
    if (!slot) throw new Error(`Ingen Annex C-slot för match ${mno}`);
    const elig = side.from.slice().sort().join("");
    return { kind: "third", slot, elig: side.from.slice().sort(), label: `3/${elig}` };
  }
  throw new Error(`Okänd slot-typ '${side.t}' i match ${mno}`);
}

const order = [];
const labels = [];
for (const mno of r32MatchOrder) {
  const m = byNo[mno];
  for (const side of [m.home, m.away]) {
    const spec = slotSpec(side, mno);
    order.push(spec);
    labels.push(spec.label);
  }
}

// --- Valideringar (fail-fast hellre än tyst fel) ---
const dirCodes = order.filter((s) => s.kind === "dir").map((s) => s.code);
const thirdSlots = order.filter((s) => s.kind === "third").map((s) => s.slot);
// 24 direktplatser (12 ettor + 12 tvåor) och 8 trea-platser.
if (dirCodes.length !== 24) throw new Error(`Förväntade 24 direktplatser, fick ${dirCodes.length}`);
if (thirdSlots.length !== 8) throw new Error(`Förväntade 8 trea-platser, fick ${thirdSlots.length}`);
const wantWinners = "ABCDEFGHIJKL".split("").map((g) => `1${g}`);
const wantRunners = "ABCDEFGHIJKL".split("").map((g) => `2${g}`);
for (const c of [...wantWinners, ...wantRunners]) {
  if (!dirCodes.includes(c)) throw new Error(`Saknar direktplats ${c}`);
}
// Trea-slottarna ska exakt vara ANNEX_C_SLOTS.
if ([...thirdSlots].sort().join("") !== [...ANNEX_C_SLOTS].sort().join("")) {
  throw new Error(`Trea-slottar ${thirdSlots} matchar inte ANNEX_C_SLOTS ${ANNEX_C_SLOTS}`);
}

const out = {
  _source: "Genererad av scripts/prob/gen_bracket_map.mjs ur assets/data.js + assets/annexc.js",
  r32MatchOrder,
  order,
  labels,
  annexCSlots: ANNEX_C_SLOTS,
  annexC: ANNEX_C,
};
const outFile = path.join(__dirname, "bracket_map.json");
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`OK -> ${path.relative(ROOT, outFile)}`);

// ---- teams.json: kanoniska lagnamn (= data.js) + alias-karta ----
// Sanningskälla för lagidentitet i hela sannolikhetspipan. Kanoniskt namn =
// data.js `name`; alias mappar ESPN-/odds-API-stavningar -> kanoniskt namn.
const norm = (s) =>
  (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const teams = [];
const aliases = {};
for (const [group, arr] of Object.entries(WC.groups)) {
  arr.forEach((t, idx) => {
    teams.push({ name: t.name, sv: t.sv, iso: t.iso, group, idx });
    aliases[norm(t.name)] = t.name; // kanoniskt -> sig själv
    if (t.sv) aliases[norm(t.sv)] = t.name; // svenskt namn -> kanoniskt
  });
}
// Kända varianter från ESPN och The Odds API (normaliserat -> kanoniskt namn).
const EXTRA = {
  unitedstates: "USA",
  unitedstatesofamerica: "USA",
  congodr: "DR Congo",
  korearepublic: "South Korea",
  republicofkorea: "South Korea",
  cotedivoire: "Ivory Coast",
  turkey: "Türkiye",
  czechrepublic: "Czechia",
  bosniaandherzegovina: "Bosnia-Herzegovina",
  caboverde: "Cape Verde",
  capoverde: "Cape Verde",
  republicofireland: "Ireland",
};
for (const [k, v] of Object.entries(EXTRA)) {
  const canon = teams.find((t) => t.name === v);
  if (canon) aliases[k] = v; // lägg bara till alias för lag som faktiskt deltar
}
const teamsOut = {
  _source: "Genererad av scripts/prob/gen_bracket_map.mjs ur assets/data.js",
  teams,
  aliases,
};
const teamsFile = path.join(__dirname, "teams.json");
fs.writeFileSync(teamsFile, JSON.stringify(teamsOut, null, 2));
console.log(`OK -> ${path.relative(ROOT, teamsFile)}  (${teams.length} lag, ${Object.keys(aliases).length} alias)`);
console.log(`R32-matchordning: ${r32MatchOrder.join(", ")}`);
console.log(`Direktplatser: ${dirCodes.length}, trea-platser: ${thirdSlots.length} (${thirdSlots.join(",")})`);
console.log(`Annex C-rader: ${Object.keys(ANNEX_C).length}`);
console.log(`Labels (R32): ${labels.join(" ")}`);
