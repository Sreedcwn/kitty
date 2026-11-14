// Shared helpers for the scripts: RPC access, keys, transactions, Sputnik proposals.
//
// Keys never live in this repository. They are read from and written to the standard NEAR
// credentials folder (~/.near-credentials/<network>/<account>.json), the same place
// near-cli keeps them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, actions, baseEncode } from "near-api-js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NETWORK = "testnet";
export const RPC_URLS = (process.env.KITTY_RPC || "https://near-testnet.drpc.org,https://rpc.testnet.fastnear.com,https://test.rpc.fastnear.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const EXPLORER = "https://testnet.nearblocks.io";
export const FACTORY = "sputnikv2.testnet";
export const SOCIAL = "social.testnet";
export const KV_API = "https://kv.test.fastnear.com";

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const near = (n) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n;
export const fmt = (yocto, digits = 4) => {
  const v = BigInt(yocto);
  const whole = v / NEAR;
  const frac = ((v % NEAR) * 10n ** BigInt(digits)) / NEAR;
  const f = frac.toString().padStart(digits, "0").replace(/0+$/, "");
  return f ? `${whole}.${f}` : `${whole}`;
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const b64 = (obj) => Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)).toString("base64");

// One provider that moves to the next RPC only on network trouble. An answer such as
// "that account does not exist" is an answer, and is passed straight through.
const rpcs = RPC_URLS.map((url) => new JsonRpcProvider({ url }));
let rpcIndex = 0;
const NETWORK_TROUBLE = /429|rate.?limit|timeout|timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|50[0234]|Too Many|socket|network/i;
async function withRpc(fn) {
  let last;
  for (let i = 0; i < rpcs.length * 3; i++) {
    try {
      return await fn(rpcs[rpcIndex]);
    } catch (e) {
      last = e;
      if (!NETWORK_TROUBLE.test(String(e?.message || e))) throw e;
      rpcIndex = (rpcIndex + 1) % rpcs.length;
      await sleep(400 * (i + 1));
    }
  }
  throw last;
}
export const provider = new Proxy(
  {},
  {
    get(_, prop) {
      if (typeof rpcs[0][prop] !== "function") return rpcs[rpcIndex][prop];
      return (...args) => withRpc((p) => p[prop](...args));
    },
  },
);

// ---- The deployment this repository points at ----

const DEPLOYMENT_FILE = path.join(ROOT, "deployments", `${NETWORK}.json`);

export function deployment() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`No deployment recorded at ${path.relative(ROOT, DEPLOYMENT_FILE)}. Run: node scripts/deploy.mjs`);
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
}

export function saveDeployment(d) {
  fs.mkdirSync(path.dirname(DEPLOYMENT_FILE), { recursive: true });
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(d, null, 2) + "\n");
}

// ---- Keys ----

const CREDS = path.join(os.homedir(), ".near-credentials", NETWORK);

export function hasKey(accountId) {
  return fs.existsSync(path.join(CREDS, `${accountId}.json`));
}

export function keyOf(accountId) {
  const file = path.join(CREDS, `${accountId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No key for ${accountId}. Expected ${file} (near-cli writes it with save-to-legacy-keychain).`);
  }
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return j.private_key || j.secret_key;
}

export function saveKey(accountId, keyPair) {
  fs.mkdirSync(CREDS, { recursive: true });
  fs.writeFileSync(
    path.join(CREDS, `${accountId}.json`),
    JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }),
  );
}

const accounts = new Map();
export function acct(accountId) {
  if (!accounts.has(accountId)) accounts.set(accountId, new Account(accountId, provider, keyOf(accountId)));
  return accounts.get(accountId);
}

// ---- Reads ----

export async function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args, blockQuery: { finality: "optimistic" } });
}

