# @campus/grubhub — interim Grubhub dining connector

Backs the agents' `dining__*` tools with **real** Grubhub restaurants, menus and orders. Each person
orders on **their own Grubhub account**, paid with the card saved there. Team decision (Oct 2026);
P4 may fold it into `@campus/tools`.

**What it is, honestly:** it runs the unofficial [`grubhub-mcp`](https://github.com/aserper/grubhub-mcp)
server (pinned `1.1.7`, run unmodified as a separate process; the repo has no license, so none of its
code is copied here). That server calls **Grubhub's private app API** using the Android app's client
key. It is not an official integration, is likely against Grubhub's terms, can break without notice,
and accounts can be blocked. Say so if asked.

| Tool                     | Risk      | Account            | What it does                                                                                                                                 |
| ------------------------ | --------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `dining__search_options` | read      | shared             | Restaurants near `DELIVERY_LATITUDE/LONGITUDE` that deliver now, with a per-person estimate                                                  |
| `dining__get_menu`       | read      | shared             | Menu items; `vegetarian_friendly` is **inferred** from names/categories (Grubhub has no tags)                                                |
| `dining__quote_order`    | read      | the caller's own   | Builds a cart (required options default to the first choice) and returns the **real total** incl. tax/fees, plus item names. No charge      |
| `dining__submit_order`   | **spend** | the caller's own   | Places that exact cart with the saved card. Refuses someone else's cart, a changed total, or one above `GRUBHUB_MAX_ORDER_MINOR`             |
| `dining__order_status`   | read      | the payer's own    | Delivery tracking (placed → preparing → on the way → delivered)                                                                              |

`quote_order` answers `{error: "account_not_connected"}` when the caller hasn't signed in their own
account. Every call goes through the tool gateway: `submit_order` needs the payer's approval of the
exact total on the approval page, and the bot only says "ordered" once Grubhub returns an order id.

## Who pays

- **1:1 chat:** the person orders for themselves; it's paid on their own account.
- **Group order:** the person who **asked** for the order pays, on their own account. The cart is
  quoted on their account, then everyone else with a share 👍s the order message (or says "confirm");
  a 👎 cancels. Only then is the payer sent the approval link. Once it's placed, each person gets a
  DM with what they owe the payer.

## Setup

1. `.env`: `DINING_PROVIDER=grubhub`, `DELIVERY_LATITUDE/LONGITUDE`,
   `DELIVERY_STREET/CITY/STATE/POSTAL_CODE`, `DELIVERY_PHONE`, `DELIVERY_EMAIL` (optional
   `GRUBHUB_MAX_ORDER_MINOR`, `GRUBHUB_SESSION_DIR`, `GRUBHUB_CHECKOUT_ENABLED`). Needs `uv` installed.
2. Sign in the shared session once (search and menus):
   `corepack pnpm --filter @campus/grubhub login` (one-time code by email).
3. **Each person who orders connects their own account once, from their 1:1 chat:** they text the
   assistant "connect grubhub", reply with their Grubhub email, then reply with the code Grubhub
   emails them. No password is asked for; the email and code never reach the model and aren't saved
   to memory. A group order whose payer isn't connected DMs them this automatically. (Admin
   alternative: `corepack pnpm --filter @campus/grubhub login -- --user <their userId>`; the userId
   is on their `/me` page.) Their account needs the delivery address and a **plain credit or debit
   card** saved in the Grubhub app: Apple Pay, Google Pay, PayPal, Venmo and gift cards can't be used
   (Apple Pay needs Face ID on their phone), and expired cards are skipped.

Sessions are saved in `.data/grubhub` (the shared one at the root, each person's in
`users/<userId>/`). They contain credentials: never commit or share them.

## Placing orders: `GRUBHUB_CHECKOUT_ENABLED`

Off by default. While off, `submit_order` checks everything (owner, exact total, cap) and then fails
closed with `checkout_not_available`: nothing is charged and the person is told the order wasn't
placed. When on, it picks the saved card, attaches it to the cart for the approved total, and checks
out. If Grubhub refuses (4xx) the order isn't placed; a timeout, a 5xx or a response without an order
id is reported as **outcome unknown** (the task goes to `needs_reconciliation`, never retried).

**Don't switch it on until the checkout calls are verified** (below). It charges real money.

## How it runs

`py/campus_grubhub.py` starts the unmodified grubhub-mcp server (login, search, menus, payment
methods, tracking) and adds cart tools that call the cart endpoints Grubhub actually serves.
grubhub-mcp's own cart tools call endpoints that don't exist (`/carts/{id}/line_items`,
`/carts/{id}/submit`), so its carts stay empty. One process runs for the shared session and one per
person who has signed in (`GrubhubAccounts`, started on first use). Started with
`uv run --no-project --with grubhub-mcp==1.1.7 python py/campus_grubhub.py`.

Wrapper tools: `cart_new`, `cart_set_delivery`, `cart_add_line`, `cart_set_tip`, `cart_read`,
`cart_add_payment` (unverified), `cart_checkout` (unverified).

## Verified / not verified (2026-10-25, live, Taco Bell near ASU)

- Verified: search, menus, item option trees; building a priced cart. Steps, in order: empty cart →
  `PUT delivery_info` (address + phone + email; required before items, or items are refused as
  "not open") → `POST lines` (required nested choices in `child_options`) → `POST tip` → read
  `charges.diner_grand_total`. Example: 2 burritos = $14.62 + $2.49 fees + $1.38 tax + $2.00 tip = $20.49.
- **Not verified: placing the order.** `cart_add_payment` (`POST /carts/{id}/payments` with
  `{payment_id, type, amount}`) and `cart_checkout` (`POST /carts/{id}/checkout`) are guesses from the
  API's conventions. Also unverified: the `get_payment_methods` response shape (read tolerantly by
  `savedCard()`) and the checkout response (`orderIdOf()`).

To verify: record one real, cheap checkout on grubhub.com with DevTools → Network open and export a
HAR. From it, fix the paths/bodies in `campus_grubhub.py`, the field names in `savedCard()` and
`orderIdOf()` (`src/dining.ts`), and look for extra steps (CVV re-entry, a device/fraud check, 3-D
Secure, card tokenization, a required PUT of fulfillment or payment info). If one of those blocks a
pure-API checkout, the fallback is driving grubhub.com's checkout with Playwright on the signed-in
session. Then set `GRUBHUB_CHECKOUT_ENABLED=true` and place one cheap order through the agent, with
the account owner's explicit OK.
