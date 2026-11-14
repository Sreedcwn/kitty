// Live checks against NEAR testnet: run real circles with real misses and check every number.
//
//   node scripts/e2e.mjs            both scenarios
//   node scripts/e2e.mjs auto       only scenario A (small covers, Kitty's own vote)
//   node scripts/e2e.mjs council    only scenario B (a large cover the council must approve)
//   node scripts/e2e.mjs attacks    only the refusals
//
// Writes every transaction and result to deployments/testnet-e2e.json. Needs the demo
// accounts' keys, so only the deployer can run it; anyone can read the results and follow
// the links.

import fs from "node:fs";
import path from "node:path";
import { ROOT, deployment, view, call, mustCall, vote, near, fmt, sleep, reason, balanceOf } from "./lib.mjs";

const d = deployment();
const C = d.contract;
const DAO = d.dao;
const P = (n) => `${n}.${d.namespace}`;
const CLOSER = process.env.KITTY_CLOSER || "kitty-fund2.testnet";
const which = process.argv[2] || "all";

const results = { ran_at: new Date().toISOString(), contract: C, dao: DAO, checks: [] };
let failures = 0;
function check(name, ok, detail = "", link = null) {
  results.checks.push({ name, ok: !!ok, detail, link });
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` (${detail})` : ""}${link ? `\n        ${link}` : ""}`);
}

async function circleByName(name) {
  const all = await view(C, "list_circles", { from: 0, limit: 100 });
  return all.filter((c) => c.name === name).pop();
}

async function create(name, who, dues, secs) {
  const fee = await view(C, "storage_fee_for", { seats: who.length });
  const out = await mustCall(who[0], C, "create_circle", { dao: DAO, name, dues: dues.toString(), round_secs: secs, members: who }, { gas: 100, deposit: BigInt(fee) });
  check(`create "${name}"`, out.value?.ok === true, `circle #${out.value?.id}`, out.link);
  for (const m of who.slice(1)) await mustCall(m, C, "join", { circle_id: out.value.id }, { gas: 30 });
  const g = await view(C, "get_circle", { circle_id: out.value.id });
  check("every seat taken starts round 1", g.circle.status === "Running" && g.circle.round === 1);
  return g.circle.id;
}

const get = (id) => view(C, "get_circle", { circle_id: id });
async function pay(id, who) {
  const g = await get(id);
  return mustCall(who, C, "pay", { circle_id: id }, { gas: 30, deposit: BigInt(g.circle.dues) });
}
async function waitDeadline(id) {
  const g = await get(id);
  const ms = g.circle.deadline_ms - Date.now() + 2500;
  if (ms > 0) {
    console.log(`        waiting ${Math.ceil(ms / 1000)}s for the round's deadline`);
    await sleep(ms);
  }
}
async function close(id) {
  return call(CLOSER, C, "close_round", { circle_id: id }, { gas: 300 });
}

