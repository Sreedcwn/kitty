// Stand up the whole demo on NEAR testnet, the way a real community would install Kitty.
//
//   node scripts/deploy.mjs                  create what is missing, skip what exists
//   node scripts/deploy.mjs --code-only      redeploy the contract code and nothing else
//
// Needs one funded testnet account whose key is in ~/.near-credentials/testnet, named in
// KITTY_HQ (default kitty-hq.testnet), and the built contract at contract/out/kitty.wasm
// (see README, "Build").
//
// What it does, in order. Every step first checks the chain and skips itself if done.
//   1. Creates the contract account under the HQ account, deploys and initialises it.
//   2. Creates a named account for each person of the demo community, under one namespace,
//      and gives each a near.social profile name, written from their own account.
//   3. Creates a real Sputnik DAO, "Banyan Co-op", through the testnet factory, with a
//      three-person council and three members.
//   4. Puts NEAR in the DAO's treasury.
//   5. Has the council pass two ordinary proposals: one adds a role holding only the Kitty
//      contract, limited to filing and approving FunctionCall proposals; one sets Kitty's
//      terms for this DAO.
//   6. Runs a short warm-up circle among three council members, so they start the demo with
//      a record. Every point of it is on chain and on near.social.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { actions } from "near-api-js";
import {
  ROOT, FACTORY, SOCIAL, EXPLORER, NEAR, near, fmt, b64, sleep,
  view, call, mustCall, send, accountInfo, balanceOf, ensureAccount, topUp,
  COUNCIL_PERMISSIONS, kittyRole, functionCallKind, pass, reason,
  saveDeployment, deployment, step, note,
} from "./lib.mjs";

const HQ = process.env.KITTY_HQ || "kitty-hq.testnet";
const FUNDERS = (process.env.KITTY_FUNDERS || "kitty-fund.testnet").split(",").filter(Boolean);
const CONTRACT = process.env.KITTY_CONTRACT || `v1.${HQ}`;
const SPACE = process.env.KITTY_SPACE || "banyan-coop.testnet";
const DAO_NAME = process.env.KITTY_DAO_NAME || "banyan";
const DAO = `${DAO_NAME}.${FACTORY}`;
const LABEL = "Banyan Co-op";
const WASM = process.env.KITTY_WASM || path.join(ROOT, "contract", "out", "kitty.wasm");

// The people of the demo, with the names their near.social profiles carry.
export const PEOPLE = {
  priya: { name: "Priya Raman", role: "council" },
  tomas: { name: "Tomás Ortega", role: "council" },
  rosa: { name: "Rosa Lindqvist", role: "council" },
  ama: { name: "Ama Mensah", role: "members" },
  lin: { name: "Lin Wei", role: "members" },
  kofi: { name: "Kofi Boateng", role: "members" },
};
const COUNCIL = Object.keys(PEOPLE).filter((p) => PEOPLE[p].role === "council");
const MEMBERS = Object.keys(PEOPLE).filter((p) => PEOPLE[p].role === "members");
export const id = (name) => `${name}.${SPACE}`;

// Banyan's terms. A real DAO would pick its own; these make the demo readable.
export const TERMS = {
  // Credit is everything a member paid themselves, on time, in circles they finished.
  backing_bps: 10_000,
  max_backing: near(1).toString(),
  max_exposure: near(2).toString(),
  // A cover of up to 0.25 NEAR passes with Kitty's own vote; more waits for the council.
  auto_cover_max: near(0.25).toString(),
  max_dues: near(0.5).toString(),
  member_roles: ["council", "members"],
  // Demo: ten minutes. A real DAO would give its council days.
  cover_wait_secs: 600,
};

const WARMUP = { name: "Seed circle", dues: near(0.1), round_secs: 30, members: ["priya", "tomas", "rosa"] };

const codeOnly = process.argv.includes("--code-only");

