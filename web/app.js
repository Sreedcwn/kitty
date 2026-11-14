// Kitty's site: a public board of savings circles, members' records, the DAO's book, and each
// circle's near.social thread. Every number on screen is read from NEAR when the page draws.

import { config, view, balance, profileNames, nameOf, thread, postUrl, near, short, ago, until, when } from "./chain.js";

const $ = (sel) => document.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

let C;
let me = null;
let timer = null;
const KEY = "kitty.as";

// ---- who is acting (demo relay only) ----

function actors() {
  return C.demo ? C.actors || [] : [];
}

async function act(action, args = {}, label = action) {
  if (!me) return toast("Pick who you are first, top right.", "warn");
  const t = toast(`${label}…`, "busy");
  try {
    const res = await fetch("/demo/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, as: me, args }) });
    const j = await res.json();
    t.remove();
    if (j.ok) toast(h("span", {}, `${label}: done. `, j.link ? h("a", { href: j.link, target: "_blank", rel: "noopener" }, "transaction") : null), "ok");
    else toast(h("span", {}, `${label}: ${j.error || "failed"} `, j.link ? h("a", { href: j.link, target: "_blank", rel: "noopener" }, "transaction") : null), "err", 9000);
    setTimeout(route, 900);
    return j;
  } catch (e) {
    t.remove();
    toast(`${label}: ${e.message}`, "err");
  }
}

function toast(content, kind = "ok", ms = 6000) {
  const el = h("div", { class: `toast ${kind}` }, content);
  $("#toasts").append(el);
  if (kind !== "busy") setTimeout(() => el.remove(), ms);
  return el;
}

// ---- small pieces ----

function who(id, { link = true, plain = false } = {}) {
  const n = nameOf(id);
  const label = h("span", { class: "who" }, h("span", { class: "dot", style: `background:${hue(id)}` }, (n || short(id))[0].toUpperCase()), h("span", {}, n || short(id)), plain ? null : h("small", {}, ` ${id}`));
  return link ? h("a", { href: `#/member/${id}`, class: "wholink" }, label) : label;
}

function hue(id) {
  let x = 0;
  for (const ch of String(id)) x = (x * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${x} 55% 46%)`;
}

const pill = (text, kind = "") => h("span", { class: `pill ${kind}` }, text);
const statusPill = (s) => pill({ Forming: "Forming", Running: "Collecting", AwaitingCover: "Waiting for the DAO", Done: "Finished", Cancelled: "Cancelled" }[s] || s, s.toLowerCase());
const duePill = (d) =>
  pill(
    { Owed: "Owes", Paid: "Paid", PaidLate: "Paid late", FromHoldback: "From holdback", Covered: "Covered by DAO", Short: "Missed" }[d] || d,
    { Owed: "owed", Paid: "paid", PaidLate: "late", FromHoldback: "hold", Covered: "covered", Short: "missed" }[d] || "",
  );

function stat(label, value, sub) {
  return h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);
}

function txBlock(height) {
  return h("a", { href: `${C.explorer}/blocks/${height}`, target: "_blank", rel: "noopener", class: "mono small" }, `#${height}`);
}

function linkText(text) {
  // Mentions become links to the member's record; everything else stays plain text.
  const out = [];
  const re = /@([a-z0-9_\-.]+\.(?:testnet|near))/g;
  let i = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(i, m.index));
    const id = m[1];
    out.push(id === C.dao ? h("a", { href: `#/dao/${id}`, class: "mention" }, `@${nameOf(id) || short(id)}`) : h("a", { href: `#/member/${id}`, class: "mention" }, `@${nameOf(id) || short(id)}`));
    i = m.index + m[0].length;
  }
  out.push(text.slice(i));
  return out;
}

// ---- pages ----