async function scenarioA() {
  console.log("\nScenario A: a newcomer misses before their turn, a trusted member misses after theirs");
  const who = [P("rosa"), P("kofi"), P("lin")];
  const dues = near(0.1);
  const before = await view(C, "get_dao", { dao: DAO });
  const recRosa = await view(C, "get_record", { account: P("rosa") });
  const rosaCredit = BigInt(recRosa.daos.find((x) => x.dao === DAO)?.credit || 0);
  check("rosa starts with credit from the seed circle", rosaCredit >= near(0.2), `${fmt(rosaCredit)} NEAR`);
  const id = await create(`E2E small covers ${Date.now() % 100000}`, who, dues, 30);

  // Round 1: kofi does not pay.
  await pay(id, P("rosa"));
  await pay(id, P("lin"));
  const early = await close(id);
  check("closing before the deadline with dues owed is refused", !early.ok && /ERR_TOO_EARLY/.test(reason(early.failure)), reason(early.failure), early.link);
  await waitDeadline(id);
  const kofiBal0 = await balanceOf(P("kofi"));
  const c1 = await close(id);
  check("round 1 closes past the deadline", c1.ok, "", c1.link);
  await sleep(3000);
  let g = await get(id);
  const filed = c1.logs.find((l) => l.includes('"cover_filed"'));
  check("Kitty filed a cover proposal on the DAO", !!filed, filed ? JSON.parse(filed.slice(11)).data[0].proposal_id : "");
  check("the cover passed with Kitty's own vote and the round paid out", g.circle.round === 2 && g.circle.log[0].covered === dues.toString(), `log: ${JSON.stringify(g.circle.log[0])}`);
  const pid = g.circle.log[0].cover_proposal;
  const prop = await view(DAO, "get_proposal", { id: pid });
  check(`proposal #${pid} is Approved, filed and voted by ${C}`, prop.status === "Approved" && prop.proposer === C && prop.votes[C] === "Approve", prop.status);
  check("rosa took the full pot early: credit replaced holdback", g.circle.log[0].paid === near(0.3).toString() && g.circle.log[0].backed === near(0.2).toString(), `${fmt(g.circle.log[0].paid)} paid, ${fmt(g.circle.log[0].backed)} credit`);
  let kofi = await view(C, "get_record", { account: P("kofi") });
  check("kofi owes the DAO the covered dues", kofi.debts.length === 1 && kofi.debts[0].creditor === DAO && kofi.debts[0].amount === dues.toString());

  // Round 2: everyone pays; kofi's pot repays the DAO first.
  for (const m of who) await pay(id, m);
  const c2 = await close(id);
  check("round 2 closes as soon as everyone paid", c2.ok, "", c2.link);
  g = await get(id);
  const l2 = g.circle.log[1];
  check("kofi's debt came out of his own pot", l2.recovered === dues.toString() && l2.paid === near(0.1).toString() && l2.holdback === near(0.1).toString(), `paid ${fmt(l2.paid)}, recovered ${fmt(l2.recovered)}, held back ${fmt(l2.holdback)}`);
  kofi = await view(C, "get_record", { account: P("kofi") });
  check("kofi owes nothing now", kofi.debts.length === 0);

  // Round 3: rosa, who already took her pot on credit, does not pay. kofi's holdback pays his.
  await pay(id, P("lin"));
  await waitDeadline(id);
  const c3 = await close(id);
  check("round 3 closes past the deadline", c3.ok, "", c3.link);
  await sleep(3000);
  g = await get(id);
  check("the circle finished", g.circle.status === "Done");
  check("lin, the last seat, got the full pot", g.circle.log[2].paid === near(0.3).toString() && g.circle.log[2].covered === dues.toString());
  let rosa = await view(C, "get_record", { account: P("rosa") });
  const rd = rosa.daos.find((x) => x.dao === DAO);
  check("rosa owes the DAO and her credit is zero", rosa.debts.length === 1 && rd.credit === "0", `credit ${rd.credit}`);
  const mid = await view(C, "get_dao", { dao: DAO });
  check("the DAO's book shows two covers and one debt outstanding", mid.book.covers === before.book.covers + 2 && BigInt(mid.book.debts) - BigInt(before.book.debts) === dues, `debts ${fmt(mid.book.debts)}`);

  const rp = await mustCall(P("rosa"), C, "repay", {}, { gas: 60, deposit: dues });
  rosa = await view(C, "get_record", { account: P("rosa") });
  check("rosa repays and her credit is back", rosa.debts.length === 0 && BigInt(rosa.daos.find((x) => x.dao === DAO).credit) > 0n, "", rp.link);
  const after = await view(C, "get_dao", { dao: DAO });
  check("the DAO got all its covers back", BigInt(after.book.debts) === BigInt(before.book.debts) && BigInt(after.book.recovered) - BigInt(before.book.recovered) === 2n * dues);
  check("the DAO stands behind nothing for this circle", g.circle.exposure === "0");
  results.scenarioA = { circle: id, proposals: [g.circle.log[0].cover_proposal, g.circle.log[2].cover_proposal], links: [c1.link, c2.link, c3.link, rp.link] };
  void kofiBal0;
}

