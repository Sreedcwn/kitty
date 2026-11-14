//! The words Kitty posts to near.social, as pure functions.
//!
//! Every circle is one near.social thread, written by the Kitty contract's own account: a
//! root post when the circle is created, then one reply per event (a round opening, a pot
//! paid, a cover asked of the DAO, a debt repaid). Posts mention the members they are about,
//! and near.social notifies the first ten accounts a post mentions. So a member's
//! notifications tell them when their dues are due and when the pot is theirs, with no app,
//! bot or email list.
//!
//! The write itself is a `__fastdata_kv` call to the near.social data account (`social` on
//! mainnet), which has no contract: the receipt fails by design and the indexer reads the
//! arguments. See https://near.social/skill.md.

use near_sdk::serde_json::{json, Map, Value};

const MILLI: u128 = 1_000_000_000_000_000_000_000;

/// An amount of NEAR for people: at most three decimals, trailing zeros dropped.
pub fn near(yocto: u128) -> String {
    let milli = yocto / MILLI;
    let s = format!("{}.{:03}", milli / 1000, milli % 1000);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    format!("{s} NEAR")
}

/// A timestamp in milliseconds as "2026-11-14 14:05 UTC".
pub fn utc(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", rem / 3600, (rem % 3600) / 60)
}

fn at(list: &[String]) -> String {
    list.iter().map(|a| format!("@{a}")).collect::<Vec<_>>().join(" ")
}

/// The `__fastdata_kv` arguments for one post. A reply also writes near.social's backlink key.
pub fn post_args(author: &str, id: u64, text: &str, root: Option<u64>) -> Value {
    let mut m = Map::new();
    match root {
        Some(r) => {
            let parent = format!("{author}/{r}");
            m.insert(format!("post/{id}"), json!({ "text": text, "reply_to": parent, "root": parent }));
            m.insert(format!("reply/{author}/{r}/{id}"), json!({}));
        }
        None => {
            m.insert(format!("post/{id}"), json!({ "text": text }));
        }
    }
    Value::Object(m)
}

pub fn profile_args() -> Value {
    json!({
        "profile/name": "Kitty",
        "profile/about": "Rotating savings circles backed by Sputnik DAOs. Every post here is written by the Kitty smart contract when something happens in a circle: a round opens, a pot is paid, a member misses and their DAO covers them. Each circle is one thread. #kitty",
    })
}

pub struct Opened<'a> {
    pub name: &'a str,
    pub dao: &'a str,
    pub members: &'a [String],
    pub dues: u128,
    pub round_secs: u64,
    pub circle: u64,
}

/// The root post of a circle's thread.
pub fn opened(o: &Opened) -> String {
    let n = o.members.len();
    format!(
        "\u{1FA99} New savings circle \"{}\" (#{}) at @{}.\n{} seats, {} a round, {} rounds of {}. Each round everyone pays in and one member takes the whole pot, in this order: {}.\nTake your seat with join({}). #kitty",
        o.name,
        o.circle,
        o.dao,
        n,
        near(o.dues),
        n,
        span(o.round_secs),
        at(o.members),
        o.circle
    )
}

fn span(secs: u64) -> String {
    if secs % 86_400 == 0 {
        let d = secs / 86_400;
        format!("{d} day{}", if d == 1 { "" } else { "s" })
    } else if secs % 3600 == 0 {
        let h = secs / 3600;
        format!("{h} hour{}", if h == 1 { "" } else { "s" })
    } else if secs % 60 == 0 {
        format!("{} min", secs / 60)
    } else {
        format!("{secs} s")
    }
}

/// What is due in an open round.
pub struct Due {
    pub round: u32,
    pub rounds: u32,
    pub payers: Vec<String>,
    pub from_holdback: Vec<String>,
    pub dues: u128,
    pub deadline_ms: u64,
    pub taker: String,
}

pub fn due_line(d: &Due) -> String {
    let mut s = format!("Round {} of {} is open: ", d.round, d.rounds);
    if d.payers.is_empty() {
        s.push_str("every member's dues come from their holdback");
    } else {
        s.push_str(&format!("{} pay {} by {}", at(&d.payers), near(d.dues), utc(d.deadline_ms)));
    }
    if !d.from_holdback.is_empty() && !d.payers.is_empty() {
        s.push_str(&format!("; {} covered by holdback", at(&d.from_holdback)));
    }
    s.push_str(&format!(". This pot goes to @{}.", d.taker));
    s
}

pub fn started(d: &Due) -> String {
    format!("Every seat is taken. {}", due_line(d))
}

pub struct Paid<'a> {
    pub round: u32,
    pub to: &'a str,
    pub dao: &'a str,
    pub paid: u128,
    pub backed: u128,
    pub holdback: u128,
    pub recovered: u128,
    pub covered: u128,
    pub cover_proposal: Option<u64>,
    pub covered_for: &'a [String],
    pub short: u128,
    pub short_for: &'a [String],
}

