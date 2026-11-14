// Read-only proof of the deployment. Needs no keys and no account: it only reads NEAR testnet
// and near.social's public index, and prints what it finds with links.
//
//   node scripts/verify.mjs            the whole deployment
//   node scripts/verify.mjs 3          and circle #3 in detail
//
// Every line it prints can be checked by hand on https://testnet.nearblocks.io.

import { deployment, view, fmt, accountInfo, EXPLORER, KV_API } from "./lib.mjs";

const d = deployment();
const C = d.contract;
const DAO = d.dao;
const only = process.argv[2] != null ? Number(process.argv[2]) : null;
let bad = 0;
const ok = (cond, text) => {
  if (!cond) bad++;
  console.log(`${cond ? "  ok  " : "  FAIL"} ${text}`);
};

async function socialPosts(author) {
  const res = await fetch(`${KV_API}/v0/latest/${d.social}/${author}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key_prefix: "post/" }) });
  const j = await res.json();
  return (j.entries || []).filter((e) => e.value?.text);
}

async function main() {
  console.log(`Kitty on NEAR testnet\n  contract ${EXPLORER}/address/${C}\n  DAO      ${EXPLORER}/address/${DAO}\n`);

  console.log("The contract");
  const info = await accountInfo(C);
  ok(info && info.code_hash !== "11111111111111111111111111111111", `${C} has code (hash ${info?.code_hash})`);
  ok((await view(C, "version")) === "1.0.0", `version ${await view(C, "version")}`);
  ok((await view(C, "factory")) === "sputnikv2.testnet", `only DAOs made by ${await view(C, "factory")} can set terms`);
  console.log(`        it holds ${fmt(await view(C, "held"))} NEAR of dues for running circles`);

  console.log("\nThe DAO's policy: Kitty's role");
  const policy = await view(DAO, "get_policy");
  const role = policy.roles.find((r) => r.kind?.Group?.includes(C));
  ok(!!role, `role "${role?.name}" holds ${role?.kind.Group.join(", ")}`);
  ok(role && role.kind.Group.length === 1, "nobody else is in that role");
  ok(role && role.permissions.every((p) => p.startsWith("call:")), `its permissions are only ${role?.permissions.join(", ")}`);
  ok(role && JSON.stringify(role.vote_policy?.call?.threshold) === "[1,1]", "its single vote passes a FunctionCall proposal");
  const council = policy.roles.find((r) => r.name === "council");
  console.log(`        council: ${council.kind.Group.join(", ")}`);

  console.log("\nThe terms the DAO set, by its own proposal");
  const st = await view(C, "get_dao", { dao: DAO });
  ok(!!st?.terms, "terms are set");
  const t = st.terms;
  console.log(`        credit = ${t.backing_bps / 100}% of dues paid on time in finished circles, at most ${fmt(t.max_backing)} NEAR each, ${fmt(t.max_exposure)} NEAR in total`);
  console.log(`        covers up to ${fmt(t.auto_cover_max)} NEAR pass with Kitty's vote; larger ones wait for the council`);
  console.log(`        book: credit out ${fmt(st.book.exposure)} NEAR, owed to the DAO ${fmt(st.book.debts)} NEAR, ${st.book.covers} covers for ${fmt(st.book.covered)} NEAR, ${fmt(st.book.recovered)} NEAR back`);

  console.log("\nCircles");
  const circles = await view(C, "list_circles", { from: 0, limit: 100 });
  for (const c of circles) {
    const covers = c.log.filter((l) => l.cover_proposal != null && BigInt(l.covered) > 0n);
    console.log(`  #${c.id} "${c.name}": ${c.status}, ${c.seats.length} seats, ${fmt(c.dues)} NEAR a round, ${c.log.length} rounds paid${covers.length ? `, DAO covers: ${covers.map((l) => `#${l.cover_proposal}`).join(", ")}` : ""}`);
  }

  console.log("\nEvery cover proposal, as the DAO itself records it");
  for (const c of circles) {
    for (const l of c.log.filter((x) => x.cover_proposal != null && BigInt(x.covered) > 0n)) {
      const p = await view(DAO, "get_proposal", { id: l.cover_proposal });
      const fc = p.kind.FunctionCall;
      ok(
        p.status === "Approved" && p.proposer === C && fc?.receiver_id === C && fc.actions[0].method_name === "receive_cover" && fc.actions[0].deposit === l.covered,
        `proposal #${p.id}: ${p.status}, filed by ${p.proposer}, ${fc.receiver_id}.${fc.actions[0].method_name} with ${fmt(fc.actions[0].deposit)} NEAR for circle #${c.id} round ${l.round}; votes ${JSON.stringify(p.votes)}`,
      );
    }
  }

  console.log("\nnear.social: one thread per circle, written by the contract");
  const posts = await socialPosts(C);
  for (const c of circles) {
    if (!c.thread) continue;
    const ref = `${C}/${c.thread}`;
    const inThread = posts.filter((e) => e.key === `post/${c.thread}` || e.value.root === ref);
    ok(inThread.length >= 1 && inThread.every((e) => e.predecessor_id === C), `circle #${c.id}: ${inThread.length} posts in thread ${ref}`);
  }
  console.log(`        raw data: ${KV_API}/v0/latest/${d.social}/${C}`);

  if (only != null) {
    const g = await view(C, "get_circle", { circle_id: only });
    console.log(`\nCircle #${only} in detail`);
    for (const [i, s] of g.circle.seats.entries()) {
      const l = g.circle.log.find((x) => x.round === s.took_round);
      console.log(`  seat ${i + 1} ${s.account}: ${l ? `took ${fmt(l.paid)} NEAR in round ${l.round} (credit ${fmt(l.backed)}, held back ${fmt(l.holdback)}, repaid to DAO ${fmt(l.recovered)})` : "has not taken the pot"}${s.missed ? `, missed ${s.missed}` : ""}`);
    }
    for (const s of g.circle.seats) {
      const r = await view(C, "get_record", { account: s.account });
      const x = r.daos.find((y) => y.dao === DAO);
      console.log(`  ${s.account}: credit ${fmt(x?.credit || 0)} NEAR, ${x?.stats.circles_done || 0} circles finished, ${x?.stats.misses || 0} misses, owes ${fmt(r.debts.reduce((a, b) => a + BigInt(b.amount), 0n))} NEAR, ${r.entries.length} entries`);
    }
    const thread = posts.filter((e) => e.key === `post/${g.circle.thread}` || e.value.root === `${C}/${g.circle.thread}`).sort((a, b) => (a.key < b.key ? -1 : 1));
    console.log(`\n  near.social thread (${thread.length} posts):`);
    for (const e of thread) console.log(`   - ${e.value.text.split("\n")[0].slice(0, 150)}`);
  }

  console.log(bad ? `\n${bad} check(s) failed.` : "\nEverything checks out.");
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
});
