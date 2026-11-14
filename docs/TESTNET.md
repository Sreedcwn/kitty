# Testnet evidence

Everything here can be checked on the explorer, or with `node scripts/verify.mjs`, which needs no keys.

- Contract: [`v1.kitty-hq.testnet`](https://testnet.nearblocks.io/address/v1.kitty-hq.testnet), code sha256 `85f9aff58524648513e02140ca1d9a320dc8009236b88179ba8cc82ceead8734` (352520 bytes)
- DAO: [`banyan.sputnikv2.testnet`](https://testnet.nearblocks.io/address/banyan.sputnikv2.testnet), council `priya.banyan-coop.testnet`, `tomas.banyan-coop.testnet`, `rosa.banyan-coop.testnet`
- near.social data: `social.testnet`, read at https://kv.test.fastnear.com/v0/latest/social.testnet/v1.kitty-hq.testnet

## Setup transactions

| Step | Transaction |
|---|---|
| Deploy the contract | [tx](https://testnet.nearblocks.io/txns/5TcZ8hHZd4cuvAzmYrgeFgzxX5PLpFD9T6gdv4VbrJSn) |
| Initialise it (factory `sputnikv2.testnet`, near.social `social.testnet`) | [tx](https://testnet.nearblocks.io/txns/4FKsaJqjcmVHDVWe3TLPNy7LMpySiESLbzx1umagEskG) |
| Create the DAO through the Sputnik factory | [tx](https://testnet.nearblocks.io/txns/F8LBSNFqw3aiAqtxiXhKE7qqEDE5a3HQQtDJnXR6w84f) |
| Put 1.5 NEAR in its treasury | [tx](https://testnet.nearblocks.io/txns/HSjj6g4rDuCWHnL1PsRtT4KVmw4UcfpmdwmNwf5BNbYC) |
| Council proposals #0 (add the Kitty role) and #1 (set its terms), each filed and passed by two council votes | read them with `get_proposal` on the DAO, or `node scripts/verify.mjs` |
| Warm-up circle: create and close its three rounds | [tx](https://testnet.nearblocks.io/txns/EMG3xFahfS5eTX37f2ZyHtrfbQybLoUNyhrFuhgER8M4) [tx](https://testnet.nearblocks.io/txns/DyaBaDMRnqoeHhkVceAwgZgr4XD7M6Ad1F8hpJFNREx) [tx](https://testnet.nearblocks.io/txns/AnamGkRmebEymZrpxqDpC9FrNWQSsiLM3fnVDd8gxJMB) [tx](https://testnet.nearblocks.io/txns/GL95GDSuQVAoQDrz7hr9muJpscS8Sxg5bbhUDqJtTTWV) |

## Refusals

Run at 2026-11-13T18:01:02.014Z: 5 passed, 0 failed.

| Check | Result | Detail |
|---|---|---|
| an account that is not a factory DAO cannot set terms | ok | ERR_NOT_DAO: only a DAO made by the factory can set terms, through a proposal [tx](https://testnet.nearblocks.io/txns/7G3JaL52oNzKpgkR2s9s4AddjJSnFnzYJ7b8vh9eFg6P) |
| a circle with someone outside the DAO's roles is refused, deposit returned | ok | ERR_NOT_MEMBER: kitty-fund2.testnet not in the DAO's roles council, members. Your deposit was returned. [tx](https://testnet.nearblocks.io/txns/8mMZuNu3q4bh81s9GkTBreeUPpiiNd5w4jET7y386HSq) |
| dues above the DAO's max_dues are refused | ok | ERR_DUES: above zero and at most the DAO's max_dues [tx](https://testnet.nearblocks.io/txns/5m9p5vj7eKgJyoQgftKhHs32wFbMtkf6eazj79JnJ2qt) |
| receive_cover from anyone but the circle's DAO is refused | ok | ERR_NOT_DAO: covers come from the circle's DAO [tx](https://testnet.nearblocks.io/txns/DGxe8L8HTz9qqXeeVMArCmwNxZ6daNtXojqRHf8kQnVn) |
| repaying with no debt is refused, deposit returned | ok | ERR_NO_DEBT: you owe nothing [tx](https://testnet.nearblocks.io/txns/7oHcvwYKn57oM98BkuYCzvWHn2NiXq1NNRAMhQH7bbBx) |

## Scenario A: small covers, passed by Kitty's own vote

Run at 2026-11-13T18:01:21.905Z: 21 passed, 0 failed.

| Check | Result | Detail |
|---|---|---|
| rosa starts with credit from the seed circle | ok | 0.3 NEAR  |
| create "E2E small covers 82592" | ok | circle #1 [tx](https://testnet.nearblocks.io/txns/9bCxMEVBnfYJQSwv6qEjpHYg3pVjokDTyWeeG83rUui8) |
| every seat taken starts round 1 | ok |   |
| closing before the deadline with dues owed is refused | ok | ERR_TOO_EARLY: someone has not paid and the round is still open [tx](https://testnet.nearblocks.io/txns/CfX6EmoB7ev3QERvgJswmo5SnUfvrKxHjt8gBRn4FBVz) |
| round 1 closes past the deadline | ok |  [tx](https://testnet.nearblocks.io/txns/9QksQaQDG8bAtmUjtt1rxHqqL3hZpw94hbyg5WFsyBqU) |
| Kitty filed a cover proposal on the DAO | ok | 2  |
| the cover passed with Kitty's own vote and the round paid out | ok | log: {"round":1,"recipient":"rosa.banyan-coop.testnet","pot":"300000000000000000000000","recovered":"0","backed":"200000000000000000000000","holdback":"0","paid  |
| proposal #2 is Approved, filed and voted by v1.kitty-hq.testnet | ok | Approved  |
| rosa took the full pot early: credit replaced holdback | ok | 0.3 paid, 0.2 credit  |
| kofi owes the DAO the covered dues | ok |   |
| round 2 closes as soon as everyone paid | ok |  [tx](https://testnet.nearblocks.io/txns/SAeqsACN512rCnjsmPXycy6YUPYh1Yd6eBGMe13fdnq) |
| kofi's debt came out of his own pot | ok | paid 0.1, recovered 0.1, held back 0.1  |
| kofi owes nothing now | ok |   |
| round 3 closes past the deadline | ok |  [tx](https://testnet.nearblocks.io/txns/GQDQdmeGsvSGhotTvYXESqVZXngo7gEWtbmWZP4k6dB8) |
| the circle finished | ok |   |
| lin, the last seat, got the full pot | ok |   |
| rosa owes the DAO and her credit is zero | ok | credit 0  |
| the DAO's book shows two covers and one debt outstanding | ok | debts 0.1  |
| rosa repays and her credit is back | ok |  [tx](https://testnet.nearblocks.io/txns/5RrPGLTS4YgU6sXxok9au7qEZZdyEYdNCvu6wpc8CK3B) |
| the DAO got all its covers back | ok |   |
| the DAO stands behind nothing for this circle | ok |   |

## Scenario B: a large cover, passed by the council

Run at 2026-11-13T18:03:32.123Z: 9 passed, 0 failed.

| Check | Result | Detail |
|---|---|---|
| create "E2E council cover 12126" | ok | circle #2 [tx](https://testnet.nearblocks.io/txns/J7uGdxayBfiZ2jNW3nzs3wLMt6sSx4NYRNSzcg5vqSwR) |
| every seat taken starts round 1 | ok |   |
| round 1 closes and files a cover | ok |  [tx](https://testnet.nearblocks.io/txns/FPLooDQZw3sE5g25y6DmRo9CMv4VTcShe2rpBsoV98h7) |
| a 0.3 NEAR cover is above the 0.25 auto limit, so the circle waits | ok |   |
| proposal #4 is open with no vote from Kitty | ok |   |
| closing again before the council acts is refused | ok | ERR_WAITING: waiting for the DAO to pass cover proposal #4. After 600s it pays out short.  |
| two council votes pass it | ok |  [tx](https://testnet.nearblocks.io/txns/Hikb5q7ZzYbZRni2mmPTSMWJfKwduBmtoUZCZLttb5pd) |
| the DAO ran receive_cover and the pot paid tomas in full | ok | Approved  |
| kofi's pot repaid the council's cover | ok |  [tx](https://testnet.nearblocks.io/txns/26hSfn6i2GGZWXD6oiLuZoa1i77mGie6eqTrAtbKWyrW) |

## The demo circle, from the chain

Circle #3, "December rent", Done. near.social thread root: `v1.kitty-hq.testnet/1794593523159`.

| Round | Took the pot | Paid out | Credit | Held back | DAO cover |
|---|---|---|---|---|---|
| 1 | `priya.banyan-coop.testnet` | 0.4 | 0.3 | 0 | – |
| 2 | `ama.banyan-coop.testnet` | 0.2 | 0 | 0.2 | – |
| 3 | `tomas.banyan-coop.testnet` | 0.4 | 0.1 | 0 | 0.1 NEAR, proposal #5 |
| 4 | `lin.banyan-coop.testnet` | 0.4 | 0 | 0 | – |

DAO book now: 4 covers for 0.6 NEAR, 0.6 NEAR back, 0 NEAR owed, 0 NEAR of credit out.