async function board() {
  const [dao, circles, avail] = await Promise.all([view(C.contract, "get_dao", { dao: C.dao }), view(C.contract, "list_circles", { from: 0, limit: 100 }), view(C.dao, "get_available_amount").catch(() => "0")]);
  await profileNames([...new Set(circles.flatMap((c) => c.seats.map((s) => s.account)))]);
  const t = dao.terms;
  const b = dao.book;
  const exposurePct = Math.min(100, Number((BigInt(b.exposure) * 1000n) / BigInt(t.max_exposure || 1)) / 10);
  const live = circles.filter((c) => ["Forming", "Running", "AwaitingCover"].includes(c.status)).reverse();
  const past = circles.filter((c) => !["Forming", "Running", "AwaitingCover"].includes(c.status)).reverse();
  return [
    h(
      "section",
      { class: "hero" },
      h("div", {}, h("h1", {}, "Savings circles your community stands behind."), h("p", { class: "lead" }, "Members of a DAO pool the same amount every round, and each round one of them takes the whole pot. Kitty holds back a newcomer's future dues from their pot, so nobody in the circle can lose money. A member with a record of paying gets the full pot early, because the DAO's treasury covers them if they slip."), C.demo ? h("a", { class: "btn primary", href: "#/new" }, "Start a circle") : null),
      h(
        "a",
        { class: "card daocard", href: `#/dao/${C.dao}` },
        h("div", { class: "eyebrow" }, "Backed by"),
        h("h3", {}, C.label, " ", h("small", { class: "mono" }, C.dao)),
        h("div", { class: "stats" }, stat("Treasury", `${near(avail)} NEAR`), stat("Credit out", `${near(b.exposure)} NEAR`, `of ${near(t.max_exposure)} limit`), stat("Owed to DAO", `${near(b.debts)} NEAR`, `${b.covers} cover${b.covers === 1 ? "" : "s"} so far`)),
        h("div", { class: "bar" }, h("span", { style: `width:${exposurePct}%` })),
        h("div", { class: "small muted" }, `Covers up to ${near(t.auto_cover_max)} NEAR pass with Kitty's own vote. Larger ones go to the council.`),
      ),
    ),
    h("h2", {}, "Open circles"),
    live.length ? h("div", { class: "grid" }, live.map(circleCard)) : h("p", { class: "muted" }, "No open circles right now."),
    past.length ? [h("h2", {}, "Finished"), h("div", { class: "grid" }, past.slice(0, 3).map(circleCard)), past.length > 3 ? h("p", { class: "small muted" }, `and ${past.length - 3} more`) : null] : null,
  ];
}

function circleCard(c) {
  const n = c.seats.length;
  const paid = c.seats.filter((s) => s.due !== "Owed").length;
  const taker = c.status === "Running" || c.status === "AwaitingCover" ? c.seats[c.round - 1]?.account : null;
  return h(
    "a",
    { class: "card circle", href: `#/circle/${c.id}` },
    h("div", { class: "row between" }, h("h3", {}, c.name), statusPill(c.status)),
    h("div", { class: "small muted" }, `${near(c.dues)} NEAR a round · ${n} seats · pot ${near(BigInt(c.dues) * BigInt(n))} NEAR`),
    h("div", { class: "seats" }, c.seats.map((s, i) => h("span", { class: `seat ${s.took_round ? "took" : ""} ${i === c.round - 1 && taker ? "now" : ""}`, title: nameOf(s.account) || s.account, style: `background:${hue(s.account)}` }, (nameOf(s.account) || short(s.account))[0]))),
    c.status === "Running" ? h("div", { class: "small" }, `Round ${c.round} of ${n}: ${paid}/${n} settled · `, h("span", { class: "countdown", "data-deadline": c.deadline_ms }, until(c.deadline_ms))) : null,
    c.status === "Forming" ? h("div", { class: "small" }, `${c.seats.filter((s) => s.joined).length}/${n} seats taken`) : null,
    c.status === "AwaitingCover" ? h("div", { class: "small" }, `Round ${c.round}: waiting for ${C.label} to cover a missed payment`) : null,
  );
}

