// Write docs/TESTNET.md from the recorded deployment and live runs. Read-only.
import fs from "node:fs";
import path from "node:path";
import { ROOT, deployment, view, fmt, EXPLORER } from "./lib.mjs";

const d = deployment();
const e2e = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet-e2e.json"), "utf8"));
const lines = [];
const out = (s = "") => lines.push(s);
const link = (u) => (u ? `[tx](${u})` : "");

out("# Testnet evidence");
out();
out("Everything here can be checked on the explorer, or with `node scripts/verify.mjs`, which needs no keys.");
out();
out(`- Contract: [\`${d.contract}\`](${EXPLORER}/address/${d.contract}), code sha256 \`${d.code?.sha256}\` (${d.code?.bytes} bytes)`);
out(`- DAO: [\`${d.dao}\`](${EXPLORER}/address/${d.dao}), council ${d.council.map((c) => `\`${c}\``).join(", ")}`);
out(`- near.social data: ${"`"}social.testnet${"`"}, read at https://kv.test.fastnear.com/v0/latest/social.testnet/${d.contract}`);
out();
out("## Setup transactions");
out();
const t = d.transactions || {};
out(`| Step | Transaction |`);
out(`|---|---|`);
if (t.deploy) out(`| Deploy the contract | ${link(t.deploy)} |`);
if (t.init) out(`| Initialise it (factory \`sputnikv2.testnet\`, near.social \`social.testnet\`) | ${link(t.init)} |`);
if (t.dao) out(`| Create the DAO through the Sputnik factory | ${link(t.dao)} |`);
if (t.treasury) out(`| Put 1.5 NEAR in its treasury | ${link(t.treasury)} |`);
out(`| Council proposals #0 (add the Kitty role) and #1 (set its terms), each filed and passed by two council votes | read them with \`get_proposal\` on the DAO, or \`node scripts/verify.mjs\` |`);
if (t.role) out(`| Council proposal #0: add the Kitty role (file, then two votes) | ${t.role.map(link).join(" ")} |`);
if (t.terms) out(`| Council proposal #1: set Kitty's terms | ${t.terms.map(link).join(" ")} |`);
if (t.warmup) out(`| Warm-up circle: create and close its three rounds | ${t.warmup.map(link).join(" ")} |`);
out();
for (const [key, title] of [["attacks", "Refusals"], ["auto", "Scenario A: small covers, passed by Kitty's own vote"], ["council", "Scenario B: a large cover, passed by the council"]]) {
  const r = e2e[key];
  if (!r) continue;
  out(`## ${title}`);
  out();
  out(`Run at ${r.ran_at}: ${r.passed} passed, ${r.failed} failed.`);
  out();
  out("| Check | Result | Detail |");
  out("|---|---|---|");
  for (const c of r.checks) out(`| ${String(c.name).replace(/[|]/g, "/")} | ${c.ok ? "ok" : "FAIL"} | ${String(c.detail ?? "").replace(/[|]/g, "/").slice(0, 160)} ${link(c.link)} |`);
  out();
}
out("## The demo circle, from the chain");
out();
const circles = await view(d.contract, "list_circles", { from: 0, limit: 100 });
const demo = circles.filter((c) => c.name === "December rent").pop();
if (demo) {
  out(`Circle #${demo.id}, "${demo.name}", ${demo.status}. near.social thread root: \`${d.contract}/${demo.thread}\`.`);
  out();
  out("| Round | Took the pot | Paid out | Credit | Held back | DAO cover |");
  out("|---|---|---|---|---|---|");
  for (const l of demo.log) out(`| ${l.round} | \`${l.recipient}\` | ${fmt(l.paid)} | ${fmt(l.backed)} | ${fmt(l.holdback)} | ${BigInt(l.covered) ? `${fmt(l.covered)} NEAR, proposal #${l.cover_proposal}` : "–"} |`);
  out();
}
const book = (await view(d.contract, "get_dao", { dao: d.dao })).book;
out(`DAO book now: ${book.covers} covers for ${fmt(book.covered)} NEAR, ${fmt(book.recovered)} NEAR back, ${fmt(book.debts)} NEAR owed, ${fmt(book.exposure)} NEAR of credit out.`);
fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "TESTNET.md"), lines.join("\n") + "\n");
console.log(`wrote docs/TESTNET.md (${lines.length} lines)`);