async function scenarioB() {
  console.log("\nScenario B: a cover above the auto limit waits for the council");
  const who = [P("tomas"), P("kofi")];
  const dues = near(0.3);
  const id = await create(`E2E council cover ${Date.now() % 100000}`, who, dues, 30);
  await pay(id, P("tomas"));
  await waitDeadline(id);
  const c1 = await close(id);
  check("round 1 closes and files a cover", c1.ok, "", c1.link);
  await sleep(2500);
  let g = await get(id);
  check("a 0.3 NEAR cover is above the 0.25 auto limit, so the circle waits", g.circle.status === "AwaitingCover" && g.circle.cover && !g.circle.cover.auto);
  const pid = g.circle.cover.proposal_id;
  let prop = await view(DAO, "get_proposal", { id: pid });
  check(`proposal #${pid} is open with no vote from Kitty`, prop.status === "InProgress" && !prop.votes[C]);
  const again = await close(id);
  check("closing again before the council acts is refused", !again.ok && /ERR_WAITING/.test(reason(again.failure)), reason(again.failure));
  const v1 = await vote(DAO, P("priya"), pid);
  const v2 = await vote(DAO, P("rosa"), pid);
  check("two council votes pass it", v1.ok && v2.ok, "", v2.link);
  await sleep(3000);
  prop = await view(DAO, "get_proposal", { id: pid });
  g = await get(id);
  check("the DAO ran receive_cover and the pot paid tomas in full", prop.status === "Approved" && g.circle.round === 2 && g.circle.log[0].covered === dues.toString(), prop.status);
  // Round 2: kofi pays this time and takes the pot; his debt goes back to the DAO.
  await pay(id, P("tomas"));
  await pay(id, P("kofi"));
  const c2 = await close(id);
  g = await get(id);
  check("kofi's pot repaid the council's cover", c2.ok && g.circle.status === "Done" && g.circle.log[1].recovered === dues.toString(), "", c2.link);
  results.scenarioB = { circle: id, proposal: pid, links: [c1.link, v1.link, v2.link, c2.link] };
}

async function attacks() {
  console.log("\nRefusals");
  const fakeDao = await call(P("kofi"), C, "set_terms", { terms: { backing_bps: 10000, max_backing: "1", max_exposure: "1", auto_cover_max: "1", max_dues: "1", member_roles: ["x"], cover_wait_secs: 60 } }, { gas: 30 });
  check("an account that is not a factory DAO cannot set terms", !fakeDao.ok && /ERR_NOT_DAO/.test(reason(fakeDao.failure)), reason(fakeDao.failure), fakeDao.link);
  const fee = await view(C, "storage_fee_for", { seats: 2 });
  const outsider = await call(P("kofi"), C, "create_circle", { dao: DAO, name: "Outsider", dues: near(0.1).toString(), round_secs: 60, members: [P("kofi"), CLOSER] }, { gas: 100, deposit: BigInt(fee) });
  check("a circle with someone outside the DAO's roles is refused, deposit returned", outsider.ok && outsider.value?.ok === false && /ERR_NOT_MEMBER/.test(outsider.value?.error), outsider.value?.error, outsider.link);
  const big = await call(P("kofi"), C, "create_circle", { dao: DAO, name: "Too big", dues: near(0.6).toString(), round_secs: 60, members: [P("kofi"), P("lin")] }, { gas: 100, deposit: BigInt(fee) });
  check("dues above the DAO's max_dues are refused", !big.ok && /ERR_DUES/.test(reason(big.failure)), reason(big.failure), big.link);
  const all = await view(C, "list_circles", { from: 0, limit: 100 });
  const done = all.find((c) => c.status === "Done");
  const fake = await call(P("kofi"), C, "receive_cover", { circle_id: done.id, round: 1 }, { gas: 30, deposit: near(0.01) });
  check("receive_cover from anyone but the circle's DAO is refused", !fake.ok && /ERR_NOT_DAO/.test(reason(fake.failure)), reason(fake.failure), fake.link);
  const nodebt = await call(P("lin"), C, "repay", {}, { gas: 30, deposit: near(0.01) });
  check("repaying with no debt is refused, deposit returned", !nodebt.ok && /ERR_NO_DEBT/.test(reason(nodebt.failure)), reason(nodebt.failure), nodebt.link);
}

async function main() {
  console.log(`Kitty live checks on ${C} with ${DAO}`);
  if (which === "all" || which === "attacks") await attacks();
  if (which === "all" || which === "auto") await scenarioA();
  if (which === "all" || which === "council") await scenarioB();
  results.passed = results.checks.filter((c) => c.ok).length;
  results.failed = failures;
  const file = path.join(ROOT, "deployments", "testnet-e2e.json");
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  fs.writeFileSync(file, JSON.stringify({ ...prev, [which]: results }, null, 2) + "\n");
  console.log(`\n${results.passed} passed, ${failures} failed. Written to deployments/testnet-e2e.json`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
});
