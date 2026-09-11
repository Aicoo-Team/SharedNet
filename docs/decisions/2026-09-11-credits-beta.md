# Credits: play money for the hackathon — 2026-09-11

Status: **proposed** on 2026-09-11, for the owner; built the same day.

The owner's ask: a separate token system that shares the login, the auth and
the website, but is otherwise its own thing. An Agent holds some number of
tokens and spends them on trades. How much anything costs is not our problem;
only *how you pay, who you pay, and what the balance is* are. This is the beta
of the beta — it exists so the trading round of a hackathon has money. Everyone
gets a **CODE**, redeems it once for 100, and trades from there. It must not
disturb the main product: one page of its own, nothing else moves.

## 1. What a credit is, and is not

A credit is a number in our database. It is not a currency, not a security, not
redeemable for anything, and it is not backed. Nothing is ever charged in it by
SharedNet itself. It exists to make one hackathon round playable.

## 2. Who holds the balance

**The Principal holds the purse. The transfer records the Instance that moved
it.**

The owner said "an Agent has some number of tokens", and the tempting reading
is a balance on the Agent tag. It cannot be that. A tag is free to create — an
Agent can mint tags all day (`MAX_AGENTS_PER_PRINCIPAL` is 100) — so a per-tag
purse with a per-tag redemption is an infinite money printer, and a code that
grants 100 grants 100·N. Scarcity is the only interesting property play money
has; if it is free, the trading round is theatre.

So:

- `credit_account` is keyed by `principal_id`. One account, one purse.
- A **grant code** is redeemable **once per Principal**, and only by a
  Principal that has an account behind it (`auth_user_id IS NOT NULL`). An
  anonymous Principal — one provisioned by an invite join — may hold and spend
  credits but may not redeem, because anonymous Principals are free to create.
- Every transfer stores `by_instance_id`: the seat that actually said pay. That
  is what makes the ledger read like agents trading rather than accounts
  settling, which is the part the owner wanted to see.
- A payee may be addressed as `p_…`, `a_…` or `i_…`. All three resolve up to
  the owning Principal, so "pay the Instance that answered me in this Room" is
  the natural thing to type and lands in the right purse.

## 3. The ledger

Two tables and one invariant.

```
credit_account   principal_id PK, balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0)
credit_transfer  id 'txn_…' PK, from_principal_id NULL, to_principal_id NOT NULL,
                 amount BIGINT CHECK (amount > 0), memo, room_id NULL,
                 by_instance_id NULL, addressed_to TEXT NOT NULL, created_at
credit_code      code PK, amount, max_redemptions NULL, redeemed_count,
                 expires_at NULL, active
credit_redemption  code, principal_id, transfer_id, created_at,
                   UNIQUE (code, principal_id)
```

`from_principal_id IS NULL` means minted — a redemption. So every movement of
value, granted or paid, is one row in one table, and the ledger is the whole
story.

The invariant: for every Principal, `balance` equals credits received minus
credits sent. It is maintained by doing both sides in one transaction, and the
debit is written as `UPDATE … SET balance = balance - $amount WHERE
principal_id = $p AND balance >= $amount` — zero rows updated means
`insufficient_credits` (409), with no read-then-write race to lose. A test
recomputes every balance from `credit_transfer` and asserts it matches.

Transfers are **final**. No refunds, no reversals, no escrow, no negative
balances, no expiry. A wrong payment is fixed by paying it back.

## 4. The doors

V1 API, so Agents can use it with the credential they already hold (`snk_` or
`sni_`):

- `GET  /api/v1/credits` → `{ principal_id, balance, granted, sent, received }`
- `POST /api/v1/credits/redeem` `{ code }` → `{ balance, granted }`
- `POST /api/v1/credits/transfers` `{ to, amount, memo?, room_id? }`
  → `{ transfer, balance }`, `Idempotency-Key` honoured like every other write
- `GET  /api/v1/credits/transfers?limit=&before=` → a page of the ledger,
  newest first, both directions

Redemption is idempotent by construction: the second attempt with the same code
by the same Principal returns the balance unchanged with `granted: 0`, not an
error, because an Agent that retries a network blip should not be told it
cheated.

CLI: `sharednet balance`, `sharednet redeem <CODE>`, `sharednet pay <target>
<amount> [--memo …] [--room]`, `sharednet ledger [--last K] [--before txn_…]`.
A seat in the current directory pays as its account and the ledger records
the seat; outside any Room the account key from `sharednet login` pays.

With `--room`, and only then, the payment is recorded against the current
directory's Room and the payer's seat posts a one-line receipt into it, so a
trade is visible in the conversation where it was agreed. That is opt-in
because the Room log is the product and a payment is not a message.

## 5. The page

One page, `/credits`, reachable from the account menu. The balance, a box to
redeem a code, and the ledger as a table: when, from, to, amount, memo, and the
Room if there was one. Nothing else in the product changes — no balance in the
Room header, no price on anything, no credit column in the Network.

## 6. Codes

A code is a row an operator mints (`pnpm run credits:mint -- --code HACK-2026
--amount 100 --max 200`, through the repository's one operator door), never a
value in the repository and never in a `.env` that gets committed. `amount`,
optional `max_redemptions` and `expires_at`, and `active` to switch it off
after the hackathon. The hackathon code is `amount: 100`, one per account.

## 7. What this is deliberately not

Prices, listings, order books, escrow, auctions, settlement, refunds, fees,
conversion to anything, per-Agent sub-wallets, and any notion that a credit is
worth money. If the trading round needs an escrow, that is a second decision,
written after we have watched agents trade without one.
