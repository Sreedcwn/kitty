//! Kitty: rotating savings circles backed by a Sputnik DAO.
//!
//! A circle is a handful of members of one DAO. Each round every member pays the same dues
//! into a pot, and one member, in seat order, takes the whole pot. This is the oldest form of
//! community finance there is (a chit fund, tanda, susu, hui, kye or "kitty"), and its one
//! weakness is trust: whoever takes the pot early can stop paying.
//!
//! Kitty removes that risk from the circle and gives it, capped, to the community:
//!
//! - When a member takes the pot, their remaining dues are either held back from the pot
//!   (and pay their later rounds automatically) or backed by the DAO. How much the DAO backs
//!   is that member's record: a share of the dues they have paid themselves, on time, in this
//!   DAO's circles. See `rules.rs`.
//! - If someone does not pay, Kitty files an ordinary FunctionCall proposal on the DAO that
//!   sends exactly the missing dues to `receive_cover`. Small covers pass with Kitty's own vote
//!   in a role the council gave it; larger ones wait for the council like any proposal. The
//!   defaulter then owes the DAO, and their record shows it until they repay.
//!
//! What this contract does not do: it holds no DAO's money and has no multisig of its own.
//! The DAO's treasury and its votes stay where they are. The contract only holds the dues of
//! circles that are running.

pub mod rules;
pub mod social;

use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

const VERSION: &str = "1.0.0";

const GAS_GET_POLICY: Gas = Gas::from_tgas(10);
const GAS_ON_POLICY: Gas = Gas::from_tgas(30);
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(25);
/// Gas the DAO attaches to `receive_cover` when it runs the proposal.
const GAS_RECEIVE_COVER: Gas = Gas::from_tgas(60);
/// Sputnik's act_proposal, which runs the proposal (and so `receive_cover`) when it passes.
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(130);
const GAS_ON_VOTED: Gas = Gas::from_tgas(5);
const GAS_ON_FILED: Gas = Gas::from_tgas(12 + 130 + 5);

const MAX_SEATS: usize = 12;
const MIN_ROUND_SECS: u64 = 30;
const MAX_ROUND_SECS: u64 = 90 * 86_400;
const MAX_POLICY_BYTES: usize = 64 * 1024;
const MILLI_NEAR: u128 = 1_000_000_000_000_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Circles,
    Daos,
    DaoList,
    Stats,
    Entries,
    Debts,
}

/// What a DAO decides once, by an ordinary proposal that calls `set_terms`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Terms {
    /// Share of a member's self-paid, on-time dues that becomes credit, in basis points.
    pub backing_bps: u16,
    /// Most credit any one member can have.
    pub max_backing: U128,
    /// Most the DAO stands behind across all its circles at once.
    pub max_exposure: U128,
    /// Covers up to this pass with Kitty's own vote. Larger ones wait for the council.
    pub auto_cover_max: U128,
    /// Largest dues per round a circle of this DAO may use.
    pub max_dues: U128,
    /// The DAO roles whose members may sit in circles.
    pub member_roles: Vec<String>,
    /// How long a circle waits for a cover before it pays out short.
    pub cover_wait_secs: u64,
}

/// What a DAO's circles add up to.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Book {
    /// Dues still to come from members who already took a pot, beyond their holdback.
    pub exposure: U128,
    /// Owed to the DAO now, for covers not yet repaid.
    pub debts: U128,
    /// Every cover the DAO ever paid, and how many.
    pub covered: U128,
    pub covers: u32,
    /// Paid back to the DAO, from pots and by repayment.
    pub recovered: U128,
    /// Read from the DAO's policy when a circle is created.
    pub bond: U128,
    pub can_file: bool,
    pub solo: bool,
    pub role: Option<String>,
    pub circles: Vec<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct DaoState {
    pub terms: Option<Terms>,
    pub book: Book,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Forming,
    Running,
    AwaitingCover,
    Done,
    Cancelled,
}

/// A seat's dues for the current round.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Due {
    Owed,
    Paid,
    PaidLate,
    FromHoldback,
    Covered,
    Short,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Seat {
    pub account: AccountId,
    pub joined: bool,
    pub due: Due,
    /// Held back from this member's pot; pays their later rounds. Returned at the end.
    pub holdback: U128,
    /// The round in which this member took the pot, 0 before.
    pub took_round: u32,
    pub missed: u32,
    /// Rounds of this circle the member paid themselves, on time.
    pub paid_self: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Cover {
    pub round: u32,
    pub amount: U128,
    pub seats: Vec<u32>,
    pub proposal_id: Option<u64>,
    pub auto: bool,
    pub filed_ms: u64,
}

/// What happened when a round closed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RoundLog {
    pub round: u32,
    pub recipient: AccountId,
    pub pot: U128,
    pub recovered: U128,
    pub backed: U128,
    pub holdback: U128,
    pub paid: U128,
    pub covered: U128,
    pub cover_proposal: Option<u64>,
    pub short: U128,
    pub closed_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Circle {
    pub id: u64,
    pub dao: AccountId,
    pub name: String,
    pub creator: AccountId,
    pub dues: U128,
    pub round_secs: u64,
    pub seats: Vec<Seat>,
    pub status: Status,
    /// The current round, 1-based. 0 while forming.
    pub round: u32,
    pub deadline_ms: u64,
    pub pot: U128,
    pub cover: Option<Cover>,
    pub log: Vec<RoundLog>,
    pub exposure: U128,
    pub created_ms: u64,
    /// The near.social post that starts this circle's thread, 0 if none.
    pub thread: u64,
}

/// A member's record with one DAO. Every number comes from entries in their history.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Stats {
    /// Dues paid by the member themselves, before the round's deadline.
    pub self_paid: U128,
    /// The part of `self_paid` that was in circles the member finished without a miss.
    /// Credit is a share of this, so every unit of credit traces to a finished circle.
    pub earned: U128,
    pub rounds_paid: u32,
    pub rounds_late: u32,
    pub misses: u32,
    pub pots_taken: u32,
    pub circles_done: u32,
    /// Credit the DAO extended when this member took pots early.
    pub credit_used: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Entry {
    pub kind: String,
    pub dao: AccountId,
    pub circle: u64,
    pub round: u32,
    pub amount: U128,
    pub at_ms: u64,
    pub block: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Debt {
    pub creditor: AccountId,
    pub dao: AccountId,
    pub circle: u64,
    pub round: u32,
    pub amount: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Kitty {
    /// Only DAOs created by this factory can back circles, e.g. `sputnikv2.testnet`.
    factory: AccountId,
    circles: Vector<Circle>,
    daos: LookupMap<AccountId, DaoState>,
    dao_list: Vector<AccountId>,
    stats: LookupMap<(AccountId, AccountId), Stats>,
    entries: LookupMap<AccountId, Vec<Entry>>,
    debts: LookupMap<AccountId, Vec<Debt>>,
    /// Dues this contract holds for running circles: pots and holdbacks.
    held: u128,
    /// The near.social data account: `social` on mainnet, `social.testnet` on testnet.
    social: AccountId,
    last_post_id: u64,
    post_day: u64,
    posts_today: u32,
}

/// near.social takes 300 new posts per account per UTC day. Kitty stops a little before.
const DAILY_POSTS: u32 = 280;

fn now_ms() -> u64 {
    env::block_timestamp() / 1_000_000
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "kitty", "version": VERSION, "event": event, "data": [data] })));
}