async function fund(accountId, min) {
  // Top up from whichever funder has the most to spare.
  let best = null;
  let most = -1n;
  for (const f of [HQ, ...FUNDERS].filter((x) => x !== accountId)) {
    const b = await balanceOf(f).catch(() => 0n);
    if (b > most) {
      best = f;
      most = b;
    }
  }
  return topUp(best, accountId, min);
}

async function deployCode() {
  const code = fs.readFileSync(WASM);
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  const out = await send(CONTRACT, CONTRACT, [actions.deployContract(code)]);
  if (!out.ok) throw new Error(`deploy failed: ${reason(out.failure)} (${out.link})`);
  note(`deployed ${code.length} bytes, sha256 ${hash.slice(0, 16)}... ${out.link}`);
  return { bytes: code.length, sha256: hash, tx: out.link };
}

async function writeProfile(accountId, name, about) {
  // A near.social write: a call to the data account, which has no contract. The receipt
  // fails by design; the index reads the arguments.
  const out = await send(accountId, SOCIAL, [actions.functionCall("__fastdata_kv", { "profile/name": name, "profile/about": about }, 1n, 0n)]);
  return out.link;
}

async function runWarmup(links) {
  const circles = await view(CONTRACT, "list_circles", { from: 0, limit: 100 });
  let c = circles.find((x) => x.dao === DAO && x.name === WARMUP.name);
  const members = WARMUP.members.map(id);
  if (!c) {
    const fee = await view(CONTRACT, "storage_fee_for", { seats: members.length });
    const out = await mustCall(members[0], CONTRACT, "create_circle", { dao: DAO, name: WARMUP.name, dues: WARMUP.dues.toString(), round_secs: WARMUP.round_secs, members }, { gas: 100, deposit: BigInt(fee) });
    note(`created "${WARMUP.name}" ${out.link}`);
    links.warmup = [out.link];
    await sleep(2000);
    c = (await view(CONTRACT, "list_circles", { from: 0, limit: 100 })).find((x) => x.dao === DAO && x.name === WARMUP.name);
    if (!c) throw new Error(`the warm-up circle was not created: ${out.logs.join(" | ")}`);
  }
  for (const s of c.seats) {
    if (!s.joined) {
      const out = await mustCall(s.account, CONTRACT, "join", { circle_id: c.id }, { gas: 30 });
      note(`${s.account} joined ${out.link}`);
    }
  }
  for (let guard = 0; guard < 10; guard++) {
    c = (await view(CONTRACT, "get_circle", { circle_id: c.id })).circle;
    if (c.status === "Done") break;
    if (c.status !== "Running") throw new Error(`warm-up circle is ${c.status}`);
    // Everyone pays themselves every round, even when a holdback would pay for them: that is
    // what builds a record.
    for (const s of c.seats) {
      if (s.due === "Owed") {
        const out = await mustCall(s.account, CONTRACT, "pay", { circle_id: c.id }, { gas: 30, deposit: BigInt(c.dues) });
        note(`round ${c.round}: ${s.account} paid ${fmt(c.dues)} NEAR ${out.link}`);
      }
    }
    const out = await mustCall(FUNDERS.at(-1), CONTRACT, "close_round", { circle_id: c.id }, { gas: 300 });
    note(`round ${c.round} closed: ${JSON.stringify(out.value)} ${out.link}`);
    (links.warmup ||= []).push(out.link);
  }
  // The holdbacks of members who paid anyway come back to them when the circle ends.
  return c;
}

