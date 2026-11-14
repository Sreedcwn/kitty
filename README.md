# Kitty

Rotating savings circles on NEAR, backed by a Sputnik DAO.

Members of a DAO pool the same amount every round, and each round one of them takes the whole pot. Kitty holds back a newcomer's future dues from their pot, so nobody in a circle can lose money. A member with a record of paying gets the full pot early instead, because the DAO's treasury covers them if they slip. A missed payment becomes an ordinary DAO proposal; small ones pass with the one vote the council gave Kitty, large ones wait for the council. Every event is a post in the circle's near.social thread.

- **Built at:** NEAR HACKATHON, November 2026
- **Track:** Social Money (`social`)
- **Built on:** Sputnik DAO v2, NEAR named accounts, near.social (FastData KV), Trezu's proposal description format
- **Network:** NEAR testnet
- **Contract:** [`v1.kitty-hq.testnet`](https://testnet.nearblocks.io/address/v1.kitty-hq.testnet)
- **Demo DAO:** [`banyan.sputnikv2.testnet`](https://testnet.nearblocks.io/address/banyan.sputnikv2.testnet) ("Banyan Co-op"), members `*.banyan-coop.testnet`
- **Demo video:** [`demo/kitty-demo.mp4`](demo/kitty-demo.mp4), recorded from the real site against live testnet. The narration is an AI voice.

## The problem

A rotating savings circle is one of the oldest forms of community finance: a chit fund in India, a tanda in Mexico, a susu in Ghana, a hui in China, a kye in Korea. Everyone pays the same amount each round and one member takes the whole pot, in turn. Early takers get an interest-free loan, late takers save. They are still in everyday use: the World Bank's Global Findex 2021 notes that in Sub-Saharan Africa, mobile money is moving savings away from less formal methods "such as saving at home or with a rotating savings and credit association (ROSCA)" ([source](https://www.worldbank.org/en/publication/globalfindex/brief/data-from-the-global-findex-2021-financial-wellbeing-in-sub-saharan-africa)).

A circle has one weakness: whoever takes the pot early can stop paying, and the others lose. So circles only form among people who already trust each other, and they stay small.

NEAR communities already share treasuries in Sputnik DAOs, and their members already have named accounts. What they do not have is a way to turn a member's history of keeping promises into something worth money. Kitty does that, with the treasury and the council the community already has.

## How NEAR fits

- **Sputnik DAO** holds the money and the votes. The council installs Kitty with two ordinary proposals, and every cover is an ordinary FunctionCall proposal that the DAO itself executes. Kitty has no multisig and holds no treasury money.
- **Named accounts** carry the reputation. A member's record is keyed to `priya.banyan-coop.testnet`, and every point of it traces to a circle, a round and a block.
- **near.social** carries the conversation. The contract writes each circle as a thread on near.social's data layer, and mentions notify members when their dues are due or the pot is theirs.
- **Cross-contract calls** let the contract read the DAO's live policy before a circle starts, and file, approve and receive a cover in a single transaction.

## How it works

| Step | What happens |
|---|---|
| **Terms, once** | The DAO's council passes one ordinary FunctionCall proposal that calls `set_terms`: how much credit a record earns, the cap per member and in total, and the largest cover Kitty may approve on its own. A second proposal adds a role holding only the Kitty contract, with `call:AddProposal` and `call:VoteApprove`. |
| **A circle** | A member starts a circle of DAO members (checked against the DAO's live policy). Seat order is payout order. Everyone takes their seat; round 1 opens. |
| **Holdback** | When a member takes the pot, the dues they still owe are held back from it, and pay their later rounds automatically. A newcomer gets back exactly what they paid in. Nobody in the circle carries anyone's risk. |
| **Credit** | Credit replaces holdback. A member's credit is a share (set by the DAO) of the dues they paid themselves, on time, in circles they finished, capped per member and by the DAO's total exposure. So a member with a record gets the full pot early. |
| **Cover** | If a member misses a round, Kitty files a FunctionCall proposal on the DAO that sends exactly the missing dues to the circle's `receive_cover`. Up to the auto limit, Kitty's own vote passes it in the same transaction; above it, the council votes like on any proposal. The pot pays out in full either way. |
| **Debt** | The member who missed owes the DAO, and their credit is zero until they repay with `repay`. If they had not taken their pot yet, the debt comes out of it, back to the DAO, automatically. |
| **near.social** | The contract posts every event (circle opened, round open with who must pay by when, pot paid, cover asked, debt repaid, circle finished) as one near.social thread per circle, from its own account. Each post mentions the members it is about, and near.social notifies the first ten accounts a post mentions. |

The demo circle, "December rent" (circle #3), four seats at 0.1 NEAR a round:

| Round | Takes the pot | Paid out | Of which credit | Held back | What happened |
|---|---|---|---|---|---|
| 1 | Priya (finished a circle before: 0.3 NEAR credit) | 0.4 | 0.3 | 0 | |
| 2 | Ama (new: no credit) | 0.2 | 0 | 0.2 | Her rounds 3 and 4 are paid from it |
| 3 | Tomás | 0.4 | 0.1 | 0 | Priya missed. Kitty filed [proposal #5](https://testnet.nearblocks.io/address/banyan.sputnikv2.testnet) for 0.1 NEAR and passed it with its own vote. Priya then repaid. |
| 4 | Lin | 0.4 | 0 | 0 | Circle complete |

What Kitty does not do: it holds no DAO money and has no multisig of its own. The treasury, the council and its votes stay in Sputnik DAO. The contract only holds the dues of circles that are running.

## Track requirements

The Social Money prompt describes a bounty board with earned trust. Kitty applies the same four requirements to savings circles:

| The track asks | Kitty |
|---|---|
| Use the existing DAO or Trezu treasury for custody and approvals; no new multisig | Covers are ordinary Sputnik FunctionCall proposals, with descriptions in Trezu's `* Title: … <br>* Summary: …` form. The council's own vote installs Kitty, sets its terms, and approves large covers. |
| Reputation tied to named accounts, every point traceable | A member's record is keyed by their named account. Credit is computed from `earned`, which only grows when a circle finishes, and each entry (paid, missed, covered, took pot, repaid, circle finished) names its circle, round and block. |
| Tiers: small auto, mid one council member, large a normal proposal | Small covers pass with Kitty's own vote (its role's threshold is 1 of 1). Larger covers wait for the council's normal vote. Sputnik counts votes per role and proposal kind, not per amount, so Kitty enforces the limit in code: it only casts its vote when the cover is within `auto_cover_max`. A one-member tier would need a second Kitty role with its own threshold; it is not built. |
| A public board | The site shows open and finished circles, each seat's state and what they would receive in their turn, each DAO cover proposal with its votes, each member's record line by line, the DAO's book, and each circle's near.social thread. |

**Which approval flows already exist, and which Kitty adds.** Sputnik already has everything Kitty needs: roles holding specific accounts, per-role vote policies per proposal kind (`call` here), proposal bonds, and `act_proposal`, which runs a FunctionCall when it passes. Kitty adds no new approval flow to the DAO. It adds a role whose single member is the contract, and a rule in its own code: file only `receive_cover` calls to itself, for exactly the missing dues, and vote only on those, only up to the DAO's limit.

## Try it

You need Node.js 20 or later. Nothing below needs a key or a wallet.

1. `npm install`, then `node scripts/serve.mjs`, then open http://127.0.0.1:4173. **See** the board: "Banyan Co-op" with its treasury, and circles. Every number is read from testnet when the page draws.
2. Click the finished circle **December rent**. **See** four seats in payout order. The last column shows what each took: Priya's 0.4 NEAR bar is three-quarters gold (credit), Ama's 0.2 NEAR has a grey part (held back). **See** "Covers Banyan Co-op paid in this circle": proposal #5, Approved, filed by `v1.kitty-hq.testnet`, with Kitty's vote.
3. Scroll down. **See** the circle's near.social thread: 8 posts by the contract, each mentioning members by name (names come from their near.social profiles).
4. Click **Priya Raman**. **See** her record: credit 0.3 NEAR, one miss, every entry with its circle, round and block, including the cover and her repayment.
5. Click **Banyan Co-op** in the menu. **See** the terms the council voted for and Kitty's role, and every member's credit.
6. Run `node scripts/verify.mjs 3`. **See** the same facts checked against the chain and the near.social index, ending with "Everything checks out."
7. Read [docs/TESTNET.md](docs/TESTNET.md) for the live test runs: 35 checks, with a transaction link for each step, including a council-approved cover (proposal #4).

To act as the demo members (create a circle, pay, close rounds, repay) you need their keys: `node scripts/serve.mjs --demo` signs for them through a relay on 127.0.0.1 that only makes Kitty's own calls. Only the deployer has those keys; see "Run your own" below.

From the command line, any view call works with near CLI, for example:

```bash
near contract call-function as-read-only v1.kitty-hq.testnet get_circle json-args '{"circle_id":3}' network-config testnet now
```

## Run your own

1. Create a funded testnet account (`near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`).
2. Build the contract (below), then `KITTY_HQ=<name>.testnet node scripts/deploy.mjs`. It creates the contract account, six named members with near.social profiles, a Sputnik DAO with a three-person council, the role and terms proposals, and a warm-up circle. It needs about 15 test NEAR; `KITTY_FUNDERS` lists extra accounts to draw from.
3. `node scripts/serve.mjs --demo` and act as any member from the menu at the top right.
4. `node scripts/e2e.mjs` runs the live checks against your deployment.

To install Kitty on an existing Sputnik DAO, the council passes two proposals. The role:

```json
{ "ChangePolicyAddOrUpdateRole": { "role": {
  "name": "kitty", "kind": { "Group": ["v1.kitty-hq.testnet"] },
  "permissions": ["call:AddProposal", "call:VoteApprove"],
  "vote_policy": { "call": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1] } } } } }
```

and a FunctionCall to `v1.kitty-hq.testnet` `set_terms` with `{"terms": {...}}` (see `TERMS` in `scripts/deploy.mjs`). The contract keeps a little NEAR of its own to pay proposal bonds, which Sputnik returns when a proposal passes.

## Build and test

```bash
cd contract
cargo test
cargo build --release --target wasm32-unknown-unknown
```

`cargo test` runs 24 unit tests: the money rules (`src/rules.rs`, including a check that every split conserves money for all circle sizes and seats), the near.social texts (`src/social.rs`), and the contract's flows with a mocked DAO (`src/lib.rs`). `contract/.cargo/config.toml` sets `--cfg near`, which near-sdk needs when built with plain cargo. Copy `target/wasm32-unknown-unknown/release/kitty.wasm` to `contract/out/kitty.wasm` for `scripts/deploy.mjs`. On Windows the tests build with the MSVC toolchain (`cargo +stable-x86_64-pc-windows-msvc test`; set `AWS_LC_SYS_PREBUILT_NASM=1` if NASM is missing).

## Contract

| Method | Who | What |
|---|---|---|
| `set_terms(terms)` | the DAO, by proposal | Credit share, caps, auto-cover limit, largest dues, which roles may sit, cover wait |
| `create_circle(dao, name, dues, round_secs, members)` | a member, with a storage deposit | Reads the DAO's policy; every seat must be in the named roles |
| `join(circle_id)` | each member | When every seat is taken, round 1 starts |
| `pay(circle_id)` | a member, exactly the dues | Paying before the deadline counts toward their record |
| `close_round(circle_id)` | anyone, 300 Tgas | Uses holdbacks, files a cover if someone missed, pays the pot |
| `receive_cover(circle_id, round)` | only the circle's DAO, by proposal | Must carry exactly the missing dues, or it fails and the money stays in the treasury |
| `repay()` | a member who owes | Oldest debt first; covers go back to the DAO |
| `get_circle`, `get_record`, `get_dao`, `list_circles` | anyone | Views |

Contract events are NEP-297 logs (`EVENT_JSON:{"standard":"kitty",...}`).

## Limits and honest notes

- **Testnet only.** The contract account still has a full-access key, so it can be upgraded. On mainnet it should be locked (keys deleted) or governed, because a DAO's role trusts its code.
- **Kitty's role can pass any FunctionCall proposal it files.** Its code only files `receive_cover` to itself for exact missing dues; a DAO that stops trusting it removes the role with one vote. Covers above `auto_cover_max` always need the council.
- **Sybil resistance comes from DAO membership.** Only members of the DAO's named roles may sit in circles, and credit is capped per member and in total. A member who games their record can take at most their capped credit; the DAO chose that risk in its terms.
- **Debts are social, not legal.** A member who never repays keeps a zero credit and a public record of the debt; nothing else forces them.
- **If no cover comes** within `cover_wait_secs` (the council rejects it, or the treasury is empty), the round pays out short and the member who missed owes the recipient instead.
- **near.social** accepts 300 new posts per account per day. Kitty posts from one account and stops at 280 a day; the on-chain events still happen. On testnet the posts are read from the public FastData index (`kv.test.fastnear.com`), because the near.social site and its notifications run on mainnet.
- **Storage.** Records and entries are kept in full per account. A mainnet version should paginate entries.
- **No interest.** Like most savings circles, nobody pays or earns interest; the early taker's benefit is liquidity.

## Repository

| Path | What |
|---|---|
| `contract/` | The Rust contract (near-sdk 5.30): `src/lib.rs`, `src/rules.rs`, `src/social.rs` |
| `web/` | The site: static files reading NEAR and near.social's index from the browser |
| `scripts/deploy.mjs` | Stands up the whole demo on testnet |
| `scripts/serve.mjs` | Serves the site; `--demo` adds the signing relay for the demo members |
| `scripts/e2e.mjs` | The live checks; results in `deployments/testnet-e2e.json` |
| `scripts/verify.mjs` | Read-only proof of the deployment |
| `demo/` | The demo video and how it was made (`record.mjs`, `edit.py`, `voice.py`, `lines.json`) |
| `docs/TESTNET.md` | Evidence from the live runs |
| `docs/SUBMISSION.md` | Notes for submitting |

## Built with

All code in this repository was written during NEAR HACKATHON (November 2026). Nothing predates the hackathon window.

| What | Used for |
|---|---|
| [near-sdk](https://crates.io/crates/near-sdk) 5.30 (Rust) | The Kitty contract |
| [Sputnik DAO v2](https://github.com/near-daos/sputnik-dao-contract) on testnet (`sputnikv2.testnet` factory) | The community's treasury, roles and proposals; Kitty only calls it |
| near.social's data standard, written with `__fastdata_kv` to `social.testnet` and read from the public FastData index | Circle threads, mentions, member profile names |
| [near-api-js](https://www.npmjs.com/package/near-api-js) 7 | The deploy, test, verify and relay scripts |
| [playwright-core](https://www.npmjs.com/package/playwright-core) | Recording the demo video from the real site |
| [Chatterbox](https://github.com/resemble-ai/chatterbox) (open-source voice model), ffmpeg, Pillow, NumPy, faster-whisper | The demo video's narration, edit and narration check |

**AI-generated code.** The contract, site, scripts and documents were written with Claude Code (Anthropic), directed and reviewed by the author. The demo video's narration is an AI voice.

## What is new

Savings circles are centuries old; the new parts are how they meet a DAO and a social network on NEAR. A member's record of paid dues becomes credit that the community's own treasury stands behind, covered through the DAO's ordinary proposals with no new multisig; and each circle lives as a near.social thread, written by its contract, whose mentions tell members when their dues are due.