async function circlePage(id) {
  const g = await view(C.contract, "get_circle", { circle_id: Number(id) });
  const c = g.circle;
  const n = c.seats.length;
  await profileNames([...c.seats.map((s) => s.account), c.dao]);
  const pot = BigInt(c.dues) * BigInt(n);
  const mine = c.seats.find((s) => s.account === me);
  const actions = [];
  if (C.demo && me) {
    if (c.status === "Forming" && mine && !mine.joined) actions.push(h("button", { class: "btn primary", onclick: () => act("join", { circle: c.id }, "Take my seat") }, "Take my seat"));
    if (c.status === "Running" && mine && mine.due === "Owed") actions.push(h("button", { class: "btn primary", onclick: () => act("pay", { circle: c.id }, `Pay ${near(c.dues)} NEAR`) }, `Pay ${near(c.dues)} NEAR`));
    if (c.status === "Running") {
      const allIn = c.seats.every((s) => s.due !== "Owed" || BigInt(s.holdback) >= BigInt(c.dues));
      const past = Date.now() > c.deadline_ms;
      actions.push(h("button", { class: "btn", disabled: !(allIn || past), title: allIn || past ? "" : "Possible once everyone has paid or the deadline has passed", onclick: () => act("close", { circle: c.id }, "Close the round") }, "Close the round"));
    }
    if (c.status === "AwaitingCover") actions.push(h("button", { class: "btn", onclick: () => act("close", { circle: c.id }, "Check the cover") }, "Check the cover"));
  }

  let coverBox = null;
  if (c.cover) {
    let prop = null;
    if (c.cover.proposal_id != null) prop = await view(c.dao, "get_proposal", { id: c.cover.proposal_id }).catch(() => null);
    coverBox = h(
      "section",
      { class: "card cover" },
      h("h3", {}, "A missed payment, and the DAO's cover"),
      h("p", {}, c.cover.seats.map((i) => who(c.seats[i].account, { plain: true })), ` did not pay round ${c.cover.round}. Kitty asked ${C.label} to send exactly ${near(c.cover.amount)} NEAR to the circle, so the pot still pays out in full.`),
      prop
        ? h(
            "div",
            { class: "proposal" },
            h("div", { class: "row between" }, h("strong", {}, `Proposal #${c.cover.proposal_id} on ${c.dao}`), pill(prop.status, prop.status.toLowerCase())),
            h("div", { class: "small muted" }, c.cover.auto ? `Within the ${near(g.terms.auto_cover_max)} NEAR auto-cover limit, so Kitty's own vote in its DAO role passes it.` : "Above the auto-cover limit, so it needs the council's votes."),
            h("div", { class: "small" }, "Votes: ", Object.entries(prop.votes || {}).map(([a, v]) => h("span", { class: "chip" }, `${short(a)}: ${v}`))),
            !c.cover.auto && C.demo && me && C.council.includes(me) && prop.status === "InProgress" ? h("button", { class: "btn primary", onclick: () => act("vote", { id: c.cover.proposal_id, action: "VoteApprove" }, "Approve the cover") }, "Approve as council") : null,
          )
        : h("div", { class: "small muted" }, "The proposal is being filed."),
    );
  }

  const seatRows = c.seats.map((s, i) => {
    const q = g.quotes[i];
    const log = c.log.find((l) => l.round === s.took_round);
    let turn;
    if (log) {
      turn = h("div", {}, h("strong", {}, `${near(log.paid)} NEAR`), ` in round ${log.round}`, potBar(BigInt(log.paid), BigInt(log.backed), BigInt(log.holdback), BigInt(log.recovered), pot));
    } else if (q) {
      turn = h(
        "div",
        {},
        h("strong", {}, `${near(q.pay)} NEAR`),
        BigInt(q.backed) > 0n ? h("span", { class: "small credit" }, ` incl. ${near(q.backed)} credit`) : null,
        BigInt(q.holdback) > 0n ? h("span", { class: "small muted" }, ` + ${near(q.holdback)} held back`) : null,
        potBar(BigInt(q.pay), BigInt(q.backed), BigInt(q.holdback), BigInt(q.recover), pot),
      );
    }
    return h(
      "tr",
      { class: i === c.round - 1 && ["Running", "AwaitingCover"].includes(c.status) ? "current" : "" },
      h("td", { class: "num" }, i + 1),
      h("td", {}, who(s.account)),
      h("td", {}, c.status === "Forming" ? pill(s.joined ? "Joined" : "Invited", s.joined ? "paid" : "owed") : ["Running", "AwaitingCover"].includes(c.status) ? duePill(s.due) : pill(s.missed ? `${s.missed} missed` : "Paid in full", s.missed ? "missed" : "paid")),
      h("td", { class: "num" }, BigInt(s.holdback) > 0n ? `${near(s.holdback)}` : "–"),
      h("td", {}, turn),
    );
  });

  // Every cover the DAO paid in this circle, as the DAO itself records it.
  const coverLogs = c.log.filter((l) => l.cover_proposal != null && BigInt(l.covered) > 0n);
  const coverProps = await Promise.all(coverLogs.map((l) => view(c.dao, "get_proposal", { id: l.cover_proposal }).catch(() => null)));
  const coversBox = coverLogs.length
    ? h(
        "section",
        { class: "card cover" },
        h("h3", {}, `Covers ${C.label} paid in this circle`),
        coverLogs.map((l, i) => {
          const p = coverProps[i];
          return h(
            "div",
            { class: "proposal" },
            h("div", { class: "row between" }, h("strong", {}, `Round ${l.round}: proposal #${l.cover_proposal} on ${c.dao}`), p ? pill(p.status, p.status.toLowerCase()) : null),
            h("div", {}, `${near(l.covered)} NEAR sent by the DAO to the circle's receive_cover, so `, who(l.recipient, { plain: true }), ` got the full pot.`),
            p ? h("div", { class: "small" }, "Filed by ", h("span", { class: "mono" }, p.proposer), " · votes: ", Object.entries(p.votes || {}).map(([a, v]) => h("span", { class: "chip" }, `${a === C.contract ? "Kitty" : nameOf(a) || short(a)}: ${v}`))) : null,
            p ? h("div", { class: "small muted" }, p.kind?.FunctionCall ? `FunctionCall ${p.kind.FunctionCall.receiver_id}.${p.kind.FunctionCall.actions[0].method_name}, deposit ${near(p.kind.FunctionCall.actions[0].deposit)} NEAR` : "") : null,
          );
        }),
      )
    : null;

  const posts = await thread(C.contract, c.thread).catch(() => []);
  const mentioned = [...new Set(posts.flatMap((p) => [...p.text.matchAll(/@([a-z0-9_\-.]+\.(?:testnet|near))/g)].map((m) => m[1])))];
  await profileNames(mentioned);

  return [
    h("a", { href: "#/", class: "back" }, "← All circles"),
    h(
      "section",
      { class: "head" },
      h("div", {}, h("div", { class: "eyebrow" }, `Circle #${c.id} · `, h("a", { href: `#/dao/${c.dao}` }, C.label)), h("h1", {}, c.name), h("div", { class: "row gap" }, statusPill(c.status), h("span", { class: "muted" }, `${near(c.dues)} NEAR a round · ${n} seats · pot ${near(pot)} NEAR · rounds of ${c.round_secs >= 3600 ? `${c.round_secs / 3600} h` : `${c.round_secs} s`}`))),
      ["Running", "AwaitingCover"].includes(c.status)
        ? h("div", { class: "roundbox" }, h("div", { class: "label" }, `Round ${c.round} of ${n}`), h("div", { class: "value" }, who(c.seats[c.round - 1].account, { link: false, plain: true })), h("div", { class: "small muted" }, "takes this pot"), c.status === "Running" ? h("div", { class: "countdown big", "data-deadline": c.deadline_ms }, until(c.deadline_ms)) : null)
        : null,
    ),
    actions.length ? h("div", { class: "actions" }, h("span", { class: "muted small" }, `As ${nameOf(me) || short(me)}:`), actions) : null,
    coverBox,
    coversBox,
    h(
      "section",
      { class: "card" },
      h("h3", {}, "Seats, in payout order"),
      h("p", { class: "small muted" }, "The last column is what each member receives in their turn, given their record today. ", h("span", { class: "key k-cash" }, "own money"), h("span", { class: "key k-credit" }, "credit the DAO stands behind"), h("span", { class: "key k-hold" }, "held back for their later dues"), h("span", { class: "key k-rec" }, "repays the DAO")),
      h("table", { class: "seats-table" }, h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Member"), h("th", {}, c.status === "Forming" ? "Seat" : "This round"), h("th", { class: "num" }, "Holdback"), h("th", {}, "Their pot"))), h("tbody", {}, seatRows)),
    ),
    c.log.length
      ? h(
          "section",
          { class: "card" },
          h("h3", {}, "Rounds"),
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", {}, "Round"), h("th", {}, "Pot to"), h("th", { class: "num" }, "Paid out"), h("th", { class: "num" }, "Credit"), h("th", { class: "num" }, "Held back"), h("th", {}, "DAO"), h("th", {}, "Closed"))),
            h(
              "tbody",
              {},
              c.log.map((l) =>
                h(
                  "tr",
                  {},
                  h("td", { class: "num" }, l.round),
                  h("td", {}, who(l.recipient, { plain: true })),
                  h("td", { class: "num" }, near(l.paid)),
                  h("td", { class: "num" }, BigInt(l.backed) ? near(l.backed) : "–"),
                  h("td", { class: "num" }, BigInt(l.holdback) ? near(l.holdback) : "–"),
                  h("td", { class: "small" }, BigInt(l.covered) ? `covered ${near(l.covered)} (proposal #${l.cover_proposal})` : BigInt(l.recovered) ? `repaid ${near(l.recovered)}` : BigInt(l.short) ? `short ${near(l.short)}` : "–"),
                  h("td", { class: "small muted" }, ago(l.closed_ms)),
                ),
              ),
            ),
          ),
        )
      : null,
    h(
      "section",
      { class: "card social" },
      h("div", { class: "row between" }, h("h3", {}, "On near.social"), c.thread ? h("a", { class: "small", href: postUrl(C, C.contract, c.thread), target: "_blank", rel: "noopener" }, "Thread data") : null),
      h("p", { class: "small muted" }, `Kitty's contract posts every event of this circle as one near.social thread, from its own account ${C.contract}. Each post mentions the members it is about, and near.social notifies the first ten accounts a post mentions: that is how members hear their dues are due, or that the pot is theirs.${C.network === "mainnet" ? "" : " Read here from the public testnet index of the same data standard near.social uses on mainnet."}`),
      posts.length ? h("ol", { class: "thread" }, posts.map((p) => h("li", { class: p.reply_to ? "reply" : "root" }, h("div", { class: "meta" }, h("span", { class: "author" }, "Kitty"), h("span", { class: "muted small" }, ` · ${ago(p.at_ms)} · `), h("a", { class: "small", href: postUrl(C, p.author, p.id), target: "_blank", rel: "noopener" }, `post/${p.id}`)), h("div", { class: "text" }, linkText(p.text))))) : h("p", { class: "muted" }, "No posts indexed yet. They usually appear within a few seconds."),
    ),
  ];
}