async function main() {
  const links = {};
  console.log(`Kitty demo on NEAR testnet\n  HQ account:  ${HQ}\n  contract:    ${CONTRACT}\n  DAO:         ${DAO}\n  people:      *.${SPACE}`);
  if (!(await accountInfo(HQ))) throw new Error(`${HQ} does not exist. Create it with the faucet first (see README).`);

  step(1, "Contract account, code and initialisation");
  if (!fs.existsSync(WASM)) throw new Error(`No contract build at ${WASM}. See README, section Build.`);
  const wasmBytes = fs.statSync(WASM).size;
  // Each byte of code locks 0.00001 NEAR on the account that holds it. The rest is for the
  // contract's own storage and the bonds of the cover proposals it files.
  const needed = (BigInt(wasmBytes) * NEAR) / 100_000n + near(1);
  if (await ensureAccount(HQ, CONTRACT, needed)) note(`created ${CONTRACT} with ${fmt(needed)} NEAR`);
  let code;
  const info = await accountInfo(CONTRACT);
  if (info.code_hash === "11111111111111111111111111111111" || codeOnly) {
    code = await deployCode();
    links.deploy = code.tx;
  } else {
    note("code already deployed (use --code-only to replace it)");
  }
  let initialised = true;
  try {
    await view(CONTRACT, "version");
  } catch {
    initialised = false;
  }
  if (!initialised) {
    const out = await mustCall(CONTRACT, CONTRACT, "new", { factory: FACTORY, social: SOCIAL }, { gas: 30 });
    note(`initialised: DAOs from ${FACTORY}, near.social writes to ${SOCIAL} ${out.link}`);
    links.init = out.link;
  }
  note(`version ${await view(CONTRACT, "version")}`);
  let prev = {};
  try {
    prev = deployment();
  } catch {}
  if (codeOnly) {
    if (prev.contract === CONTRACT && code) saveDeployment({ ...prev, code: { bytes: code.bytes, sha256: code.sha256 } });
    return;
  }

  step(2, "A named account and a near.social profile for each person");
  if (await ensureAccount(HQ, SPACE, near(0.2))) note(`created ${SPACE}`);
  // Council members vote and pay dues; members pay dues. Each needs NEAR on hand for gas.
  const floor = (p) => (PEOPLE[p].role === "council" ? near(1.2) : near(0.9));
  for (const p of Object.keys(PEOPLE)) {
    if (!(await accountInfo(id(p)))) {
      await fund(SPACE, floor(p) + near(0.05));
      await ensureAccount(SPACE, id(p), floor(p));
      note(`created ${id(p)} with ${fmt(floor(p))} NEAR`);
    } else {
      const sent = await fund(id(p), floor(p));
      if (sent) note(`topped up ${id(p)} by ${fmt(sent)} NEAR`);
    }
  }
  const profiles = prev.profiles || {};
  for (const [p, v] of Object.entries(PEOPLE)) {
    if (profiles[id(p)]) continue;
    profiles[id(p)] = await writeProfile(id(p), v.name, `${v.role === "council" ? "Council member" : "Member"} of ${LABEL}, a demo community for Kitty on NEAR testnet.`);
    note(`near.social profile "${v.name}" for ${id(p)}`);
  }

  step(3, `A Sputnik DAO, ${LABEL}, with a three-person council`);
  if (!(await accountInfo(DAO))) {
    const args = {
      config: { name: DAO_NAME, purpose: `${LABEL}: a neighbourhood co-op. Demo treasury for Kitty savings circles.`, metadata: "" },
      policy: {
        roles: [
          { name: "council", kind: { Group: COUNCIL.map(id) }, permissions: COUNCIL_PERMISSIONS, vote_policy: {} },
          { name: "members", kind: { Group: MEMBERS.map(id) }, permissions: ["*:AddProposal"], vote_policy: {} },
        ],
        default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
        proposal_bond: near(0.01).toString(),
        proposal_period: (7n * 86400n * 10n ** 9n).toString(),
        bounty_bond: near(0.01).toString(),
        bounty_forgiveness_period: (86400n * 10n ** 9n).toString(),
      },
    };
    await fund(HQ, near(6.2));
    const out = await call(HQ, FACTORY, "create", { name: DAO_NAME, args: b64(args) }, { gas: 250, deposit: near(5.55) });
    if (!out.ok || out.anyFailure) throw new Error(`DAO creation failed: ${reason(out.failure)} (${out.link})`);
    note(`created ${DAO} ${out.link}`);
    links.dao = out.link;
  } else {
    note(`${DAO} exists`);
  }
  let policy = await view(DAO, "get_policy");
  note(`council: ${policy.roles.find((r) => r.name === "council").kind.Group.join(", ")}`);

  step(4, "Money in the treasury");
  if (BigInt(await view(DAO, "get_available_amount")) < near(1)) {
    await fund(HQ, near(1.6));
    const out = await send(HQ, DAO, [actions.transfer(near(1.5))]);
    note(`sent 1.5 NEAR to ${DAO} ${out.link}`);
  }
  note(`the DAO can spend ${fmt(await view(DAO, "get_available_amount"))} NEAR`);

  step(5, "The council installs Kitty with two ordinary proposals");
  const voters = COUNCIL.slice(0, 2).map(id);
  if (!policy.roles.some((r) => r.kind?.Group?.includes(CONTRACT))) {
    const role = kittyRole(CONTRACT);
    const r = await pass(
      DAO,
      voters,
      `* Title: Add the Kitty role <br>* Summary: Lets ${CONTRACT} file FunctionCall proposals and approve them with its own vote. Its code only files one kind: sending a member's missed savings-circle dues to its own receive_cover, capped by the terms we set next.`,
      { ChangePolicyAddOrUpdateRole: { role } },
    );
    note(`proposal #${r.id} passed: role "kitty" holds only ${CONTRACT}, with ${role.permissions.join(", ")}`);
    links.role = r.links;
  } else {
    note("the DAO's policy already has a role holding Kitty");
  }
  const st = await view(CONTRACT, "get_dao", { dao: DAO });
  if (!st?.terms) {
    const r = await pass(
      DAO,
      voters,
      `* Title: Set Kitty terms <br>* Summary: Members' savings circles get credit equal to the dues they paid on time in finished circles, up to ${fmt(TERMS.max_backing)} NEAR each and ${fmt(TERMS.max_exposure)} NEAR in total. Covers up to ${fmt(TERMS.auto_cover_max)} NEAR pass with Kitty's own vote.`,
      functionCallKind(CONTRACT, "set_terms", { terms: TERMS }, { gas: 30 }),
    );
    note(`proposal #${r.id} passed: terms set`);
    links.terms = r.links;
  } else {
    note("terms already set");
  }

  step(6, "A warm-up circle, so the council starts with a record");
  const warm = await runWarmup(links);
  note(`"${WARMUP.name}" is ${warm.status}`);
  for (const m of WARMUP.members) {
    const rec = await view(CONTRACT, "get_record", { account: id(m) });
    const withDao = rec.daos.find((x) => x.dao === DAO);
    note(`${id(m)}: credit ${fmt(withDao?.credit || 0)} NEAR, ${withDao?.stats.circles_done || 0} circle(s) finished`);
  }

  saveDeployment({
    network: "testnet",
    contract: CONTRACT,
    social: SOCIAL,
    factory: FACTORY,
    dao: DAO,
    label: LABEL,
    namespace: SPACE,
    people: Object.fromEntries(Object.entries(PEOPLE).map(([p, v]) => [id(p), { ...v, short: p }])),
    council: COUNCIL.map(id),
    members: MEMBERS.map(id),
    terms: TERMS,
    profiles,
    code: code ? { bytes: code.bytes, sha256: code.sha256 } : prev.code,
    explorer: { contract: `${EXPLORER}/address/${CONTRACT}`, dao: `${EXPLORER}/address/${DAO}` },
    transactions: { ...(prev.transactions || {}), ...links },
  });
  fs.writeFileSync(path.join(ROOT, "web", "deployment.json"), JSON.stringify(deployment(), null, 2) + "\n");
  console.log(`\nDone. Recorded in deployments/testnet.json\n  contract ${EXPLORER}/address/${CONTRACT}\n  DAO      ${EXPLORER}/address/${DAO}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main().catch((e) => {
    console.error(`\nFailed: ${e.message}`);
    process.exit(1);
  });
}
