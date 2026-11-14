// Serve the site.
//
//   node scripts/serve.mjs            read-only: everything on screen is read from NEAR
//   node scripts/serve.mjs --demo     also lets you act as the demo community's members
//
// The site is static files that read the chain and near.social's index from the browser.
// `--demo` adds one thing: a relay on this machine that signs for the demo accounts, whose
// keys are in ~/.near-credentials/testnet. It listens on 127.0.0.1 only, and it will only
// make the calls listed in ACTIONS, on the contract and DAO in deployments/testnet.json.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT, deployment, call, vote, view, reason, hasKey } from "./lib.mjs";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const port = Number(args[args.indexOf("--port") + 1]) || Number(process.env.PORT) || 4173;
const WEB = path.join(ROOT, "web");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const d = deployment();
const C = d.contract;
const DAO = d.dao;
const people = demo ? Object.keys(d.people).filter((id) => hasKey(id)) : [];
const isPerson = (id) => people.includes(id);

// Everything the relay is willing to sign. Nothing else, and for nobody else.
const ACTIONS = {
  create: async (as, a) => {
    const members = (a.members || []).map(String);
    const fee = await view(C, "storage_fee_for", { seats: members.length });
    return call(as, C, "create_circle", { dao: DAO, name: String(a.name), dues: String(a.dues), round_secs: Number(a.round_secs), members }, { gas: 100, deposit: BigInt(fee) });
  },
  join: (as, a) => call(as, C, "join", { circle_id: Number(a.circle) }, { gas: 30 }),
  pay: async (as, a) => {
    const c = await view(C, "get_circle", { circle_id: Number(a.circle) });
    return call(as, C, "pay", { circle_id: Number(a.circle) }, { gas: 30, deposit: BigInt(c.circle.dues) });
  },
  close: (as, a) => call(as, C, "close_round", { circle_id: Number(a.circle) }, { gas: 300 }),
  repay: async (as) => {
    const rec = await view(C, "get_record", { account: as });
    const owed = rec.debts.reduce((s, x) => s + BigInt(x.amount), 0n);
    if (owed === 0n) throw new Error("nothing to repay");
    return call(as, C, "repay", {}, { gas: 60, deposit: owed });
  },
  // A council member's vote on the DAO, only on a cover proposal the Kitty contract filed.
  vote: async (as, a) => {
    const p = await view(DAO, "get_proposal", { id: Number(a.id) });
    if (p.proposer !== C || p.kind?.FunctionCall?.receiver_id !== C) throw new Error("the demo relay only votes on cover proposals filed by Kitty");
    if (!["VoteApprove", "VoteReject"].includes(a.action)) throw new Error("unknown vote");
    return vote(DAO, as, Number(a.id), a.action);
  },
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20_000) throw new Error("request too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

// One persona sends one transaction at a time, so their nonces never collide.
const queues = new Map();
function inTurn(who, job) {
  const next = (queues.get(who) || Promise.resolve()).then(job, job);
  queues.set(who, next.catch(() => {}));
  return next;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/deployment.json") {
      return send(res, 200, { ...d, demo, actors: people });
    }
    if (url.pathname.startsWith("/demo/")) {
      if (!demo) return send(res, 404, { error: "start the server with --demo to act as the demo members" });
      // A page on another site must not be able to make this relay sign anything.
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: "wrong origin" });
      if (req.method !== "POST" || url.pathname !== "/demo/act") return send(res, 404, { error: "not found" });
      const body = await readBody(req);
      const run = ACTIONS[body.action];
      if (!run) return send(res, 400, { error: `unknown action ${body.action}` });
      if (!isPerson(body.as)) return send(res, 400, { error: "not a demo account" });
      try {
        const out = await inTurn(body.as, () => run(body.as, body.args || {}));
        return send(res, 200, { ok: out.ok, value: out.value ?? null, error: out.ok ? null : reason(out.failure), link: out.link, logs: out.logs, tgas: out.tgas });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB)) return send(res, 403, "forbidden", "text/plain");
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Kitty site: http://127.0.0.1:${port}`);
  console.log(`  contract ${C}\n  DAO      ${DAO}`);
  console.log(demo ? `  demo mode: you can act as ${people.map((p) => p.split(".")[0]).join(", ")}` : "  read-only (add --demo to act as the demo members)");
});