function potBar(pay, backed, holdback, recovered, pot) {
  const own = pay - backed;
  const pct = (x) => (pot > 0n ? Number((x * 1000n) / pot) / 10 : 0);
  return h(
    "div",
    { class: "potbar", title: `own money ${near(own)} · credit ${near(backed)} · held back ${near(holdback)} · repays DAO ${near(recovered)}` },
    own > 0n ? h("span", { class: "k-cash", style: `width:${pct(own)}%` }) : null,
    backed > 0n ? h("span", { class: "k-credit", style: `width:${pct(backed)}%` }) : null,
    holdback > 0n ? h("span", { class: "k-hold", style: `width:${pct(holdback)}%` }) : null,
    recovered > 0n ? h("span", { class: "k-rec", style: `width:${pct(recovered)}%` }) : null,
  );
}

async function memberPage(id) {
  const rec = await view(C.contract, "get_record", { account: id });
  await profileNames([id]);
  const withDao = rec.daos.find((x) => x.dao === C.dao) || { stats: { self_paid: "0", earned: "0", rounds_paid: 0, rounds_late: 0, misses: 0, pots_taken: 0, circles_done: 0, credit_used: "0" }, credit: "0" };
  const s = withDao.stats;
  const owed = rec.debts.reduce((a, d) => a + BigInt(d.amount), 0n);
  const label = {
    paid: "Paid dues, on time",
    paid_late: "Paid dues, late",
    paid_from_holdback: "Dues paid from holdback",
    missed: "Missed a round",
    covered_by_dao: "The DAO covered a missed round",
    took_pot: "Took the pot",
    holdback_returned: "Holdback returned",
    circle_finished: "Finished a circle: added to record",
    repaid: "Repaid a debt",
    repaid_from_pot: "Debt repaid from their pot",
  };
  return [
    h("a", { href: "#/", class: "back" }, "← All circles"),
    h("section", { class: "head" }, h("div", {}, h("div", { class: "eyebrow" }, "Member record"), h("h1", {}, nameOf(id) || short(id)), h("div", { class: "mono muted" }, id), h("div", { class: "small muted" }, "Name from this account's near.social profile."))),
    h(
      "section",
      { class: "card" },
      h("div", { class: "row between" }, h("h3", {}, `With ${C.label}`), owed > 0n ? pill(`Owes ${near(owed)} NEAR`, "missed") : pill("Owes nothing", "paid")),
      h(
        "div",
        { class: "stats" },
        stat("Credit today", `${near(withDao.credit)} NEAR`, owed > 0n ? "Zero until the debt is repaid" : `Every unit from dues paid in finished circles`),
        stat("Circles finished", s.circles_done, `${s.pots_taken} pot${s.pots_taken === 1 ? "" : "s"} taken`),
        stat("Rounds paid on time", s.rounds_paid, `${near(s.self_paid)} NEAR in total`),
        stat("Misses", s.misses, s.rounds_late ? `${s.rounds_late} paid late` : "–"),
      ),
      owed > 0n && C.demo && me === id ? h("button", { class: "btn primary", onclick: () => act("repay", {}, `Repay ${near(owed)} NEAR`) }, `Repay ${near(owed)} NEAR`) : null,
      rec.debts.length ? h("ul", { class: "debts" }, rec.debts.map((d) => h("li", {}, `${near(d.amount)} NEAR to `, d.creditor === d.dao ? h("a", { href: `#/dao/${d.dao}` }, C.label) : who(d.creditor, { plain: true }), ` for round ${d.round} of `, h("a", { href: `#/circle/${d.circle}` }, `circle #${d.circle}`)))) : null,
    ),
    h(
      "section",
      { class: "card" },
      h("h3", {}, "Every entry in this record"),
      h("p", { class: "small muted" }, "Each line was written by the contract when it happened. The block links to the explorer."),
      rec.entries.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", {}, "What"), h("th", { class: "num" }, "NEAR"), h("th", {}, "Circle"), h("th", {}, "When"), h("th", {}, "Block"))),
            h("tbody", {}, [...rec.entries].reverse().map((e) => h("tr", { class: `entry ${e.kind}` }, h("td", {}, label[e.kind] || e.kind), h("td", { class: "num" }, near(e.amount)), h("td", {}, h("a", { href: `#/circle/${e.circle}` }, `#${e.circle}`), ` round ${e.round}`), h("td", { class: "small muted" }, when(e.at_ms)), h("td", {}, txBlock(e.block))))),
          )
        : h("p", { class: "muted" }, "Nothing yet."),
    ),
  ];
}

