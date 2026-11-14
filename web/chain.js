// Everything the site knows comes from here: view calls to a NEAR RPC, and reads of the
// public FastData index that near.social is built on. No backend, no API key, no wallet.

const RPCS = {
  testnet: ["https://rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"],
  mainnet: ["https://rpc.mainnet.fastnear.com", "https://free.rpc.fastnear.com"],
};
let rpcAt = 0;

let conf;
/** Which contract and DAO this site shows. Written by scripts/deploy.mjs. */
export async function config() {
  if (!conf) {
    const res = await fetch("deployment.json", { cache: "no-store" });
    conf = await res.json();
    conf.kv = conf.network === "mainnet" ? "https://kv.main.fastnear.com" : "https://kv.test.fastnear.com";
    conf.explorer = conf.network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
    conf.rpcs = RPCS[conf.network] || RPCS.testnet;
  }
  return conf;
}

class ViewError extends Error {}

async function rpc(body) {
  const c = await config();
  let last;
  for (let i = 0; i < c.rpcs.length * 2; i++) {
    try {
      const res = await fetch(c.rpcs[rpcAt % c.rpcs.length], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) {
        const name = j.error.cause?.name || "";
        if (/UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CONTRACT_EXECUTION_ERROR/.test(name)) throw new ViewError(j.error.data || name);
        throw new Error(j.error.message || name);
      }
      return j.result;
    } catch (e) {
      if (e instanceof ViewError) throw e;
      last = e;
      rpcAt++;
    }
  }
  throw last;
}

/** Call a view method and decode its JSON answer. */
export async function view(contractId, method, args = {}) {
  const r = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: btoa(unescape(encodeURIComponent(JSON.stringify(args)))),
    },
  });
  if (r?.error) throw new ViewError(r.error);
  const text = new TextDecoder().decode(Uint8Array.from(r.result));
  return text ? JSON.parse(text) : null;
}

export async function balance(accountId) {
  const r = await rpc({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: accountId } });
  return BigInt(r.amount);
}

// ---- near.social, read from its public index ----

const names = new Map();
/** near.social profile names for a list of accounts, from one request. */
export async function profileNames(ids) {
  const c = await config();
  const want = [...new Set(ids)].filter((id) => !names.has(id));
  if (want.length) {
    try {
      const res = await fetch(`${c.kv}/v0/multi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: want.map((id) => `${c.social}/${id}/profile/name`) }),
      });
      const j = await res.json();
      want.forEach((id, i) => names.set(id, j.entries?.[i]?.value || null));
    } catch {
      want.forEach((id) => names.set(id, null));
    }
  }
  return Object.fromEntries(ids.map((id) => [id, names.get(id) || null]));
}

export function nameOf(id) {
  return names.get(id) || null;
}

/** Every post an account wrote to near.social, oldest first. */
export async function posts(author) {
  const c = await config();
  const all = [];
  let page_token;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${c.kv}/v0/latest/${c.social}/${author}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(page_token ? { key_prefix: "post/", page_token } : { key_prefix: "post/" }),
    });
    if (!res.ok) throw new Error(`the FastData index answered ${res.status}`);
    const j = await res.json();
    all.push(...(j.entries || []));
    page_token = j.page_token;
    if (!page_token) break;
  }
  return all
    .filter((e) => e.value && typeof e.value.text === "string")
    .map((e) => ({
      id: Number(e.key.slice(5)),
      text: e.value.text,
      reply_to: e.value.reply_to || null,
      root: e.value.root || null,
      at_ms: Math.floor(Number(BigInt(e.block_timestamp) / 1_000_000n)),
      block: e.block_height,
      author: e.predecessor_id,
    }))
    .sort((a, b) => a.id - b.id);
}

/** One circle's near.social thread: its root post and every reply to it. */
export async function thread(author, rootId) {
  if (!rootId) return [];
  const all = await posts(author);
  const ref = `${author}/${rootId}`;
  return all.filter((p) => p.id === Number(rootId) || p.root === ref || p.reply_to === ref);
}

export function postUrl(c, author, id) {
  return c.network === "mainnet" ? `https://near.social/${author}/post/${id}` : `${c.kv}/v0/latest/${c.social}/${author}/${encodeURIComponent(`post/${id}`)}`;
}

// ---- Small formatting helpers ----

const ONE = 10n ** 24n;
/** NEAR for people: up to `digits` decimals, trailing zeros dropped. */
export function near(yocto, digits = 3) {
  const v = BigInt(yocto || 0);
  const whole = v / ONE;
  const frac = ((v % ONE) * 10n ** BigInt(digits)) / ONE;
  const f = frac.toString().padStart(digits, "0").replace(/0+$/, "");
  return f ? `${whole}.${f}` : `${whole}`;
}

export function short(id) {
  return String(id).split(".")[0];
}

export function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function until(ms) {
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return "deadline passed";
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s left`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`;
  return `${Math.floor(s / 86400)} d left`;
}

export function when(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