fn near_str(yocto: u128) -> String {
    let milli = yocto / MILLI_NEAR;
    let s = format!("{}.{:03}", milli / 1000, milli % 1000);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    format!("{s} NEAR")
}

fn has_perm(perms: &[&str], kind: &str, action: &str) -> bool {
    perms.iter().any(|p| *p == format!("{kind}:{action}") || *p == format!("{kind}:*") || *p == format!("*:{action}") || *p == "*:*")
}

fn as_u128(v: &Value) -> Option<u128> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64().map(|x| x as u128),
        _ => None,
    }
}

/// Approve votes one role needs to pass a FunctionCall proposal, as Sputnik counts them.
fn approve_threshold(role: &Value, default_policy: &Value, group_size: u128) -> Option<u128> {
    let vp = role.get("vote_policy").and_then(|m| m.get("call")).unwrap_or(default_policy);
    if vp.get("weight_kind").and_then(Value::as_str) != Some("RoleWeight") {
        return None;
    }
    let quorum = vp.get("quorum").and_then(as_u128).unwrap_or(0);
    let weight = match vp.get("threshold")? {
        Value::Array(a) if a.len() == 2 => {
            let num = a[0].as_u64()? as u128;
            let den = a[1].as_u64()? as u128;
            if den == 0 {
                return None;
            }
            (num * group_size / den + 1).min(group_size)
        }
        other => as_u128(other)?.min(group_size),
    };
    Some(quorum.max(weight))
}

/// What Kitty needs from a DAO's `get_policy`.
pub struct PolicyFacts {
    pub members: Vec<String>,
    pub bond: u128,
    pub can_file: bool,
    pub can_vote: bool,
    pub solo: bool,
    pub role: Option<String>,
}

pub fn read_policy(json: &str, me: &str, member_roles: &[String]) -> Result<PolicyFacts, String> {
    let v: Value = serde_json::from_str(json).map_err(|_| "ERR_POLICY: not JSON".to_string())?;
    let roles = v.get("roles").and_then(Value::as_array).ok_or("ERR_POLICY: no roles")?;
    let default_policy = v.get("default_vote_policy").cloned().unwrap_or(Value::Null);
    let mut f = PolicyFacts {
        members: vec![],
        bond: v.get("proposal_bond").and_then(as_u128).ok_or("ERR_POLICY: no proposal_bond")?,
        can_file: false,
        can_vote: false,
        solo: false,
        role: None,
    };
    for role in roles {
        let name = role.get("name").and_then(Value::as_str).unwrap_or("");
        let Some(group) = role.get("kind").and_then(|k| k.get("Group")).and_then(Value::as_array) else { continue };
        let group: Vec<&str> = group.iter().filter_map(Value::as_str).collect();
        if member_roles.iter().any(|r| r == name) {
            f.members.extend(group.iter().map(|s| s.to_string()));
        }
        if group.contains(&me) {
            let perms: Vec<&str> = role.get("permissions").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            let add = has_perm(&perms, "call", "AddProposal");
            let vote = has_perm(&perms, "call", "VoteApprove");
            f.can_file |= add;
            if vote {
                f.can_vote = true;
                if approve_threshold(role, &default_policy, group.len() as u128) == Some(1) {
                    f.solo = true;
                }
            }
            if add && (f.role.is_none() || vote) {
                f.role = Some(name.to_string());
            }
        }
    }
    f.members.sort();
    f.members.dedup();
    Ok(f)
}

#[near]
impl Kitty {
    #[init]
    pub fn new(factory: AccountId, social: AccountId) -> Self {
        Promise::new(social.clone())
            .function_call("__fastdata_kv".to_string(), social::profile_args().to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_gas(1))
            .detach();
        Self {
            factory,
            circles: Vector::new(Key::Circles),
            daos: LookupMap::new(Key::Daos),
            dao_list: Vector::new(Key::DaoList),
            stats: LookupMap::new(Key::Stats),
            entries: LookupMap::new(Key::Entries),
            debts: LookupMap::new(Key::Debts),
            held: 0,
            social,
            last_post_id: 0,
            post_day: 0,
            posts_today: 0,
        }
    }

    // ------------------------------------------------------------------
    // The DAO's one decision
    // ------------------------------------------------------------------

    /// Called by the DAO itself, through an ordinary FunctionCall proposal its council passes.
    pub fn set_terms(&mut self, terms: Terms) {
        let dao = env::predecessor_account_id();
        require!(self.is_dao(&dao), "ERR_NOT_DAO: only a DAO made by the factory can set terms, through a proposal");
        require!(terms.backing_bps <= 10_000, "ERR_TERMS: backing_bps is at most 10000");
        require!(!terms.member_roles.is_empty() && terms.member_roles.len() <= 5, "ERR_TERMS: name 1 to 5 member roles");
        require!(terms.cover_wait_secs >= 60, "ERR_TERMS: cover_wait_secs is at least 60");
        require!(terms.max_dues.0 > 0, "ERR_TERMS: max_dues must be above zero");
        let mut st = self.daos.get(&dao).unwrap_or_else(|| {
            self.dao_list.push(&dao);
            DaoState { terms: None, book: Book::default() }
        });
        emit("terms_set", json!({ "dao": dao, "terms": terms }));
        st.terms = Some(terms);
        self.daos.insert(&dao, &st);
    }

    // ------------------------------------------------------------------
    // Forming a circle
    // ------------------------------------------------------------------

    /// Start a circle of the DAO's members. Seat order is payout order. The deposit pays for
    /// storage: 0.01 NEAR plus 0.005 NEAR per seat squared.
    #[payable]
    pub fn create_circle(&mut self, dao: AccountId, name: String, dues: U128, round_secs: u64, members: Vec<AccountId>) -> Promise {
        let creator = env::predecessor_account_id();
        let st = self.daos.get(&dao).unwrap_or_else(|| env::panic_str("ERR_NO_TERMS: this DAO has not set terms for Kitty"));
        let terms = st.terms.unwrap_or_else(|| env::panic_str("ERR_NO_TERMS: this DAO has not set terms for Kitty"));
        let n = members.len();
        require!((2..=MAX_SEATS).contains(&n), "ERR_SEATS: a circle has 2 to 12 seats");
        let mut sorted: Vec<&AccountId> = members.iter().collect();
        sorted.sort();
        sorted.dedup();
        require!(sorted.len() == n, "ERR_SEATS: each member sits once");
        require!(members.contains(&creator), "ERR_SEATS: the creator sits in the circle");
        require!(dues.0 > 0 && dues.0 <= terms.max_dues.0, "ERR_DUES: above zero and at most the DAO's max_dues");
        require!(!name.is_empty() && name.chars().count() <= 48, "ERR_NAME: 1 to 48 characters");
        require!((MIN_ROUND_SECS..=MAX_ROUND_SECS).contains(&round_secs), "ERR_ROUND: 30 seconds to 90 days");
        let fee = Self::storage_fee(n);
        require!(env::attached_deposit().as_yoctonear() >= fee, format!("ERR_DEPOSIT: attach {} for storage", near_str(fee)));
        Promise::new(dao.clone()).function_call("get_policy".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_GET_POLICY).then(
            Promise::new(env::current_account_id()).function_call(
                "on_circle_policy".to_string(),
                json!({ "creator": creator, "dao": dao, "name": name, "dues": dues, "round_secs": round_secs, "members": members, "deposit": U128(env::attached_deposit().as_yoctonear()) })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_ON_POLICY,
            ),
        )
    }