/// The reply when a round closes. `next` is the next round's due line, or `done` the
/// closing line of a finished circle.
pub fn paid(p: &Paid, next: Option<String>, done: Option<String>) -> String {
    let mut s = format!("\u{1F4B0} Round {}: @{} took the pot, {}", p.round, p.to, near(p.paid));
    let mut notes = vec![];
    if p.backed > 0 {
        notes.push(format!("{} of it is credit @{} stands behind, earned by their record", near(p.backed), p.dao));
    }
    if p.holdback > 0 {
        notes.push(format!("{} is held back to pay their later rounds", near(p.holdback)));
    }
    if p.recovered > 0 {
        notes.push(format!("{} went back to @{} for an earlier cover", near(p.recovered), p.dao));
    }
    if !notes.is_empty() {
        s.push_str(&format!(" ({})", notes.join("; ")));
    }
    s.push('.');
    if p.covered > 0 {
        s.push_str(&format!(
            "\n@{} covered {} for {}{}, who now owe the DAO.",
            p.dao,
            near(p.covered),
            at(p.covered_for),
            p.cover_proposal.map(|i| format!(" (proposal #{i})")).unwrap_or_default()
        ));
    }
    if p.short > 0 {
        s.push_str(&format!("\nNo cover came in time, so the pot was {} short. {} owe @{}.", near(p.short), at(p.short_for), p.to));
    }
    if let Some(n) = next {
        s.push('\n');
        s.push_str(&n);
    }
    if let Some(d) = done {
        s.push('\n');
        s.push_str(&d);
    }
    s
}

/// The last line of a finished circle: what each member earned toward credit.
pub fn done(earned: &[(String, u128)], missed: &[String]) -> String {
    let mut s = String::from("\u{2705} Circle complete. Every pot was paid.");
    let parts: Vec<String> = earned.iter().filter(|(_, e)| *e > 0).map(|(a, e)| format!("@{a} {}", near(*e))).collect();
    if !parts.is_empty() {
        s.push_str(&format!(" Added to members' records: {}.", parts.join(", ")));
    }
    if !missed.is_empty() {
        s.push_str(&format!(" No record from this circle for {}, who missed a round.", at(missed)));
    }
    s
}

pub fn cover_asked(missing: &[String], round: u32, dao: &str, amount: u128, proposal: u64, auto: bool) -> String {
    format!(
        "\u{26A0}\u{FE0F} {} missed round {}. Kitty asked @{} to cover {} so the pot pays in full: proposal #{}, {}.",
        at(missing),
        round,
        dao,
        near(amount),
        proposal,
        if auto { "within the DAO's auto-cover limit, so Kitty's own vote passes it" } else { "above the DAO's auto-cover limit, so it waits for the council" }
    )
}

pub fn repaid(who: &str, amount: u128, to: &str, round: u32, clear: bool) -> String {
    format!(
        "\u{1F91D} @{who} repaid {} to @{to} for round {round}.{}",
        near(amount),
        if clear { " They owe nothing now, and their credit is back." } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_civil_utc() {
        assert_eq!(utc(0), "1970-01-01 00:00 UTC");
        // 2026-11-14 14:05:00 UTC
        assert_eq!(utc(1_794_665_100_000), "2026-11-14 14:05 UTC");
        // A leap day.
        assert_eq!(utc(1_709_164_800_000), "2024-02-29 00:00 UTC");
    }

    #[test]
    fn amounts_are_short() {
        assert_eq!(near(100_000_000_000_000_000_000_000), "0.1 NEAR");
        assert_eq!(near(1_250_000_000_000_000_000_000_000), "1.25 NEAR");
        assert_eq!(near(2_000_000_000_000_000_000_000_000), "2 NEAR");
    }

    #[test]
    fn replies_carry_root_and_backlink() {
        let v = post_args("kitty.testnet", 7, "hi", Some(5));
        assert_eq!(v["post/7"]["reply_to"], "kitty.testnet/5");
        assert_eq!(v["post/7"]["root"], "kitty.testnet/5");
        assert!(v.get("reply/kitty.testnet/5/7").is_some());
        let root = post_args("kitty.testnet", 5, "hi", None);
        assert!(root["post/5"].get("reply_to").is_none());
    }

    #[test]
    fn mentions_are_separated_so_near_social_sees_each() {
        let m = vec!["priya.b.testnet".to_string(), "tomas.b.testnet".to_string()];
        let s = due_line(&Due { round: 2, rounds: 4, payers: m, from_holdback: vec![], dues: 100_000_000_000_000_000_000_000, deadline_ms: 0, taker: "tomas.b.testnet".into() });
        assert!(s.contains("@priya.b.testnet @tomas.b.testnet pay 0.1 NEAR"));
        assert!(s.ends_with("goes to @tomas.b.testnet."));
    }

    #[test]
    fn a_paid_post_explains_credit_and_holdback() {
        let none: Vec<String> = vec![];
        let p = Paid {
            round: 1,
            to: "priya.t",
            dao: "banyan.sputnikv2.testnet",
            paid: 400_000_000_000_000_000_000_000,
            backed: 300_000_000_000_000_000_000_000,
            holdback: 0,
            recovered: 0,
            covered: 0,
            cover_proposal: None,
            covered_for: &none,
            short: 0,
            short_for: &none,
        };
        let s = paid(&p, None, None);
        assert!(s.contains("@priya.t took the pot, 0.4 NEAR (0.3 NEAR of it is credit @banyan.sputnikv2.testnet stands behind"));
    }
}