async function daoPage(dao) {
  const [st, policy, avail, circles] = await Promise.all([view(C.contract, "get_dao", { dao }), view(dao, "get_policy"), view(dao, "get_available_amount").catch(() => "0"), view(C.contract, "list_circles", { from: 0, limit: 100 })]);
  const t = st.terms;
  const b = st.book;
  const roles = policy.roles.filter((r) => r.kind?.Group);
  const everyone = [...new Set(roles.filter((r) => t.member_roles.includes(r.name)).flatMap((r) => r.kind.Group))];
  await profileNames(everyone);
  const records = await Promise.all(everyone.map((id) => view(C.contract, "get_record", { account: id }).then((r) => ({ id, r }))));
  const kittyRole = roles.find((r) => r.kind.Group.includes(C.contract));
  const covers = circles.filter((c) => c.dao === dao).flatMap((c) => c.log.filter((l) => BigInt(l.covered) > 0n).map((l) => ({ c, l })));
  return [
    h("a", { href: "#/", class: "back" }, "← All circles"),
    h("section", { class: "head" }, h("div", {}, h("div", { class: "eyebrow" }, "Sputnik DAO"), h("h1", {}, C.label), h("div", { class: "mono muted" }, dao))),
    h(
      "section",
      { class: "card" },
      h("h3", {}, "The book"),
      h("div", { class: "stats" }, stat("Treasury available", `${near(avail)} NEAR`), stat("Credit out now", `${near(b.exposure)} NEAR`, `limit ${near(t.max_exposure)}`), stat("Owed to the DAO", `${near(b.debts)} NEAR`), stat("Covered so far", `${near(b.covered)} NEAR`, `${b.covers} cover${b.covers === 1 ? "" : "s"}, ${near(b.recovered)} back`)),
    ),
    h(
      "section",
      { class: "card" },
      h("h3", {}, "Terms the council voted for"),
      h("p", { class: "small muted" }, "Set once, by an ordinary FunctionCall proposal on this DAO that calls set_terms. Only the DAO itself can change them."),
      h(
        "table",
        { class: "kv" },
        h(
          "tbody",
          {},
          h("tr", {}, h("th", {}, "Credit earned"), h("td", {}, `${t.backing_bps / 100}% of the dues a member paid themselves, on time, in circles they finished`)),
          h("tr", {}, h("th", {}, "Most credit per member"), h("td", {}, `${near(t.max_backing)} NEAR`)),
          h("tr", {}, h("th", {}, "Most credit in total"), h("td", {}, `${near(t.max_exposure)} NEAR`)),
          h("tr", {}, h("th", {}, "Auto-cover limit"), h("td", {}, `${near(t.auto_cover_max)} NEAR: Kitty's own vote passes a cover up to this; above it the council votes`)),
          h("tr", {}, h("th", {}, "Largest dues"), h("td", {}, `${near(t.max_dues)} NEAR a round`)),
          h("tr", {}, h("th", {}, "Who may sit in circles"), h("td", {}, `Members of the roles ${t.member_roles.join(", ")}`)),
          h("tr", {}, h("th", {}, "Cover wait"), h("td", {}, `${t.cover_wait_secs / 60} min, then a round pays out short and the misser owes the recipient`)),
          h("tr", {}, h("th", {}, "Kitty's role"), h("td", {}, kittyRole ? `"${kittyRole.name}": ${kittyRole.permissions.join(", ")}, holding only ${C.contract}` : "none: Kitty cannot ask for covers")),
        ),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h3", {}, "Members and their credit"),
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Member"), h("th", {}, "Role"), h("th", { class: "num" }, "Circles"), h("th", { class: "num" }, "On time"), h("th", { class: "num" }, "Misses"), h("th", { class: "num" }, "Credit"), h("th", { class: "num" }, "Owes"))),
        h(
          "tbody",
          {},
          records.map(({ id, r }) => {
            const x = r.daos.find((y) => y.dao === dao);
            const owes = r.debts.reduce((a, d) => a + BigInt(d.amount), 0n);
            return h("tr", {}, h("td", {}, who(id)), h("td", { class: "small" }, roles.filter((ro) => ro.kind.Group.includes(id)).map((ro) => ro.name).join(", ")), h("td", { class: "num" }, x?.stats.circles_done || 0), h("td", { class: "num" }, x?.stats.rounds_paid || 0), h("td", { class: "num" }, x?.stats.misses || 0), h("td", { class: "num" }, near(x?.credit || 0)), h("td", { class: "num" }, owes ? near(owes) : "–"));
          }),
        ),
      ),
    ),
    covers.length
      ? h(
          "section",
          { class: "card" },
          h("h3", {}, "Covers the DAO paid"),
          h("ul", {}, covers.map(({ c, l }) => h("li", {}, `${near(l.covered)} NEAR for round ${l.round} of `, h("a", { href: `#/circle/${c.id}` }, c.name), `, proposal #${l.cover_proposal}`))),
        )
      : null,
  ];
}

