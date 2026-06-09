import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(__dir, "../../assets/data.js");

const gen = spawnSync("node", ["server/scripts/buildBroadcastMap.js"], {
  cwd: path.join(__dir, "../.."),
  encoding: "utf8",
});
if (gen.status !== 0) {
  console.error(gen.stderr);
  process.exit(1);
}

const block = gen.stdout.replace(/^\/\* AUTO-GENERERAD.*\n/, "/* TV4/SVT-tabla – genereras med node server/scripts/buildBroadcastMap.js */\n");

let data = fs.readFileSync(dataPath, "utf8");
const start = data.indexOf("/* TV-sändning");
if (start === -1) {
  console.error("Could not find TV block in data.js");
  process.exit(1);
}
data = data.slice(0, start) + block;
fs.writeFileSync(dataPath, data);
console.log("Patched assets/data.js");
