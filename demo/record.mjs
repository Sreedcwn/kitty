// Record the demo video's footage from the real site, against the live testnet contracts.
//
//   node demo/record.mjs             title cards, then one whole circle on chain
//   node demo/record.mjs cards       only the title cards
//   node demo/record.mjs live        only the on-chain footage
//   node demo/record.mjs live 4      the on-chain footage from shot 4 on, for an existing circle
//
// Needs the demo accounts' keys (so only the deployer can run it) and playwright-core with
// its Chromium. It starts the site in demo mode on its own port, drives it with a visible
// cursor, and saves every screen frame with its timestamp to demo/out/shots/<shot>/.
// demo/edit.py then cuts those shots to the narration.
//
// Nothing on screen is staged: every click is a real transaction. The waits you would sit
// through (a one-minute round, finality) are recorded and shortened in the edit.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { ROOT, deployment, view, sleep } from "../scripts/lib.mjs";

const OUT = path.join(ROOT, "demo", "out", "shots");
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const W = 1280;
const H = 720;
const what = process.argv[2] || "all";
const from = Number(process.argv[3] || 1);
const d = deployment();
const C = d.contract;
const P = (n) => `${n}.${d.namespace}`;
const NAME = process.env.KITTY_DEMO_CIRCLE || "December rent";
const CAST = ["priya", "ama", "tomas", "lin"];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- a cursor you can see, and a ripple on every click ----
function overlay() {
  const install = () => {
    if (!document.documentElement || document.getElementById("__cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      html { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }
      @keyframes __ripple { from { transform: translate(-50%,-50%) scale(.2); opacity: .5 } to { transform: translate(-50%,-50%) scale(1); opacity: 0 } }
      .__ripple { position: fixed; width: 54px; height: 54px; border-radius: 50%; background: #d9480f; pointer-events: none; z-index: 2147483646; animation: __ripple .55s ease-out forwards; }`;
    document.documentElement.appendChild(style);
    const c = document.createElement("div");
    c.id = "__cursor";
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 2.5l14.5 11.2-6.6 1.1-3.9 6.2z" fill="#1b1a17" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-200px,-200px)" });
    document.documentElement.appendChild(c);
    addEventListener("mousemove", (e) => (c.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`), true);
    addEventListener(
      "mousedown",
      (e) => {
        const r = document.createElement("div");
        r.className = "__ripple";
        r.style.left = `${e.clientX}px`;
        r.style.top = `${e.clientY}px`;
        document.documentElement.appendChild(r);
        setTimeout(() => r.remove(), 600);
      },
      true,
    );
  };
  install();
  document.addEventListener("DOMContentLoaded", install);
}

// ---- recording: every screencast frame, with its time, and named moments ----
async function cast(page, name) {
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const marks = {};
  let n = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const file = `f${String(n++).padStart(6, "0")}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 93, everyNthFrame: 1 });
  const save = () => fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify({ frames, marks }));
  const mark = (event) => {
    marks[event] = Date.now() / 1000;
    log(`  ${name}: ${event}`);
    save();
  };
  mark("start");
  return {
    mark,
    stop: async () => {
      mark("end");
      await cdp.send("Page.stopScreencast").catch(() => {});
      await sleep(250);
      save();
      await cdp.detach().catch(() => {});
      log(`  ${name}: ${frames.length} frames`);
    },
  };
}

const at = new WeakMap();
async function glide(page, x, y, ms = 550) {
  const from0 = at.get(page) || { x: W * 0.62, y: H * 0.7 };
  const t0 = Date.now();
  for (;;) {
    const p = Math.min(1, (Date.now() - t0) / ms);
    const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    await page.mouse.move(from0.x + (x - from0.x) * e, from0.y + (y - from0.y) * e);
    if (p >= 1) break;
    await sleep(10);
  }
  at.set(page, { x, y });
}

async function boxOf(locator) {
  for (let i = 0; i < 60; i++) {
    await locator.first().waitFor({ state: "visible", timeout: 90000 });
    const box = await locator.first().boundingBox().catch(() => null);
    if (box) return box;
    await sleep(150);
  }
  throw new Error("an element kept disappearing before it could be measured");
}

async function hover(page, locator, ms = 600) {
  const box = await boxOf(locator);
  await glide(page, box.x + Math.min(box.width / 2, 120), box.y + box.height / 2, ms);
}

async function click(page, locator, { before = 160, ms = 550 } = {}) {
  const box = await boxOf(locator);
  await glide(page, box.x + box.width / 2, box.y + Math.min(box.height / 2, 22), ms);
  await sleep(before);
  await locator.first().click({ delay: 60, timeout: 60000 });
}

async function scrollTo(page, y, ms = 900) {
  await page.evaluate(
    ([y, ms]) =>
      new Promise((done) => {
        const from = scrollY;
        const t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms);
          const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
          scrollTo(0, from + (y - from) * e);
          if (p < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    [y, ms],
  );
}
async function scrollToEl(page, selector, offset = 90, ms = 900) {
  const y = await page.evaluate(([sel, off]) => {
    const el = [...document.querySelectorAll(sel)].pop();
    return el ? el.getBoundingClientRect().top + scrollY - off : 0;
  }, [selector, offset]);
  await scrollTo(page, Math.max(0, y), ms);
}

async function become(page, name) {
  await page.selectOption("#actas select", name ? P(name) : "");
  await sleep(1200);
}

/** Wait for the next toast that is not "busy", and fail on an error toast. */
async function toast(page) {
  const el = page.locator("#toasts .toast.ok, #toasts .toast.err").last();
  await el.waitFor({ state: "visible", timeout: 180000 });
  const bad = await el.evaluate((n) => n.classList.contains("err"));
  const text = await el.innerText();
  if (bad) throw new Error(`the site said: ${text}`);
  return text;
}
const clearToasts = (page) => page.evaluate(() => document.getElementById("toasts").replaceChildren());

async function act(as, action, args) {
  const res = await fetch(`${BASE}/demo/act`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ as: P(as), action, args }) });
  const j = await res.json();
  if (!j.ok) throw new Error(`${as} ${action}: ${j.error}`);
  return j;
}

async function circleNow(id) {
  return (await view(C, "get_circle", { circle_id: id })).circle;
}
async function until(fn, ms = 120000, every = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error("timed out waiting for the chain");
}

// ---- the title cards ----
async function cards(page) {
  const url = pathToFileURL(path.join(ROOT, "demo", "scenes.html")).href;
  for (const [s, secs] of [["intro1", 6.5], ["intro2", 6.5], ["intro3", 5], ["brand", 5], ["close1", 6.5], ["close2", 7]]) {
    await page.goto(`${url}?s=${s}`);
    await sleep(150);
    const shot = await cast(page, `card-${s}`);
    await sleep(secs * 1000);
    await shot.stop();
  }
}

// ---- the live footage ----
async function live(page) {
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector(".daocard", { timeout: 90000 });
  await sleep(1500);
  let id = (await view(C, "list_circles", { from: 0, limit: 100 })).filter((c) => c.name === NAME).pop()?.id;
  const shots = [];
  const S = (n, f) => shots.push([n, f]);

  S(1, async () => {
    const shot = await cast(page, "board");
    await sleep(1800);
    await hover(page, page.locator(".daocard .stats"), 900);
    shot.mark("dao");
    await sleep(3000);
    await shot.stop();
  });

  S(2, async () => {
    await page.goto(`${BASE}/#/dao/${d.dao}`);
    await page.waitForSelector("table.kv", { timeout: 90000 });
    await sleep(1000);
    const shot = await cast(page, "terms");
    await sleep(800);
    await scrollToEl(page, "table.kv", 140);
    shot.mark("terms");
    await hover(page, page.locator("table.kv tr").first(), 700);
    await sleep(2200);
    await hover(page, page.locator("table.kv tr").nth(1), 500);
    await sleep(1500);
    await shot.stop();
  });

  S(3, async () => {
    await page.goto(`${BASE}/#/new`);
    await become(page, "priya");
    await page.waitForSelector(".form input", { timeout: 90000 });
    await sleep(800);
    const shot = await cast(page, "create");
    const name = page.locator(".form input").first();
    await click(page, name);
    await name.fill("");
    await page.keyboard.type(NAME, { delay: 70 });
    shot.mark("named");
    for (const p of ["ama", "tomas", "lin"]) {
      const label = d.people[P(p)].name;
      await click(page, page.locator(".chipbtn", { hasText: label }), { ms: 420 });
      await sleep(350);
    }
    shot.mark("picked");
    await sleep(800);
    await click(page, page.locator(".form .btn.primary"));
    shot.mark("create-click");
    await toast(page);
    shot.mark("created");
    await page.waitForSelector(".seats-table", { timeout: 90000 });
    await sleep(2500);
    shot.mark("page");
    await shot.stop();
    id = (await view(C, "list_circles", { from: 0, limit: 100 })).filter((c) => c.name === NAME).pop().id;
    log(`circle #${id}`);
  });

  S(4, async () => {
    await page.goto(`${BASE}/#/circle/${id}`);
    await page.waitForSelector(".seats-table", { timeout: 90000 });
    await sleep(1500);
    const shot = await cast(page, "seats");
    await sleep(600);
    await hover(page, page.locator(".seats-table tbody tr").nth(0).locator("td").last(), 800);
    shot.mark("priya");
    await sleep(3500);
    await hover(page, page.locator(".seats-table tbody tr").nth(1).locator("td").last(), 700);
    shot.mark("ama");
    await sleep(4000);
    await shot.stop();
  });

  S(5, async () => {
    await clearToasts(page);
    const shot = await cast(page, "round1");
    for (const p of ["ama", "tomas", "lin"]) {
      if (!(await circleNow(id)).seats.find((s) => s.account === P(p)).joined) await act(p, "join", { circle: id });
    }
    await until(async () => (await circleNow(id)).status === "Running");
    await sleep(4500);
    shot.mark("started");
    await click(page, page.locator(".actions .btn.primary", { hasText: "Pay" }));
    shot.mark("pay-click");
    await toast(page);
    shot.mark("paid");
    await Promise.all(["ama", "tomas", "lin"].map((p) => act(p, "pay", { circle: id })));
    await until(async () => (await circleNow(id)).seats.every((s) => s.due !== "Owed"));
    await sleep(4500);
    shot.mark("allpaid");
    await clearToasts(page);
    await click(page, page.locator(".actions .btn", { hasText: "Close the round" }));
    shot.mark("close-click");
    await toast(page);
    shot.mark("closed");
    await until(async () => (await circleNow(id)).round === 2);
    await sleep(2500);
    await hover(page, page.locator(".seats-table tbody tr").nth(0).locator("td").last(), 700);
    shot.mark("priya-pot");
    await sleep(3500);
    await shot.stop();
  });

  S(6, async () => {
    const shot = await cast(page, "social");
    await until(async () => (await page.locator(".thread li").count()) >= 3, 60000, 1000);
    await scrollToEl(page, ".social", 80, 1200);
    shot.mark("thread");
    await sleep(1500);
    await hover(page, page.locator(".thread li .mention").nth(3), 900);
    await sleep(2500);
    await hover(page, page.locator(".thread li").last(), 700);
    shot.mark("last");
    await sleep(3000);
    await scrollTo(page, 0, 900);
    await shot.stop();
  });

  S(7, async () => {
    await clearToasts(page);
    const shot = await cast(page, "round2");
    const c = await circleNow(id);
    const needs = (s) => s.due === "Owed" && BigInt(s.holdback) < BigInt(c.dues);
    await Promise.all(CAST.filter((p) => needs(c.seats.find((s) => s.account === P(p)))).map((p) => act(p, "pay", { circle: id })));
    await until(async () => (await circleNow(id)).seats.every((s) => s.due !== "Owed" || BigInt(s.holdback) >= BigInt(c.dues)));
    await sleep(4500);
    shot.mark("allpaid");
    await click(page, page.locator(".actions .btn", { hasText: "Close the round" }));
    shot.mark("close-click");
    await toast(page);
    shot.mark("closed");
    await until(async () => (await circleNow(id)).round === 3);
    await sleep(2500);
    await hover(page, page.locator(".seats-table tbody tr").nth(1).locator("td").last(), 700);
    shot.mark("ama-pot");
    await sleep(3500);
    await shot.stop();
  });

  S(8, async () => {
    await clearToasts(page);
    const shot = await cast(page, "round3");
    // Priya does not pay. Ama's holdback pays for her.
    await Promise.all(["tomas", "lin"].map((p) => act(p, "pay", { circle: id })));
    await sleep(4500);
    await hover(page, page.locator(".seats-table tbody tr").nth(0).locator("td").nth(2), 800);
    shot.mark("owes");
    await sleep(2000);
    await hover(page, page.locator(".roundbox .countdown"), 700);
    shot.mark("countdown");
    const c = await circleNow(id);
    const wait = c.deadline_ms - Date.now() + 1500;
    if (wait > 0) await sleep(wait);
    await sleep(1200);
    shot.mark("deadline");
    await click(page, page.locator(".actions .btn", { hasText: "Close the round" }));
    shot.mark("close-click");
    await toast(page);
    shot.mark("closed");
    await until(async () => (await circleNow(id)).round === 4);
    await page.waitForSelector(".card.cover .proposal", { timeout: 60000 });
    await sleep(1500);
    await scrollToEl(page, ".card.cover", 90, 900);
    await hover(page, page.locator(".card.cover .pill"), 700);
    shot.mark("cover");
    await sleep(3500);
    await scrollTo(page, 0, 800);
    await hover(page, page.locator(".seats-table tbody tr").nth(2).locator("td").last(), 700);
    shot.mark("tomas-pot");
    await sleep(3000);
    await shot.stop();
  });

  S(9, async () => {
    await clearToasts(page);
    await page.goto(`${BASE}/#/member/${P("priya")}`);
    await page.waitForSelector(".stats", { timeout: 90000 });
    await sleep(1500);
    const shot = await cast(page, "record");
    await hover(page, page.locator(".stat").first(), 800);
    shot.mark("owes");
    await sleep(3000);
    await click(page, page.locator(".btn.primary", { hasText: "Repay" }));
    shot.mark("repay-click");
    await toast(page);
    shot.mark("repaid");
    await sleep(2500);
    await hover(page, page.locator(".stat").first(), 600);
    shot.mark("back");
    await sleep(2500);
    await scrollToEl(page, "table", 120, 1200);
    shot.mark("entries");
    await sleep(3500);
    await shot.stop();
  });

  S(10, async () => {
    await clearToasts(page);
    await page.goto(`${BASE}/#/circle/${id}`);
    await become(page, "priya");
    await page.waitForSelector(".seats-table", { timeout: 90000 });
    await sleep(1200);
    const shot = await cast(page, "round4");
    const c = await circleNow(id);
    const needs = (s) => s.due === "Owed" && BigInt(s.holdback) < BigInt(c.dues);
    await Promise.all(CAST.filter((p) => needs(c.seats.find((s) => s.account === P(p)))).map((p) => act(p, "pay", { circle: id })));
    await until(async () => (await circleNow(id)).seats.every((s) => s.due !== "Owed" || BigInt(s.holdback) >= BigInt(c.dues)));
    await sleep(4500);
    shot.mark("allpaid");
    await click(page, page.locator(".actions .btn", { hasText: "Close the round" }));
    shot.mark("close-click");
    await toast(page);
    shot.mark("closed");
    await until(async () => (await circleNow(id)).status === "Done");
    await sleep(3000);
    shot.mark("done");
    await sleep(1500);
    await until(async () => (await page.locator(".thread li").count()) >= 7, 60000, 1000).catch(() => null);
    await scrollToEl(page, ".thread li:last-child", 260, 1500);
    shot.mark("thread");
    await sleep(4500);
    await shot.stop();
  });

  for (const [n, f] of shots) {
    if (n < from) continue;
    log(`shot ${n}`);
    await f();
  }
}

async function main() {
  let server;
  let browser;
  try {
    server = spawn(process.execPath, [path.join(ROOT, "scripts", "serve.mjs"), "--demo", "--port", String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((ok) => server.stdout.on("data", (b) => String(b).includes("Kitty site") && ok()));
    browser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=1.5", `--window-size=${W},${H}`, "--hide-scrollbars"] });
    const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5, colorScheme: "light" });
    await context.addInitScript(overlay);
    const page = await context.newPage();
    if (what === "all" || what === "cards") await cards(page);
    if (what === "all" || what === "live") await live(page);
  } finally {
    await browser?.close().catch(() => {});
    server?.kill();
  }
}

main().catch((e) => {
  console.error(`\nFailed: ${e.stack || e.message}`);
  process.exit(1);
});
