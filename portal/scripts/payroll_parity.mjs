// 薪资计算对照：拿 HR 原本薪资系统的 index.html（不在 repo 里）里的 calcBase / calcComm，
// 跟 src/payroll/calc.ts 用同一批随机输入逐笔比对，任何一个数字不同就失败。
// 用法：node scripts/payroll_parity.mjs <原系统 index.html 的路径> [组数]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const html = fs.readFileSync(process.argv[2], "utf8");
const N = +(process.argv[3] || 20000);
const lines = html.split("\n");
const start = lines.findIndex((l) => l.startsWith("const DEF_SET={"));
const from = lines.findIndex((l) => l.startsWith("const r2="));
const to = lines.findIndex((l) => l.startsWith("/* ===== 视图 ===== */"));
if (start < 0 || from < 0 || to < 0) throw new Error("原系统程式的结构变了，找不到计算段落");
let defEnd = start; while (!lines[defEnd].includes("};")) defEnd++;
const orig = [lines.slice(start, defEnd + 1).join("\n"), "let S={set:{...DEF_SET}};", lines.slice(from, to).join("\n"),
  "export { calcBase, calcComm, workDays, inMonth, absentDays, epfWage, eisAmt, S };"].join("\n");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parity-"));
fs.writeFileSync(path.join(tmp, "orig.mjs"), orig);
execFileSync("npx", ["esbuild", path.resolve("src/payroll/calc.ts"), "--format=esm", "--log-level=warning",
  "--outfile=" + path.join(tmp, "calc.mjs")]);
const O = await import(pathToFileURL(path.join(tmp, "orig.mjs")).href);
const C = await import(pathToFileURL(path.join(tmp, "calc.mjs")).href);

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const money = () => pick([0, 0, 1500, 1700, 1800.5, 2000, 2450, 3000, 3000.01, 3500, 4999.99, 5000, 5000.01, 6000, 6800,
  12345.67, 20000, 25000, Math.round(rnd() * 900000) / 100, Math.round(rnd() * 10000)]);
const small = () => pick([0, 0, 0, 1, 2, 3, 4, 5, 6, 0.5, 1.5, 2.25, 10, 26, 30, -1, "", "3", Math.round(rnd() * 400) / 10]);
const date = () => pick(["", "", "", "2025-12-15", "2026-02-10", "2026-02-28", "2026-03-01", "2026-07-15", "2026-07-31", "2026-08-01"]);

let fails = 0, done = 0;
for (let k = 0; k < N; k++) {
  const e = {
    base: money(), category: pick(["local", "local", "local60", "foreign", undefined]), epfOptIn: rnd() < 0.3,
    skbbk: pick([true, false, undefined]), noEpf: rnd() < 0.1, noSocso: rnd() < 0.1, noEis: rnd() < 0.1,
    commType: pick(["none", "percent", "fixed", undefined]), commRate: pick([0, 1, 1.5, 2, 3, 300, 450.55, -5]),
    groupComm: pick([true, false, undefined]), commOnly: rnd() < 0.1, commWithBase: rnd() < 0.15,
    joinDate: date(), leaveDate: date(), status: pick(["active", "left", undefined]),
  };
  const i = {
    year: 2026, month: pick([1, 2, 3, 7, 8, 11, 12]), workDays: pick([0, 0, "", 24, 26, 27, 25.5]),
    otHours: small(), unpaidDays: small(), pcb: pick([0, 50, 120.5, -10]), advance: pick([0, 100, -50, 33.33]),
    basePayComm: money(), baseSales: money(), baseRate: pick([null, "", 1, 2.5, "3"]), baseExtraComm: pick([0, 20, 55.5]),
    sales: money(), commGroup: pick([0, 100, 250.55, 800]), wrongQty: pick([0, 0, 1, 3, 12]),
    lateCount: pick([0, 1, 2, 3, 4, 5, 6, 9]), otherDeduct: pick([0, 30, -40, 1000]),
  };
  for (const [name, f, g] of [["calcBase", O.calcBase, C.calcBase], ["calcComm", O.calcComm, C.calcComm]]) {
    const a = f(e, i), b = g(e, i, O.S.set);
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    const bad = ka.join() !== kb.join() ? ["keys"] : ka.filter((x) => !Object.is(a[x], b[x]));
    done++;
    if (bad.length) {
      if (++fails <= 5) console.log("MISMATCH", name, bad, JSON.stringify({ e, i }), bad.map((x) => [a[x], b[x]]));
    }
  }
  for (const [y, m] of [[2026, i.month]]) {
    if (O.workDays(y, m) !== C.workDays(y, m) || O.inMonth(e, y, m) !== C.inMonth(e, y, m) || O.absentDays(e, y, m) !== C.absentDays(e, y, m)) {
      if (++fails <= 5) console.log("MISMATCH helpers", JSON.stringify(e), m);
    }
  }
}
for (let w = 0; w <= 25000; w += 0.37) {
  if (O.epfWage(w) !== C.epfWage(w) || O.eisAmt(w) !== C.eisAmt(w)) { if (++fails <= 5) console.log("MISMATCH table", w); }
}
console.log(`${done} 次计算比对、EPF/EIS 级距 0–25000 全扫，不一致 ${fails} 笔`);
process.exit(fails ? 1 : 0);