/** The account's state, or null if there is no such account. */
export async function accountInfo(accountId) {
  try {
    return await provider.viewAccount({ accountId, blockQuery: { finality: "optimistic" } });
  } catch (e) {
    if (/does(n't| not) exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(`${e?.name} ${e?.message}`)) return null;
    throw e;
  }
}

export async function balanceOf(accountId) {
  const a = await accountInfo(accountId);
  return a ? BigInt(a.amount) : 0n;
}

// ---- Writes ----

/** What a finished transaction did: its return value, every log line, and why it failed if it did. */
export function outcome(res) {
  const logs = [];
  let failure = null;
  for (const r of res.receipts_outcome || []) {
    for (const l of r.outcome.logs || []) logs.push(l);
    const st = r.outcome.status;
    if (st && typeof st === "object" && "Failure" in st && !failure) failure = st.Failure;
  }
  let value;
  const st = res.status;
  if (st && typeof st === "object" && "SuccessValue" in st) {
    const raw = Buffer.from(st.SuccessValue || "", "base64").toString();
    try {
      value = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      value = raw;
    }
  }
  const topFailure = st && typeof st === "object" && "Failure" in st ? st.Failure : null;
  const hash = res.transaction?.hash;
  let burnt = BigInt(res.transaction_outcome?.outcome?.gas_burnt || 0);
  for (const r of res.receipts_outcome || []) burnt += BigInt(r.outcome.gas_burnt || 0);
  const tgas = Number(burnt / 10n ** 10n) / 100;
  return { ok: !topFailure, value, logs, failure: topFailure || failure, anyFailure: failure, tgas, hash, link: hash ? `${EXPLORER}/txns/${hash}` : null };
}

/** The contract's own words for a failure: the text after the last "panicked" or the ERR_ line. */
export function reason(failure) {
  const s = JSON.stringify(failure || "");
  const m = s.match(/ERR_[A-Z_]+[^"\\]*/);
  if (m) return m[0];
  const p = s.match(/Smart contract panicked: ([^"\\]+)/);
  return p ? p[1] : s;
}

/** One raw JSON-RPC request with our own timeout, moving to the next endpoint on network trouble. */
async function rawRpc(method, params, timeoutMs = 20000) {
  let last;
  for (let i = 0; i < RPC_URLS.length * 2; i++) {
    const url = RPC_URLS[rpcIndex];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (e) {
      last = e;
      rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
      await sleep(500);
    }
  }
  throw last;
}

/**
 * Sign once, send, then ask for the result until every receipt has run.
 *
 * `send_tx` with `wait_until: "INCLUDED"` answers once the transaction is in a block, or
 * with the network's own reason if it will never be (not enough balance to prepay its gas,
 * a bad nonce). After that the outcome is fetched by hash, so a dropped connection while
 * waiting can never lead to signing and sending the same thing twice.
 */
export async function send(signerId, receiverId, acts) {
  const signed = await acct(signerId).createSignedTransaction({ receiverId, actions: acts });
  const txHash = baseEncode(crypto.createHash("sha256").update(signed.transaction.encode()).digest());
  const sent = await rawRpc("send_tx", { signed_tx_base64: Buffer.from(signed.encode()).toString("base64"), wait_until: "INCLUDED" }, 30000).catch(() => ({}));
  if (sent.error && sent.error.cause?.name !== "TIMEOUT_ERROR") {
    const info = sent.error.data ?? sent.error.cause?.info ?? sent.error.message ?? "";
    const text = typeof info === "string" ? info : JSON.stringify(info);
    if (/NotEnoughBalance/.test(text)) {
      throw new Error(`${signerId} does not hold enough NEAR to prepay this call's gas (about 0.001 NEAR per Tgas attached)`);
    }
    throw new Error(`${signerId} could not send a transaction to ${receiverId}: ${text.slice(0, 300)}`);
  }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const r = await rawRpc("tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "EXECUTED_OPTIMISTIC" }, 25000).catch(() => null);
    const st = r?.result?.status;
    if (st && r.result.receipts_outcome && typeof st === "object" && ("SuccessValue" in st || "Failure" in st)) return outcome(r.result);
    // Otherwise it is not known or not finished yet: ask again.
  }
  throw new Error(`transaction ${txHash} from ${signerId} did not finish in two minutes (${EXPLORER}/txns/${txHash})`);
}

export async function call(signerId, contractId, method, args = {}, { gas = 30, deposit = 0n } = {}) {
  // The network asks a sender to hold roughly 0.001 NEAR per Tgas attached, plus any deposit,
  // before it will take the transaction. Saying so here beats a refusal with no explanation.
  const needs = (BigInt(gas) * NEAR) / 1000n + BigInt(deposit);
  const has = await balanceOf(signerId);
  if (has < needs) {
    throw new Error(`${signerId} holds ${fmt(has, 3)} NEAR and needs about ${fmt(needs, 3)} on hand to attach ${gas} Tgas to ${method}`);
  }
  return send(signerId, contractId, [actions.functionCall(method, args, BigInt(gas) * TGAS, BigInt(deposit))]);
}

/** Like `call`, and throws with the contract's reason if the transaction failed. */
export async function mustCall(signerId, contractId, method, args = {}, opts = {}) {
  const out = await call(signerId, contractId, method, args, opts);
  if (!out.ok) throw new Error(`${method} on ${contractId} as ${signerId} failed: ${reason(out.failure)} (${out.link})`);
  return out;
}

// ---- Accounts ----

/** Create `accountId` as a sub-account of `parentId`, or as a top-level name if it ends in the network suffix. */
export async function ensureAccount(parentId, accountId, amount) {
  if (await accountInfo(accountId)) {
    if (!hasKey(accountId)) throw new Error(`${accountId} exists and this machine has no key for it. Pick another name.`);
    return false;
  }
  const kp = KeyPair.fromRandom("ed25519");
  saveKey(accountId, kp);
  const pk = kp.getPublicKey();
  let out;
  if (accountId.endsWith(`.${parentId}`)) {
    out = await send(parentId, accountId, [actions.createAccount(), actions.transfer(BigInt(amount)), actions.addFullAccessKey(pk)]);
  } else {
    out = await call(parentId, NETWORK, "create_account", { new_account_id: accountId, new_public_key: pk.toString() }, { gas: 60, deposit: BigInt(amount) });
  }
  if (!out.ok || out.anyFailure) throw new Error(`creating ${accountId} failed: ${reason(out.failure)} (${out.link})`);
  return true;
}

/** Bring an account up to `min` NEAR from `fromId` if it holds less. */
export async function topUp(fromId, accountId, min) {
  const have = await balanceOf(accountId);
  if (have >= BigInt(min)) return 0n;
  const amount = BigInt(min) - have;
  const out = await send(fromId, accountId, [actions.transfer(amount)]);
  if (!out.ok) throw new Error(`top-up of ${accountId} failed: ${reason(out.failure)} (${out.link})`);
  return amount;
}

/** Ask the community faucet contract for 2 NEAR. It serves single-label testnet names, about once an hour each. */
export async function faucet(accountId) {
  const before = await balanceOf(accountId);
  await call(accountId, "v2.faucet.nonofficial.testnet", "request_near", { receiver_id: accountId, request_amount: (2n * NEAR).toString() }, { gas: 30 });
  await sleep(1500);
  return (await balanceOf(accountId)) > before + NEAR;
}

// ---- Sputnik DAO ----

export const COUNCIL_PERMISSIONS = ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"];

/** The role a DAO gives Kitty: it may file and approve FunctionCall proposals, and its single vote passes one. Kitty only ever files `receive_cover` calls to itself and only votes on those. */
export function kittyRole(contractId, name = "kitty") {
  return {
    name,
    kind: { Group: [contractId] },
    permissions: ["call:AddProposal", "call:VoteApprove"],
    vote_policy: { call: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] } },
  };
}

export function functionCallKind(receiverId, method, args, { deposit = 0n, gas = 150 } = {}) {
  return {
    FunctionCall: {
      receiver_id: receiverId,
      actions: [{ method_name: method, args: b64(args), deposit: BigInt(deposit).toString(), gas: (BigInt(gas) * TGAS).toString() }],
    },
  };
}

export async function propose(dao, signerId, description, kind) {
  const policy = await view(dao, "get_policy");
  const out = await mustCall(signerId, dao, "add_proposal", { proposal: { description, kind } }, { gas: 50, deposit: BigInt(policy.proposal_bond) });
  return { id: out.value, out };
}

/** Cast a vote. The vote that passes a proposal also runs its action, so it carries that action's gas. */
export async function vote(dao, signerId, id, action = "VoteApprove") {
  const p = await view(dao, "get_proposal", { id });
  let gas = 100n;
  for (const a of p.kind?.FunctionCall?.actions || []) gas += BigInt(a.gas) / TGAS;
  return call(signerId, dao, "act_proposal", { id, action, proposal: p.kind }, { gas: gas > 300n ? 300n : gas });
}

/** File a proposal as the first signer and approve it with as many signers as it takes. */
export async function pass(dao, signerIds, description, kind) {
  const { id, out } = await propose(dao, signerIds[0], description, kind);
  const links = [out.link];
  for (const s of signerIds) {
    const v = await vote(dao, s, id);
    if (!v.ok) throw new Error(`vote by ${s} on #${id} failed: ${reason(v.failure)} (${v.link})`);
    links.push(v.link);
    const p = await view(dao, "get_proposal", { id });
    if (p.status !== "InProgress") {
      // Sputnik marks it Approved before its action has run. Give the action a moment.
      await sleep(2500);
      const after = await view(dao, "get_proposal", { id });
      if (after.status !== "Approved") throw new Error(`proposal #${id} ended ${after.status}: ${description}`);
      return { id, links };
    }
  }
  throw new Error(`proposal #${id} is still open after ${signerIds.length} votes`);
}

// ---- Small things for readable output ----

export const short = (accountId) => accountId.split(".")[0];
export function step(n, text) {
  console.log(`\n${n}. ${text}`);
}
export function note(text) {
  console.log(`   ${text}`);
}