async function newPage() {
  if (!C.demo) return [h("p", {}, "Starting a circle needs the demo relay: run node scripts/serve.mjs --demo.")];
  const policy = await view(C.dao, "get_policy");
  const st = await view(C.contract, "get_dao", { dao: C.dao });
  const pool = [...new Set(policy.roles.filter((r) => r.kind?.Group && st.terms.member_roles.includes(r.name)).flatMap((r) => r.kind.Group))];
  await profileNames(pool);
  const picked = [];
  const list = h("ol", { class: "picked" });
  const draw = () => {
    list.replaceChildren(...picked.map((id, i) => h("li", {}, who(id, { link: false, plain: true }), h("button", { class: "mini", onclick: () => { picked.splice(i, 1); draw(); } }, "remove"))));
  };
  if (me && pool.includes(me)) picked.push(me);
  draw();
  const name = h("input", { value: "December rent", maxlength: 48 });
  const dues = h("input", { value: "0.1", type: "number", step: "0.01", min: "0.01" });
  const secs = h("input", { value: "60", type: "number", min: "30" });
  return [
    h("a", { href: "#/", class: "back" }, "← All circles"),
    h("h1", {}, "Start a circle"),
    h(
      "section",
      { class: "card form" },
      h("label", {}, "Name", name),
      h("label", {}, "Dues per round (NEAR)", dues),
      h("label", {}, "Round length (seconds)", secs, h("small", { class: "muted" }, "Short for the demo. A real circle would use a week or a month.")),
      h("div", {}, h("div", { class: "label" }, "Seats, in payout order. Click members to add them."), h("div", { class: "pool" }, pool.map((id) => h("button", { class: "chipbtn", onclick: () => { if (!picked.includes(id)) picked.push(id); draw(); } }, nameOf(id) || short(id)))), list),
      h("button", {
        class: "btn primary",
        onclick: async () => {
          const yocto = BigInt(Math.round(Number(dues.value) * 1e6)) * 10n ** 18n;
          const j = await act("create", { name: name.value, dues: yocto.toString(), round_secs: Number(secs.value), members: picked }, "Create the circle");
          if (j?.ok && j.value?.id != null) location.hash = `#/circle/${j.value.id}`;
        },
      }, "Create the circle"),
    ),
  ];
}