    #[private]
    pub fn on_circle_policy(&mut self, creator: AccountId, dao: AccountId, name: String, dues: U128, round_secs: u64, members: Vec<AccountId>, deposit: U128) -> Value {
        let refuse = |why: String| -> Value {
            Promise::new(creator.clone()).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            env::log_str(&why);
            json!({ "ok": false, "error": why })
        };
        let Ok(bytes) = env::promise_result_checked(0, MAX_POLICY_BYTES) else {
            return refuse("ERR_POLICY: the DAO's policy could not be read. Your deposit was returned.".into());
        };
        let mut st = self.daos.get(&dao).unwrap();
        let terms = st.terms.clone().unwrap();
        let facts = match read_policy(&String::from_utf8(bytes).unwrap_or_default(), env::current_account_id().as_str(), &terms.member_roles) {
            Ok(f) => f,
            Err(e) => return refuse(format!("{e}. Your deposit was returned.")),
        };
        let outsiders: Vec<String> = members.iter().filter(|m| !facts.members.contains(&m.to_string())).map(|m| m.to_string()).collect();
        if !outsiders.is_empty() {
            return refuse(format!(
                "ERR_NOT_MEMBER: {} not in the DAO's roles {}. Your deposit was returned.",
                outsiders.join(", "),
                terms.member_roles.join(", ")
            ));
        }
        st.book.bond = U128(facts.bond);
        st.book.can_file = facts.can_file;
        st.book.solo = facts.solo && facts.can_vote;
        st.book.role = facts.role;
        let id = self.circles.len();
        st.book.circles.push(id);
        self.daos.insert(&dao, &st);
        let seats = members
            .iter()
            .map(|m| Seat { account: m.clone(), joined: *m == creator, due: Due::Owed, holdback: U128(0), took_round: 0, missed: 0, paid_self: 0 })
            .collect();
        let mut c = Circle {
            id,
            dao: dao.clone(),
            name,
            creator: creator.clone(),
            dues,
            round_secs,
            seats,
            status: Status::Forming,
            round: 0,
            deadline_ms: 0,
            pot: U128(0),
            cover: None,
            log: vec![],
            exposure: U128(0),
            created_ms: now_ms(),
            thread: 0,
        };
        let names: Vec<String> = members.iter().map(|m| m.to_string()).collect();
        let text = social::opened(&social::Opened { name: &c.name, dao: dao.as_str(), members: &names, dues: dues.0, round_secs, circle: id });
        self.say(&mut c, text);
        self.circles.push(&c);
        emit("circle_created", json!({ "id": id, "dao": dao, "creator": creator, "members": members, "dues": dues }));
        json!({ "ok": true, "id": id })
    }

    /// Take your seat. When every seat is taken, round 1 starts.
    pub fn join(&mut self, circle_id: u64) {
        let me = env::predecessor_account_id();
        let mut c = self.circle(circle_id);
        require!(c.status == Status::Forming, "ERR_STATUS: this circle is not forming");
        let seat = c.seats.iter_mut().find(|s| s.account == me).unwrap_or_else(|| env::panic_str("ERR_NO_SEAT: you have no seat in this circle"));
        require!(!seat.joined, "ERR_JOINED: you already joined");
        seat.joined = true;
        emit("joined", json!({ "circle": circle_id, "account": me }));
        if c.seats.iter().all(|s| s.joined) {
            c.status = Status::Running;
            c.round = 1;
            c.deadline_ms = now_ms() + c.round_secs * 1000;
            emit("round_started", json!({ "circle": circle_id, "round": 1, "deadline_ms": c.deadline_ms }));
            let text = social::started(&Self::due(&c));
            self.say(&mut c, text);
        }
        self.circles.replace(circle_id, &c);
    }

    /// The creator can call off a circle that has not started.
    pub fn cancel(&mut self, circle_id: u64) {
        let mut c = self.circle(circle_id);
        require!(env::predecessor_account_id() == c.creator, "ERR_NOT_CREATOR");
        require!(c.status == Status::Forming, "ERR_STATUS: only a forming circle can be cancelled");
        c.status = Status::Cancelled;
        self.circles.replace(circle_id, &c);
        emit("cancelled", json!({ "circle": circle_id }));
    }

    // ------------------------------------------------------------------
    // Paying dues
    // ------------------------------------------------------------------

