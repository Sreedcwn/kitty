# Submission notes

The rules are at <https://nearhackathon.com/HACKATHON.md>; re-read them before submitting. Posting on X and submitting are for the team to do.

Deadline: 14 November 2026, 23:59 UTC. Judging: 16 to 18 November.

## Checklist

- [ ] The repository is public, with a LICENSE (MIT) and a README that says what Kitty is, the problem, and "do X, see Y" steps a judge can follow.
- [ ] The README lists the libraries used and says the code was written with Claude Code ("Built with").
- [ ] No keys or secrets in the repository history: keys live in `~/.near-credentials`, outside the repository.
- [ ] The post on X says it was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, and has `demo/kitty-demo.mp4` attached.
- [ ] A mainnet NEAR account for the prize, created by the team.
- [ ] Track selected: `social`.
- [ ] Submitted once, before the deadline, at <https://nearhackathon.com/#apply>.
- [ ] The testnet demo stays as it is until 18 November, ideally 25 November. `node scripts/verify.mjs` should keep saying "Everything checks out."
- [x] A hosted read-only copy: https://sreedcwn.github.io/kitty/, published from `web/` by `.github/workflows/pages.yml` (GitHub Pages, source: GitHub Actions).

## The tweet

Attach `demo/kitty-demo.mp4`. 179 characters as X counts them (a link counts as 23).

```text
Savings circles run on trust. Kitty puts them on NEAR, with your DAO backing members who pay on time.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
https://github.com/Sreedcwn/kitty
```

## What did you build?

For the form field of that name (20 to 2000 characters; it should cover the problem, the product and how NEAR fits in):

> Savings circles (chit funds, tandas, susus) let a group pool the same amount every round and take turns with the whole pot, but they only work among people who already trust each other, because whoever takes the pot early can stop paying. Kitty puts savings circles on NEAR and lets a community's Sputnik DAO stand behind its members: a newcomer's future dues are held back from their pot so nobody in a circle can lose, while a member's record of on-time payments, tied to their named account, becomes credit to take the full pot early. If someone misses a round, the Kitty contract files an ordinary DAO proposal for exactly the missing dues and passes it with the single vote the council gave it (larger covers go to the council), and the member owes the DAO until they repay. Every circle is a near.social thread written by the contract, whose mentions notify members when their dues are due. It is live on NEAR testnet with a DAO, a demo circle, 24 unit tests and 35 live checks.

## The other form fields

These hold personal data; keep the filled-in values out of the repository.

| Form label | Value |
|---|---|
| Project name | Kitty |
| Team lead | The team decides |
| Email address | The team decides |
| Team size | One of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` |
| Tracks | `social` |
| NEAR wallet address | The team's mainnet account for the prize |
| Repository link | https://github.com/Sreedcwn/kitty |
| Demo post link | The post on X |
| Website | Leave empty |
| Consent | Tick only after agreeing to: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

## The video

`demo/kitty-demo.mp4`: 2:02, 1920x1080, 30 fps, H.264 and AAC, captions burned in because X plays videos muted until someone taps. Every on-chain shot is the real site against the live testnet contracts, filmed with `node demo/record.mjs`; the edit adds "Real transactions on NEAR testnet. Waits shortened.", and the closing card says the narration is an AI voice.

To use a person's voice instead: record the lines in `demo/lines.json` as `demo/out/voice/01.wav` to `21.wav` and run `python demo/edit.py`. The cut follows the recordings' lengths.