function howPage() {
  return [
    h("a", { href: "#/", class: "back" }, "← All circles"),
    h("h1", {}, "How Kitty works"),
    h(
      "section",
      { class: "card prose" },
      h("p", {}, "A rotating savings circle is the oldest community finance there is: a chit fund in India, a tanda in Mexico, a susu in Ghana, a hui in China, a kye in Korea. Everyone pays the same amount every round, and one member takes the whole pot each round, in turn. The early takers get an interest-free loan; the late takers save. Its one weakness is trust: whoever takes the pot early can stop paying."),
      h("p", {}, "Kitty takes that risk away from the circle and gives it, capped, to the community that already shares a treasury:"),
      h(
        "ol",
        {},
        h("li", {}, h("strong", {}, "Holdback. "), "When a member takes the pot, the dues they still owe are held back from it and pay their later rounds automatically. A newcomer receives exactly what they have paid in. Nobody in the circle can lose money."),
        h("li", {}, h("strong", {}, "Credit. "), "The DAO's terms turn a member's record into credit: the dues they paid themselves, on time, in circles they finished. Credit replaces holdback, so a member with a record gets the full pot early."),
        h("li", {}, h("strong", {}, "Cover. "), "If a member misses a round, Kitty files an ordinary FunctionCall proposal on the DAO that sends exactly the missing dues to the circle. A small cover passes with Kitty's own vote in a role the council gave it; a larger one waits for the council. The pot pays out in full either way."),
        h("li", {}, h("strong", {}, "Debt. "), "The member who missed now owes the DAO, and their credit is zero until they repay. If they had not taken their pot yet, the debt comes out of it automatically."),
        h("li", {}, h("strong", {}, "near.social. "), "Every event is a post in the circle's near.social thread, written by the contract and mentioning the members it is about. Mentions notify, so members hear about their dues where they already are."),
      ),
      h("p", {}, "Kitty holds no DAO money and has no multisig of its own. The treasury, the council and its votes stay in Sputnik DAO."),
    ),
  ];
}