    /// Pay this round's dues. Attach exactly the circle's dues.
    #[payable]
    pub fn pay(&mut self, circle_id: u64) {
        let me = env::predecessor_account_id();
        let mut c = self.circle(circle_id);
        require!(c.status == Status::Running, "ERR_STATUS: this circle is not collecting dues right now");
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount == c.dues.0, format!("ERR_AMOUNT: attach exactly {}", near_str(c.dues.0)));
        let on_time = now_ms() <= c.deadline_ms;
        let round = c.round;
        let dao = c.dao.clone();
        let seat = c.seats.iter_mut().find(|s| s.account == me).unwrap_or_else(|| env::panic_str("ERR_NO_SEAT: you have no seat in this circle"));
        require!(seat.due == Due::Owed, "ERR_PAID: this round is already settled for you");
        seat.due = if on_time { Due::Paid } else { Due::PaidLate };
        if on_time {
            seat.paid_self += 1;
        }
        c.pot = U128(c.pot.0 + amount);
        self.held += amount;
        self.circles.replace(circle_id, &c);
        let mut s = self.stats_of(&me, &dao);
        if on_time {
            s.self_paid = U128(s.self_paid.0 + amount);
            s.rounds_paid += 1;
        } else {
            s.rounds_late += 1;
        }
        self.stats.insert(&(me.clone(), dao.clone()), &s);
        self.note(&me, if on_time { "paid" } else { "paid_late" }, &dao, circle_id, round, amount);
        emit("paid", json!({ "circle": circle_id, "round": round, "account": me, "amount": U128(amount), "on_time": on_time }));
    }

    // ------------------------------------------------------------------
    // Closing a round
    // ------------------------------------------------------------------

    /// Anyone can close a round once everyone has paid or the deadline has passed. Missing
    /// dues come from the member's holdback if they have one; otherwise Kitty asks the DAO to
    /// cover them. Attach 300 Tgas: a cover files a proposal and may vote on it.
    pub fn close_round(&mut self, circle_id: u64) -> PromiseOrValue<Value> {
        let mut c = self.circle(circle_id);
        let st = self.daos.get(&c.dao).unwrap();
        let terms = st.terms.clone().unwrap();
        match c.status {
            Status::Running => {}
            Status::AwaitingCover => {
                let cover = c.cover.clone().unwrap();
                if now_ms() >= cover.filed_ms + terms.cover_wait_secs * 1000 {
                    return PromiseOrValue::Value(self.settle_short(&mut c));
                }
                if cover.proposal_id.is_none() && st.book.can_file {
                    return PromiseOrValue::Promise(self.file_cover(&c, &st.book, &terms));
                }
                env::panic_str(&format!(
                    "ERR_WAITING: waiting for the DAO to pass cover proposal {}. After {}s it pays out short.",
                    cover.proposal_id.map(|i| format!("#{i}")).unwrap_or_default(),
                    terms.cover_wait_secs
                ));
            }
            _ => env::panic_str("ERR_STATUS: this circle has no open round"),
        }
        let dues = c.dues.0;
        let past = now_ms() > c.deadline_ms;
        let settled = |s: &Seat| s.due != Due::Owed || s.holdback.0 >= dues;
        require!(past || c.seats.iter().all(settled), "ERR_TOO_EARLY: someone has not paid and the round is still open");
        let round = c.round;
        let dao = c.dao.clone();
        let mut missing: Vec<u32> = vec![];
        for i in 0..c.seats.len() {
            if c.seats[i].due != Due::Owed {
                continue;
            }
            if c.seats[i].holdback.0 >= dues {
                // Prepaid: this member's own holdback pays. It is already in `held`.
                c.seats[i].holdback = U128(c.seats[i].holdback.0 - dues);
                c.seats[i].due = Due::FromHoldback;
                c.pot = U128(c.pot.0 + dues);
                let who = c.seats[i].account.clone();
                self.note(&who, "paid_from_holdback", &dao, circle_id, round, dues);
            } else {
                missing.push(i as u32);
            }
        }
        if missing.is_empty() {
            let out = self.payout(&mut c, 0, None, 0);
            return PromiseOrValue::Value(out);
        }
        for &i in &missing {
            let seat = &mut c.seats[i as usize];
            seat.missed += 1;
            let who = seat.account.clone();
            let mut s = self.stats_of(&who, &dao);
            s.misses += 1;
            self.stats.insert(&(who.clone(), dao.clone()), &s);
            self.note(&who, "missed", &dao, circle_id, round, dues);
        }
        let amount = dues * missing.len() as u128;
        let auto = rules::auto_cover(amount, terms.auto_cover_max.0, st.book.solo);
        c.cover = Some(Cover { round, amount: U128(amount), seats: missing.clone(), proposal_id: None, auto, filed_ms: now_ms() });
        c.status = Status::AwaitingCover;
        self.circles.replace(circle_id, &c);
        emit("cover_needed", json!({ "circle": circle_id, "round": round, "amount": U128(amount), "auto": auto, "missing": missing.iter().map(|&i| c.seats[i as usize].account.clone()).collect::<Vec<_>>() }));
        if !st.book.can_file {
            env::log_str("The DAO has not given Kitty a role that can file proposals. The round will pay out short after the cover wait.");
            return PromiseOrValue::Value(json!({ "status": "AwaitingCover", "filed": false }));
        }
        PromiseOrValue::Promise(self.file_cover(&c, &st.book, &terms))
    }

    /// The DAO pays a cover. Runs only as the DAO's own FunctionCall proposal, with exactly
    /// the amount Kitty asked for. Anything else fails, so the money stays in the treasury.
    #[payable]
    pub fn receive_cover(&mut self, circle_id: u64, round: u32) -> Value {
        let mut c = self.circle(circle_id);
        require!(env::predecessor_account_id() == c.dao, "ERR_NOT_DAO: covers come from the circle's DAO");
        require!(c.status == Status::AwaitingCover, "ERR_STATUS: this circle is not waiting for a cover");
        let cover = c.cover.clone().unwrap();
        require!(cover.round == round && c.round == round, "ERR_ROUND: this cover is for another round");
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount == cover.amount.0, "ERR_AMOUNT: a cover must be exactly what was asked");
        let dao = c.dao.clone();
        let dues = c.dues.0;
        for &i in &cover.seats {
            let seat = &mut c.seats[i as usize];
            seat.due = Due::Covered;
            let who = seat.account.clone();
            self.add_debt(&who, Debt { creditor: dao.clone(), dao: dao.clone(), circle: circle_id, round, amount: U128(dues) });
            self.note(&who, "covered_by_dao", &dao, circle_id, round, dues);
        }
        let mut st = self.daos.get(&dao).unwrap();
        st.book.debts = U128(st.book.debts.0 + amount);
        st.book.covered = U128(st.book.covered.0 + amount);
        st.book.covers += 1;
        self.daos.insert(&dao, &st);
        c.pot = U128(c.pot.0 + amount);
        self.held += amount;
        emit("covered", json!({ "circle": circle_id, "round": round, "amount": U128(amount), "proposal_id": cover.proposal_id }));
        self.payout(&mut c, amount, cover.proposal_id, 0)
    }

    #[private]
    pub fn on_cover_filed(&mut self, circle_id: u64, round: u32) -> PromiseOrValue<Value> {
        let mut c = self.circle(circle_id);
        let id: Option<u64> = env::promise_result_checked(0, 64).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let Some(id) = id else {
            env::log_str("The DAO did not take the cover proposal. close_round will try again.");
            return PromiseOrValue::Value(json!({ "filed": false }));
        };
        if c.status != Status::AwaitingCover || c.round != round {
            return PromiseOrValue::Value(json!({ "filed": true, "proposal_id": id }));
        }
        let mut cover = c.cover.clone().unwrap();
        cover.proposal_id = Some(id);
        c.cover = Some(cover.clone());
        let missing: Vec<String> = cover.seats.iter().map(|&i| c.seats[i as usize].account.to_string()).collect();
        let text = social::cover_asked(&missing, round, c.dao.as_str(), cover.amount.0, id, cover.auto);
        self.say(&mut c, text);
        self.circles.replace(circle_id, &c);
        emit("cover_filed", json!({ "circle": circle_id, "round": round, "proposal_id": id, "amount": cover.amount, "auto": cover.auto }));
        if !cover.auto {
            return PromiseOrValue::Value(json!({ "filed": true, "proposal_id": id, "waits_for": "council" }));
        }
        let kind = self.cover_kind(circle_id, round, cover.amount.0);
        PromiseOrValue::Promise(
            Promise::new(c.dao.clone())
                .function_call(
                    "act_proposal".to_string(),
                    json!({ "id": id, "action": "VoteApprove", "proposal": kind }).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_ACT_PROPOSAL,
                )
                .then(Promise::new(env::current_account_id()).function_call(
                    "on_cover_voted".to_string(),
                    json!({ "circle_id": circle_id, "proposal_id": id }).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_ON_VOTED,
                )),
        )
    }

    #[private]
    pub fn on_cover_voted(&mut self, circle_id: u64, proposal_id: u64) -> Value {
        let voted = near_sdk::is_promise_success();
        let c = self.circle(circle_id);
        json!({ "proposal_id": proposal_id, "voted": voted, "status": c.status })
    }

    // ------------------------------------------------------------------
    // Debts
    // ------------------------------------------------------------------

    /// Repay what you owe, oldest debt first. Covers go back to the DAO's treasury.
    #[payable]
    pub fn repay(&mut self) -> U128 {
        let me = env::predecessor_account_id();
        let mut left = env::attached_deposit().as_yoctonear();
        let mut debts = self.debts.get(&me).unwrap_or_default();
        require!(!debts.is_empty(), "ERR_NO_DEBT: you owe nothing");
        let mut kept = vec![];
        let mut posts: Vec<(u64, AccountId, u32, u128)> = vec![];
        let mut repaid = 0u128;
        for mut d in debts.drain(..) {
            if left == 0 {
                kept.push(d);
                continue;
            }
            let part = left.min(d.amount.0);
            left -= part;
            repaid += part;
            d.amount = U128(d.amount.0 - part);
            Promise::new(d.creditor.clone()).transfer(NearToken::from_yoctonear(part)).detach();
            if d.creditor == d.dao {
                let mut st = self.daos.get(&d.dao).unwrap();
                st.book.debts = U128(st.book.debts.0.saturating_sub(part));
                st.book.recovered = U128(st.book.recovered.0 + part);
                self.daos.insert(&d.dao, &st);
            }
            self.note(&me, "repaid", &d.dao, d.circle, d.round, part);
            posts.push((d.circle, d.creditor.clone(), d.round, part));
            if d.amount.0 > 0 {
                kept.push(d);
            }
        }
        let clear = kept.is_empty();
        self.set_debts(&me, kept);
        let last = posts.len();
        for (i, (circle, to, round, part)) in posts.into_iter().enumerate() {
            if let Some(mut c) = self.circles.get(circle) {
                let text = social::repaid(me.as_str(), part, to.as_str(), round, clear && i + 1 == last);
                self.say(&mut c, text);
                self.circles.replace(circle, &c);
            }
        }
        if left > 0 {
            Promise::new(me.clone()).transfer(NearToken::from_yoctonear(left)).detach();
        }
        emit("repaid", json!({ "account": me, "amount": U128(repaid) }));
        U128(repaid)
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn version(&self) -> String {
        VERSION.to_string()
    }

    pub fn factory(&self) -> AccountId {
        self.factory.clone()
    }

    pub fn held(&self) -> U128 {
        U128(self.held)
    }

    pub fn storage_fee_for(&self, seats: u32) -> U128 {
        U128(Self::storage_fee(seats as usize))
    }

    pub fn list_daos(&self) -> Vec<AccountId> {
        self.dao_list.to_vec()
    }

    pub fn get_dao(&self, dao: AccountId) -> Option<DaoState> {
        self.daos.get(&dao)
    }

    pub fn circle_count(&self) -> u64 {
        self.circles.len()
    }

    pub fn list_circles(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Circle> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.circles.len().min(from + limit)).filter_map(|i| self.circles.get(i)).collect()
    }

    /// A circle, with what each seat that has not taken the pot would receive in its turn,
    /// given that member's record today.
    pub fn get_circle(&self, circle_id: u64) -> Value {
        let c = self.circle(circle_id);
        let st = self.daos.get(&c.dao).unwrap();
        let terms = st.terms.clone().unwrap();
        let n = c.seats.len() as u32;
        let room = terms.max_exposure.0.saturating_sub(st.book.exposure.0);
        let quotes: Vec<Value> = c
            .seats
            .iter()
            .enumerate()
            .map(|(i, s)| {
                if s.took_round > 0 {
                    return Value::Null;
                }
                let (back, debt_dao) = self.credit(&s.account, &c.dao, &terms);
                let sp = rules::split(c.dues.0 * n as u128, c.dues.0, n, i as u32 + 1, debt_dao, back, room, s.missed > 0);
                json!({ "credit": U128(back), "recover": U128(sp.recover), "backed": U128(sp.backed), "holdback": U128(sp.holdback), "pay": U128(sp.pay) })
            })
            .collect();
        json!({ "circle": c, "quotes": quotes, "now_ms": now_ms(), "terms": terms, "book": st.book })
    }

    /// Everything Kitty knows about an account: its record with each DAO, every entry that
    /// record is made of, what it owes, and the credit it has today.
    pub fn get_record(&self, account: AccountId) -> Value {
        let entries = self.entries.get(&account).unwrap_or_default();
        let debts = self.debts.get(&account).unwrap_or_default();
        let mut daos: Vec<AccountId> = entries.iter().map(|e| e.dao.clone()).collect();
        daos.sort();
        daos.dedup();
        let with: Vec<Value> = daos
            .iter()
            .map(|d| {
                let s = self.stats_of(&account, d);
                let credit = self.daos.get(d).and_then(|st| st.terms).map(|t| self.credit(&account, d, &t).0).unwrap_or(0);
                json!({ "dao": d, "stats": s, "credit": U128(credit) })
            })
            .collect();
        json!({ "account": account, "daos": with, "entries": entries, "debts": debts })
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// Post to this circle's near.social thread as the Kitty contract. The first post of a
    /// circle starts its thread; every later one is a reply to it. Nothing waits for the write.
    fn say(&mut self, c: &mut Circle, text: String) {
        let day = now_ms() / 86_400_000;
        if day != self.post_day {
            self.post_day = day;
            self.posts_today = 0;
        }
        if self.posts_today >= DAILY_POSTS {
            return;
        }
        self.posts_today += 1;
        let id = now_ms().max(self.last_post_id + 1);
        self.last_post_id = id;
        let root = if c.thread == 0 { None } else { Some(c.thread) };
        let args = social::post_args(env::current_account_id().as_str(), id, &text, root);
        if c.thread == 0 {
            c.thread = id;
        }
        Promise::new(self.social.clone())
            .function_call("__fastdata_kv".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_gas(1))
            .detach();
        emit("posted", json!({ "circle": c.id, "post_id": id, "thread": c.thread }));
    }

    /// Who pays in the circle's open round, and who takes its pot.
    fn due(c: &Circle) -> social::Due {
        let dues = c.dues.0;
        social::Due {
            round: c.round,
            rounds: c.seats.len() as u32,
            payers: c.seats.iter().filter(|s| s.holdback.0 < dues).map(|s| s.account.to_string()).collect(),
            from_holdback: c.seats.iter().filter(|s| s.holdback.0 >= dues).map(|s| s.account.to_string()).collect(),
            dues,
            deadline_ms: c.deadline_ms,
            taker: c.seats[(c.round - 1) as usize].account.to_string(),
        }
    }

    fn storage_fee(seats: usize) -> u128 {
        10 * MILLI_NEAR + 5 * MILLI_NEAR * (seats * seats) as u128
    }

    fn is_dao(&self, account: &AccountId) -> bool {
        account.as_str().ends_with(&format!(".{}", self.factory))
    }

    fn circle(&self, id: u64) -> Circle {
        self.circles.get(id).unwrap_or_else(|| env::panic_str("ERR_NO_CIRCLE"))
    }

    fn stats_of(&self, account: &AccountId, dao: &AccountId) -> Stats {
        self.stats.get(&(account.clone(), dao.clone())).unwrap_or_default()
    }

    fn note(&mut self, account: &AccountId, kind: &str, dao: &AccountId, circle: u64, round: u32, amount: u128) {
        let mut v = self.entries.get(account).unwrap_or_default();
        v.push(Entry { kind: kind.to_string(), dao: dao.clone(), circle, round, amount: U128(amount), at_ms: now_ms(), block: env::block_height() });
        self.entries.insert(account, &v);
    }

    fn add_debt(&mut self, account: &AccountId, d: Debt) {
        let mut v = self.debts.get(account).unwrap_or_default();
        v.push(d);
        self.debts.insert(account, &v);
    }

    fn set_debts(&mut self, account: &AccountId, v: Vec<Debt>) {
        if v.is_empty() {
            self.debts.remove(account);
        } else {
            self.debts.insert(account, &v);
        }
    }

    /// (credit with this DAO today, what the account owes this DAO)
    fn credit(&self, account: &AccountId, dao: &AccountId, terms: &Terms) -> (u128, u128) {
        let debts = self.debts.get(account).unwrap_or_default();
        let to_dao: u128 = debts.iter().filter(|d| d.creditor == *dao).map(|d| d.amount.0).sum();
        let s = self.stats_of(account, dao);
        (rules::backing(s.earned.0, terms.backing_bps, terms.max_backing.0, !debts.is_empty()), to_dao)
    }

    fn cover_kind(&self, circle_id: u64, round: u32, amount: u128) -> Value {
        let args = json!({ "circle_id": circle_id, "round": round }).to_string().into_bytes();
        json!({
            "FunctionCall": {
                "receiver_id": env::current_account_id(),
                "actions": [{
                    "method_name": "receive_cover",
                    "args": Base64VecU8::from(args),
                    "deposit": amount.to_string(),
                    "gas": GAS_RECEIVE_COVER.as_gas().to_string(),
                }]
            }
        })
    }

    fn file_cover(&self, c: &Circle, book: &Book, _terms: &Terms) -> Promise {
        // Too little gas could file the proposal and lose its number, and a retry would file
        // it twice. Refusing here undoes the whole call.
        require!(env::prepaid_gas() >= Gas::from_tgas(250), "ERR_GAS: attach 300 Tgas, a cover files a DAO proposal and votes on it");
        let cover = c.cover.clone().unwrap();
        let names: Vec<String> = cover.seats.iter().map(|&i| c.seats[i as usize].account.to_string()).collect();
        let description = format!(
            "* Title: Kitty cover: {} for \"{}\" round {} <br>* Summary: {} did not pay round {} of circle #{}. This sends exactly the missing dues to the circle so its pot pays out in full. Each of them now owes the DAO their share, shown on their Kitty record until repaid. {}",
            near_str(cover.amount.0),
            c.name,
            cover.round,
            names.join(", "),
            cover.round,
            c.id,
            if cover.auto { "Small enough for Kitty's own vote under the DAO's terms." } else { "Above the DAO's auto-cover limit, so it needs the council." }
        );
        let kind = self.cover_kind(c.id, cover.round, cover.amount.0);
        Promise::new(c.dao.clone())
            .function_call(
                "add_proposal".to_string(),
                json!({ "proposal": { "description": description, "kind": kind } }).to_string().into_bytes(),
                NearToken::from_yoctonear(book.bond.0),
                GAS_ADD_PROPOSAL,
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_cover_filed".to_string(),
                json!({ "circle_id": c.id, "round": cover.round }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_ON_FILED,
            ))
    }

    /// The DAO did not cover in time: pay out what the pot holds. Each member who missed
    /// owes their dues to this round's recipient instead.
    fn settle_short(&mut self, c: &mut Circle) -> Value {
        let cover = c.cover.clone().unwrap();
        let round = c.round;
        let recipient = c.seats[(round - 1) as usize].account.clone();
        let dao = c.dao.clone();
        let dues = c.dues.0;
        let mut short = 0u128;
        for &i in &cover.seats {
            let seat = &mut c.seats[i as usize];
            seat.due = Due::Short;
            short += dues;
            let who = seat.account.clone();
            if who != recipient {
                self.add_debt(&who, Debt { creditor: recipient.clone(), dao: dao.clone(), circle: c.id, round, amount: U128(dues) });
            }
        }
        emit("paid_short", json!({ "circle": c.id, "round": round, "short": U128(short) }));
        self.payout(c, 0, cover.proposal_id, short)
    }

    /// Pay this round's pot to the member in its seat, then move to the next round.
    fn payout(&mut self, c: &mut Circle, covered: u128, cover_proposal: Option<u64>, short: u128) -> Value {
        let n = c.seats.len() as u32;
        let k = c.round;
        let idx = (k - 1) as usize;
        let dao = c.dao.clone();
        let mut st = self.daos.get(&dao).unwrap();
        let terms = st.terms.clone().unwrap();
        let who = c.seats[idx].account.clone();
        let pot = c.pot.0;

        // Repay covers the DAO made for this member's own misses, from their pot first.
        let (_, owed_dao) = self.credit(&who, &dao, &terms);
        let recover = owed_dao.min(pot);
        if recover > 0 {
            let mut left = recover;
            let mut kept = vec![];
            for mut d in self.debts.get(&who).unwrap_or_default() {
                if d.creditor == dao && left > 0 {
                    let part = left.min(d.amount.0);
                    left -= part;
                    d.amount = U128(d.amount.0 - part);
                }
                if d.amount.0 > 0 {
                    kept.push(d);
                }
            }
            self.set_debts(&who, kept);
            st.book.debts = U128(st.book.debts.0.saturating_sub(recover));
            st.book.recovered = U128(st.book.recovered.0 + recover);
            Promise::new(dao.clone()).transfer(NearToken::from_yoctonear(recover)).detach();
            self.note(&who, "repaid_from_pot", &dao, c.id, k, recover);
        }
        let (credit, _) = self.credit(&who, &dao, &terms);
        let room = terms.max_exposure.0.saturating_sub(st.book.exposure.0);
        let sp = rules::split(pot, c.dues.0, n, k, recover, credit, room, c.seats[idx].missed > 0);

        let seat = &mut c.seats[idx];
        seat.holdback = U128(seat.holdback.0 + sp.holdback);
        seat.took_round = k;
        if sp.pay > 0 {
            Promise::new(who.clone()).transfer(NearToken::from_yoctonear(sp.pay)).detach();
        }
        self.held -= sp.recover + sp.pay;
        let mut s = self.stats_of(&who, &dao);
        s.pots_taken += 1;
        s.credit_used = U128(s.credit_used.0 + sp.backed);
        self.stats.insert(&(who.clone(), dao.clone()), &s);
        self.note(&who, "took_pot", &dao, c.id, k, sp.pay);
        c.log.push(RoundLog {
            round: k,
            recipient: who.clone(),
            pot: U128(pot),
            recovered: U128(sp.recover),
            backed: U128(sp.backed),
            holdback: U128(sp.holdback),
            paid: U128(sp.pay),
            covered: U128(covered),
            cover_proposal,
            short: U128(short),
            closed_ms: now_ms(),
        });
        emit(
            "pot_paid",
            json!({ "circle": c.id, "round": k, "to": who, "paid": U128(sp.pay), "backed": U128(sp.backed), "holdback": U128(sp.holdback), "recovered": U128(sp.recover) }),
        );

        let covered_for: Vec<String> = c.seats.iter().filter(|s| s.due == Due::Covered).map(|s| s.account.to_string()).collect();
        let short_for: Vec<String> = c.seats.iter().filter(|s| s.due == Due::Short && s.account != who).map(|s| s.account.to_string()).collect();
        let closing = social::Paid {
            round: k,
            to: who.as_str(),
            dao: dao.as_str(),
            paid: sp.pay,
            backed: sp.backed,
            holdback: sp.holdback,
            recovered: sp.recover,
            covered,
            cover_proposal: if covered > 0 { cover_proposal } else { None },
            covered_for: &covered_for,
            short,
            short_for: &short_for,
        };
        let mut earned_list: Vec<(String, u128)> = vec![];
        let mut missed_list: Vec<String> = vec![];

        c.pot = U128(0);
        c.cover = None;
        c.round += 1;
        for seat in c.seats.iter_mut() {
            seat.due = Due::Owed;
        }
        if c.round > n {
            c.status = Status::Done;
            for i in 0..c.seats.len() {
                let back = c.seats[i].holdback.0;
                let acct = c.seats[i].account.clone();
                if back > 0 {
                    c.seats[i].holdback = U128(0);
                    self.held -= back;
                    Promise::new(acct.clone()).transfer(NearToken::from_yoctonear(back)).detach();
                    self.note(&acct, "holdback_returned", &dao, c.id, n, back);
                }
                let mut s = self.stats_of(&acct, &dao);
                if c.seats[i].missed == 0 {
                    s.circles_done += 1;
                    let earned = c.dues.0 * c.seats[i].paid_self as u128;
                    s.earned = U128(s.earned.0 + earned);
                    self.note(&acct, "circle_finished", &dao, c.id, n, earned);
                    earned_list.push((acct.to_string(), earned));
                } else {
                    missed_list.push(acct.to_string());
                }
                self.stats.insert(&(acct.clone(), dao.clone()), &s);
            }
            emit("circle_done", json!({ "circle": c.id }));
        } else {
            c.status = Status::Running;
            c.deadline_ms = now_ms() + c.round_secs * 1000;
            emit("round_started", json!({ "circle": c.id, "round": c.round, "deadline_ms": c.deadline_ms }));
        }

        // The DAO's exposure on this circle: dues still to come from members who took a pot,
        // beyond their holdback.
        let rounds_left = if c.status == Status::Done { 0 } else { n + 1 - c.round };
        let exposure: u128 = c.seats.iter().filter(|s| s.took_round > 0).map(|s| rules::seat_exposure(c.dues.0, rounds_left, s.holdback.0)).sum();
        st.book.exposure = U128(st.book.exposure.0.saturating_sub(c.exposure.0) + exposure);
        c.exposure = U128(exposure);
        self.daos.insert(&dao, &st);
        let text = if c.status == Status::Done {
            social::paid(&closing, None, Some(social::done(&earned_list, &missed_list)))
        } else {
            social::paid(&closing, Some(social::due_line(&Self::due(c))), None)
        };
        self.say(c, text);
        self.circles.replace(c.id, c);
        json!({ "round": k, "to": who, "paid": U128(sp.pay), "backed": U128(sp.backed), "holdback": U128(sp.holdback), "recovered": U128(sp.recover), "status": c.status })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const N: u128 = 1_000_000_000_000_000_000_000_000;
    fn a(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    const DAO: &str = "banyan.sputnikv2.testnet";
    const ME: &str = "kitty.testnet";

    fn ctx(pred: &str, deposit: u128, ts_ms: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(a(ME)).predecessor_account_id(a(pred)).attached_deposit(NearToken::from_yoctonear(deposit)).block_timestamp(ts_ms * 1_000_000).account_balance(NearToken::from_near(100));
        testing_env!(b.build());
    }

    fn terms() -> Terms {
        Terms {
            backing_bps: 10_000,
            max_backing: U128(N),
            max_exposure: U128(2 * N),
            auto_cover_max: U128(N / 2),
            max_dues: U128(N),
            member_roles: vec!["council".into(), "members".into()],
            cover_wait_secs: 600,
        }
    }

    fn policy() -> String {
        json!({
            "roles": [
                {"name":"council","kind":{"Group":["priya.t","tomas.t"]},"permissions":["*:*"],"vote_policy":{}},
                {"name":"members","kind":{"Group":["ama.t","lin.t"]},"permissions":[],"vote_policy":{}},
                {"name":"kitty","kind":{"Group":[ME]},"permissions":["call:AddProposal","call:VoteApprove"],
                 "vote_policy":{"call":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,1]}}}
            ],
            "default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,2]},
            "proposal_bond":"10000000000000000000000"
        })
        .to_string()
    }

    fn setup(members: &[&str], dues: u128) -> Kitty {
        ctx(DAO, 0, 1_000);
        let mut k = Kitty::new(a("sputnikv2.testnet"), a("social.testnet"));
        k.set_terms(terms());
        // Simulate create_circle's callback with the policy as the promise result.
        let mut b = VMContextBuilder::new();
        b.current_account_id(a(ME)).predecessor_account_id(a(ME)).block_timestamp(1_000_000_000).account_balance(NearToken::from_near(100));
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Successful(policy().into_bytes())]
        );
        let out = k.on_circle_policy(a(members[0]), a(DAO), "Rent".into(), U128(dues), 60, members.iter().map(|m| a(m)).collect(), U128(N / 10));
        assert_eq!(out["ok"], true, "{out}");
        for m in &members[1..] {
            ctx(m, 0, 2_000);
            k.join(0);
        }
        k
    }

    fn pay_all(k: &mut Kitty, who: &[&str], dues: u128, ts: u64) {
        for m in who {
            ctx(m, dues, ts);
            k.pay(0);
        }
    }

    fn close(k: &mut Kitty, ts: u64) -> Value {
        ctx("anyone.t", 0, ts);
        match k.close_round(0) {
            PromiseOrValue::Value(v) => v,
            PromiseOrValue::Promise(_) => json!({ "promise": true }),
        }
    }

    #[test]
    fn outsiders_cannot_sit() {
        ctx(DAO, 0, 1_000);
        let mut k = Kitty::new(a("sputnikv2.testnet"), a("social.testnet"));
        k.set_terms(terms());
        let mut b = VMContextBuilder::new();
        b.current_account_id(a(ME)).predecessor_account_id(a(ME));
        testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![near_sdk::PromiseResult::Successful(policy().into_bytes())]);
        let out = k.on_circle_policy(a("priya.t"), a(DAO), "x".into(), U128(1), 60, vec![a("priya.t"), a("mallory.t")], U128(N / 10));
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().contains("mallory.t"));
        assert_eq!(k.circle_count(), 0);
    }

    #[test]
    fn only_a_factory_dao_sets_terms() {
        ctx("fake.testnet", 0, 1_000);
        let mut k = Kitty::new(a("sputnikv2.testnet"), a("social.testnet"));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.set_terms(terms())));
        assert!(r.is_err());
    }

    #[test]
    fn a_full_circle_with_no_record_pays_everyone_back_exactly() {
        let m = ["priya.t", "tomas.t", "ama.t", "lin.t"];
        let d = N / 10;
        let mut k = setup(&m, d);
        let mut ts = 3_000;
        for round in 1..=4u32 {
            // Members with a holdback do not pay; it pays for them.
            let c = k.circle(0);
            let payers: Vec<&str> = m.iter().copied().filter(|x| c.seats.iter().find(|s| s.account.as_str() == *x).unwrap().holdback.0 < d).collect();
            pay_all(&mut k, &payers, d, ts);
            let v = close(&mut k, ts + 1);
            assert_eq!(v["round"], round, "{v}");
            ts += 10;
        }
        let c = k.circle(0);
        assert_eq!(c.status, Status::Done);
        assert_eq!(k.held, 0);
        // Round 1: priya had no record yet, so 3 rounds held back, paid 0.1.
        assert_eq!(c.log[0].paid.0, d);
        assert_eq!(c.log[0].holdback.0, 3 * d);
        // Round 4: last seat gets the full pot.
        assert_eq!(c.log[3].paid.0, 4 * d);
        // Credit comes from the finished circle: priya paid one round herself (the rest came
        // from her holdback), lin paid all four.
        let earned = |who: &str| k.stats_of(&a(who), &a(DAO)).earned.0;
        assert_eq!(earned("priya.t"), d);
        assert_eq!(earned("lin.t"), 4 * d);
        assert_eq!(k.credit(&a("lin.t"), &a(DAO), &terms()).0, 4 * d);
        // Every event went to near.social as one thread: a root and replies to it.
        assert!(k.circle(0).thread > 0);
        assert!(k.posts_today >= 6, "posts: {}", k.posts_today);
    }

    #[test]
    fn a_record_turns_into_an_early_full_pot() {
        let m = ["priya.t", "tomas.t", "ama.t", "lin.t"];
        let d = N / 10;
        let mut k = setup(&m, d);
        // Give priya a record: 0.5 NEAR paid on time in this DAO's circles.
        k.stats.insert(&(a("priya.t"), a(DAO)), &Stats { self_paid: U128(5 * d), earned: U128(5 * d), rounds_paid: 5, circles_done: 1, ..Default::default() });
        pay_all(&mut k, &m, d, 3_000);
        let v = close(&mut k, 3_001);
        assert_eq!(v["paid"], json!(U128(4 * d)));
        assert_eq!(v["backed"], json!(U128(3 * d)));
        let st = k.daos.get(&a(DAO)).unwrap();
        // After round 1, 3 rounds remain and priya has no holdback.
        assert_eq!(st.book.exposure.0, 3 * d);
    }

    #[test]
    fn a_miss_asks_the_dao_and_its_cover_pays_the_pot_in_full() {
        let m = ["priya.t", "tomas.t", "ama.t", "lin.t"];
        let d = N / 10;
        let mut k = setup(&m, d);
        k.stats.insert(&(a("priya.t"), a(DAO)), &Stats { self_paid: U128(5 * d), earned: U128(5 * d), rounds_paid: 5, circles_done: 1, ..Default::default() });
        pay_all(&mut k, &m, d, 3_000);
        close(&mut k, 3_001);
        // Round 2: priya (already paid out in full) does not pay.
        pay_all(&mut k, &["tomas.t", "ama.t", "lin.t"], d, 4_000);
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| close(&mut k, 4_001)));
        assert!(early.is_err(), "cannot close before the deadline while someone owes");
        let v = close(&mut k, 3_001 + 61_000);
        assert_eq!(v["promise"], true);
        let c = k.circle(0);
        assert_eq!(c.status, Status::AwaitingCover);
        assert!(c.cover.as_ref().unwrap().auto);
        // The DAO's proposal runs receive_cover with exactly the dues.
        ctx(DAO, d, 70_000);
        let v = k.receive_cover(0, 2);
        assert_eq!(v["to"], "tomas.t");
        let rec = k.get_record(a("priya.t"));
        assert_eq!(rec["debts"].as_array().unwrap().len(), 1);
        let st = k.daos.get(&a(DAO)).unwrap();
        assert_eq!(st.book.debts.0, d);
        // Debt zeroes credit.
        assert_eq!(k.credit(&a("priya.t"), &a(DAO), &terms()).0, 0);
        // Repay and the credit is back.
        ctx("priya.t", d, 80_000);
        assert_eq!(k.repay().0, d);
        assert!(k.credit(&a("priya.t"), &a(DAO), &terms()).0 > 0);
        let st = k.daos.get(&a(DAO)).unwrap();
        assert_eq!(st.book.debts.0, 0);
        assert_eq!(st.book.recovered.0, d);
        assert!(get_logs().iter().any(|l| l.contains("repaid")));
    }

    #[test]
    fn a_wrong_cover_amount_is_refused() {
        let m = ["priya.t", "tomas.t"];
        let d = N / 10;
        let mut k = setup(&m, d);
        pay_all(&mut k, &["tomas.t"], d, 3_000);
        close(&mut k, 3_000 + 61_000);
        ctx(DAO, d - 1, 70_000);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.receive_cover(0, 1)));
        assert!(r.is_err());
        ctx("not-the-dao.t", d, 70_000);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.receive_cover(0, 1)));
        assert!(r.is_err());
    }

    #[test]
    fn an_early_miss_is_repaid_from_the_missers_own_pot() {
        let m = ["priya.t", "tomas.t", "ama.t"];
        let d = N / 10;
        let mut k = setup(&m, d);
        // Round 1: ama misses; the DAO covers.
        pay_all(&mut k, &["priya.t", "tomas.t"], d, 3_000);
        close(&mut k, 3_000 + 61_000);
        ctx(DAO, d, 65_000);
        k.receive_cover(0, 1);
        // Round 2: all pay (priya from holdback).
        pay_all(&mut k, &["tomas.t", "ama.t"], d, 66_000);
        close(&mut k, 66_001);
        // Round 3: ama's turn. Her debt goes back to the DAO from her pot.
        pay_all(&mut k, &["ama.t"], d, 67_000);
        let c = k.circle(0);
        let payers: Vec<&str> = ["tomas.t"].into_iter().filter(|x| c.seats.iter().find(|s| s.account.as_str() == *x).unwrap().holdback.0 < d).collect();
        pay_all(&mut k, &payers, d, 67_000);
        let v = close(&mut k, 67_001);
        assert_eq!(v["recovered"], json!(U128(d)));
        assert_eq!(v["paid"], json!(U128(2 * d)));
        let st = k.daos.get(&a(DAO)).unwrap();
        assert_eq!(st.book.debts.0, 0);
        assert_eq!(k.circle(0).status, Status::Done);
        assert_eq!(k.held, 0);
    }

    #[test]
    fn no_cover_in_time_pays_short_and_the_debt_goes_to_the_recipient() {
        let m = ["priya.t", "tomas.t"];
        let d = N / 10;
        let mut k = setup(&m, d);
        pay_all(&mut k, &["priya.t"], d, 3_000);
        close(&mut k, 3_000 + 61_000);
        let v = close(&mut k, 3_000 + 61_000 + 601_000);
        // Priya has no record, so her one future round is held back from the short pot.
        assert_eq!(v["paid"], json!(U128(0)));
        assert_eq!(v["holdback"], json!(U128(d)));
        let rec = k.get_record(a("tomas.t"));
        assert_eq!(rec["debts"][0]["creditor"], "priya.t");
    }
}
