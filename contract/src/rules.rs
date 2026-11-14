//! Every money rule Kitty applies, as pure functions with no NEAR runtime.
//! `cargo test` runs them natively.
//!
//! A circle has `n` members who each pay `dues` every round. In round `k` (1-based) the
//! member in seat `k` takes the pot. From then on that member still owes `dues` for each of
//! the `n - k` rounds left. Kitty makes sure nobody else in the circle carries that risk:
//!
//! - The part of those future dues the community DAO is willing to stand behind ("backed")
//!   is paid out now, as credit.
//! - The rest is held back from the pot ("holdback") and pays the member's later dues
//!   automatically.
//!
//! How much the DAO stands behind is the member's record: a share of the dues they paid
//! themselves, on time, in that DAO's circles, capped per member and by the DAO's total
//! exposure. A newcomer has no record, so their whole future is held back and they receive
//! exactly what they have paid in. A member with a clean record receives the full pot early.

/// Credit a member has earned with one DAO: `bps` basis points of the dues they paid
/// themselves on time, capped at `cap`. Any unpaid debt, to anyone, makes it zero.
pub fn backing(self_paid: u128, bps: u16, cap: u128, has_debt: bool) -> u128 {
    if has_debt {
        return 0;
    }
    (self_paid.saturating_mul(bps as u128) / 10_000).min(cap)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Split {
    /// Sent to the DAO first, repaying covers it made for this member's earlier misses.
    pub recover: u128,
    /// Future dues the DAO stands behind, paid out now.
    pub backed: u128,
    /// Future dues kept in the circle; they pay this member's later rounds.
    pub holdback: u128,
    /// What the member receives now.
    pub pay: u128,
}

/// How round `k` of `n` splits a pot of `pot`.
///
/// `debt_to_dao` is what this member owes the circle's DAO. `backing` is their earned credit,
/// `room` is what is left of the DAO's exposure limit, and `missed_here` is whether this
/// member has missed a round of this same circle (then nothing is backed).
pub fn split(pot: u128, dues: u128, n: u32, k: u32, debt_to_dao: u128, backing: u128, room: u128, missed_here: bool) -> Split {
    assert!(k >= 1 && k <= n, "round out of range");
    let future = dues * (n - k) as u128;
    let recover = debt_to_dao.min(pot);
    let after = pot - recover;
    let mut backed = if missed_here { 0 } else { future.min(backing).min(room) };
    let mut holdback = future - backed;
    if holdback > after {
        // Cannot happen with a full pot (n * dues covers any debt plus the future), but a
        // short pot must never pay out more than it holds.
        holdback = after;
        backed = future - holdback;
    }
    Split { recover, backed, holdback, pay: after - holdback }
}

/// The DAO's risk on one member who has already taken the pot: dues still to come
/// that their holdback does not cover.
pub fn seat_exposure(dues: u128, rounds_left: u32, holdback: u128) -> u128 {
    (dues * rounds_left as u128).saturating_sub(holdback)
}

/// Whether Kitty's own vote may approve a cover, or it waits for the council.
pub fn auto_cover(amount: u128, auto_max: u128, solo: bool) -> bool {
    solo && amount <= auto_max
}

#[cfg(test)]
mod tests {
    use super::*;
    const C: u128 = 100;

    #[test]
    fn newcomer_gets_back_exactly_what_they_paid() {
        // Seat 2 of 4, no record: 2 future rounds held back.
        let s = split(4 * C, C, 4, 2, 0, 0, 1_000, false);
        assert_eq!(s, Split { recover: 0, backed: 0, holdback: 2 * C, pay: 2 * C });
    }

    #[test]
    fn trusted_member_gets_the_full_pot_early() {
        let s = split(4 * C, C, 4, 1, 0, 10 * C, 1_000, false);
        assert_eq!(s, Split { recover: 0, backed: 3 * C, holdback: 0, pay: 4 * C });
    }

    #[test]
    fn partial_record_gets_partial_credit() {
        let s = split(4 * C, C, 4, 1, 0, C + 50, 1_000, false);
        assert_eq!(s.backed, C + 50);
        assert_eq!(s.holdback, 2 * C - 50);
        assert_eq!(s.pay, 2 * C + 50);
    }

    #[test]
    fn dao_room_caps_credit() {
        let s = split(4 * C, C, 4, 1, 0, 10 * C, C, false);
        assert_eq!(s.backed, C);
        assert_eq!(s.holdback, 2 * C);
    }

    #[test]
    fn last_seat_needs_nothing() {
        let s = split(4 * C, C, 4, 4, 0, 0, 0, false);
        assert_eq!(s, Split { recover: 0, backed: 0, holdback: 0, pay: 4 * C });
    }

    #[test]
    fn earlier_misses_are_repaid_first_and_kill_credit() {
        let s = split(4 * C, C, 4, 3, C, 10 * C, 1_000, true);
        assert_eq!(s.recover, C);
        assert_eq!(s.backed, 0);
        assert_eq!(s.holdback, C);
        assert_eq!(s.pay, 2 * C);
    }

    #[test]
    fn money_is_conserved() {
        for n in 2..8u32 {
            for k in 1..=n {
                for b in [0, 50, C, 3 * C, 100 * C] {
                    for room in [0, 70, 100 * C] {
                        for debt in [0, C / 2, C] {
                            let s = split(n as u128 * C, C, n, k, debt, b, room, debt > 0);
                            assert_eq!(s.recover + s.holdback + s.pay, n as u128 * C);
                            assert_eq!(s.backed + s.holdback, C * (n - k) as u128);
                            assert!(s.backed <= room && s.backed <= b);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn short_pot_never_overpays() {
        let s = split(C, C, 4, 1, 0, 0, 0, false);
        assert_eq!(s.pay, 0);
        assert_eq!(s.holdback, C);
    }

    #[test]
    fn backing_is_a_share_of_paid_dues_and_debt_zeroes_it() {
        assert_eq!(backing(1_000, 5_000, 10_000, false), 500);
        assert_eq!(backing(1_000, 5_000, 300, false), 300);
        assert_eq!(backing(1_000, 5_000, 10_000, true), 0);
        assert_eq!(backing(0, 10_000, 10_000, false), 0);
    }

    #[test]
    fn exposure_is_what_holdback_does_not_cover() {
        assert_eq!(seat_exposure(C, 3, 0), 3 * C);
        assert_eq!(seat_exposure(C, 3, 2 * C), C);
        assert_eq!(seat_exposure(C, 1, 2 * C), 0);
    }

    #[test]
    fn only_small_covers_skip_the_council() {
        assert!(auto_cover(C, C, true));
        assert!(!auto_cover(C + 1, C, true));
        assert!(!auto_cover(1, C, false));
    }
}