// ---- router ----

let gen = 0;
async function route() {
  clearInterval(timer);
  const mine = ++gen;
  const [, page, arg] = (location.hash || "#/").split("/");
  const main = $("#main");
  try {
    let content;
    if (page === "circle") content = await circlePage(arg);
    else if (page === "member") content = await memberPage(decodeURIComponent(arg));
    else if (page === "dao") content = await daoPage(decodeURIComponent(arg));
    else if (page === "new") content = await newPage();
    else if (page === "how") content = howPage();
    else content = await board();
    if (mine !== gen) return;
    main.replaceChildren(...[content].flat(Infinity).filter(Boolean));
    document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#/${page || ""}` || (page === "dao" && a.getAttribute("href").startsWith("#/dao"))));
  } catch (e) {
    if (mine !== gen) return;
    main.replaceChildren(h("div", { class: "card err" }, h("h3", {}, "Could not read the chain"), h("p", {}, e.message)));
  }
  // Live pages refresh themselves, so a demo can be watched without reloading.
  if (page === "circle" || !page) timer = setInterval(refresh, 4000);
  tick();
}

let refreshing = false;
async function refresh() {
  if (refreshing || document.querySelector("input:focus")) return;
  refreshing = true;
  const y = scrollY;
  const mine = gen;
  try {
    const [, page, arg] = (location.hash || "#/").split("/");
    const content = page === "circle" ? await circlePage(arg) : await board();
    if (mine !== gen) return;
    $("#main").replaceChildren(...[content].flat(Infinity).filter(Boolean));
    scrollTo(0, y);
    tick();
  } catch {
  } finally {
    refreshing = false;
  }
}

function tick() {
  document.querySelectorAll(".countdown").forEach((el) => (el.textContent = until(Number(el.dataset.deadline))));
}
setInterval(tick, 1000);

async function start() {
  C = await config();
  $("#net").textContent = C.network === "mainnet" ? "NEAR mainnet" : "Live on NEAR testnet · test tokens";
  $("#daolink").setAttribute("href", `#/dao/${C.dao}`);
  $("#daolink").textContent = C.label;
  if (C.demo) {
    await profileNames(actors());
    try {
      me = localStorage.getItem(KEY);
    } catch {}
    if (!actors().includes(me)) me = null;
    const sel = h("select", { onchange: (e) => { me = e.target.value || null; try { localStorage.setItem(KEY, me || ""); } catch {} route(); } }, h("option", { value: "" }, "Act as…"), actors().map((id) => h("option", { value: id, selected: id === me }, nameOf(id) || short(id))));
    $("#actas").replaceChildren(h("span", { class: "small muted" }, "Demo: "), sel);
  }
  addEventListener("hashchange", route);
  route();
}

start();
