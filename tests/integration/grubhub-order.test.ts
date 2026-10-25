// P2 contribution (owner of this folder: P1 — please review). Real-provider orders end to end through
// P1's pipeline, with Grubhub replaced by a fake shaped like real grubhub-mcp responses. Each person
// has their own fake Grubhub account, like in production.
//   Group: Avery asks → proposal → confirm → each agent picks items → real quote on AVERY's account
//   (she asked, she pays) → everyone else 👍s their share → Avery approves the exact total → placed
//   → each person is DM'd what they owe Avery → tracking on Avery's account.
//   Personal: Blake orders in his 1:1 chat on his own account.
import type { GroupMealState, InboundMessage, ModelRequest, PersonalMealState } from "@campus/contracts";
import { FakeModelClient, lastMessageText } from "@campus/contracts/fakes";
import type { Simulator } from "@campus/worker";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_MEMBERS, AVERY, BLAKE, CASEY, GROUP, makeSim } from "./helpers";

const MENU = {
  restaurant: {
    id: "926742",
    name: "Taco Bell",
    menu_category_list: [
      {
        name: "Burritos",
        menu_item_list: [
          { id: "11", name: "Bean Burrito", price: { amount: 199, currency: "USD" } },
          { id: "12", name: "Steak Burrito", price: { amount: 731, currency: "USD" } },
        ],
      },
      {
        name: "Veggie Cravings",
        menu_item_list: [{ id: "21", name: "Crunchwrap Supreme", price: { amount: 599, currency: "USD" } }],
      },
      {
        name: "Drinks",
        menu_item_list: [{ id: "31", name: "Baja Blast", price: { amount: 299, currency: "USD" } }],
      },
    ],
  },
};
const PRICES = new Map([
  ["11", 199],
  ["12", 731],
  ["21", 599],
  ["31", 299],
]);
const FEES_AND_TAX = 412;
const GRUBHUB_ENV = {
  DINING_PROVIDER: "grubhub",
  DELIVERY_LATITUDE: "33.4242",
  DELIVERY_LONGITUDE: "-111.9281",
  DELIVERY_STREET: "301 E Orange St",
  DELIVERY_CITY: "Tempe",
  DELIVERY_STATE: "AZ",
  DELIVERY_POSTAL_CODE: "85281",
  DELIVERY_PHONE: "4805550100",
  DELIVERY_EMAIL: "demo@example.com",
};
const CHECKOUT_ON = { ...GRUBHUB_ENV, GRUBHUB_CHECKOUT_ENABLED: "true" };

type Call = { user: string | null; tool: string; args: Record<string, unknown> };

/** Fake Grubhub: one shared session (search, menus) plus each signed-in person's own account. */
function fakeGrubhub() {
  const state = {
    calls: [] as Call[],
    carts: new Map<string, { user: string; subtotal: number }>(),
    signedIn: new Set([AVERY.userId, BLAKE.userId, CASEY.userId]),
    totalOverride: null as number | null,
    noTotal: false,
    tracking: ["CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"],
    /** What cart_checkout does: answer with an order id, or throw like a timeout. */
    checkout: (): unknown => ({ order_id: "GH-777" }),
    lastCart: "",
    /** The code Grubhub "emails" when someone signs in from chat. */
    loginCode: "123456",
    hasCard: true,
  };
  const make =
    (user: string | null) =>
    async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
      state.calls.push({ user, tool, args });
      switch (tool) {
        case "search_restaurants":
          return {
            results: [
              {
                restaurant_id: "926742",
                name: "Taco Bell",
                open: true,
                delivery: true,
                cuisines: ["Fast Food"],
              },
            ],
          };
        case "get_restaurant":
          return MENU;
        case "get_menu_item":
          return { menu_item: { choice_category_list: [] } };
        case "cart_new": {
          const id = `cart-${state.carts.size + 1}`;
          state.carts.set(id, { user: user!, subtotal: 0 });
          state.lastCart = id;
          return { id };
        }
        case "cart_set_delivery":
        case "cart_set_tip":
        case "cart_add_payment":
          return { ok: true };
        case "cart_add_line":
          state.carts.get(String(args.cart_id))!.subtotal +=
            (PRICES.get(String(args.menu_item_id)) ?? 0) * Number(args.quantity ?? 1);
          return { id: "line-1" };
        case "cart_read": {
          const subtotal = state.carts.get(String(args.cart_id))?.subtotal ?? 0;
          // Shape Grubhub returned live (2026-10-25).
          return {
            id: args.cart_id,
            charges: state.noTotal
              ? null
              : {
                  lines: { line_items: subtotal ? [{ id: "line-1" }] : [] },
                  diner_subtotal: subtotal,
                  fees: { total: FEES_AND_TAX - 100 },
                  taxes: { total: 100 },
                  tip: { amount: 0, type: "INCLUDE_IN_BILL" },
                  diner_grand_total: state.totalOverride ?? subtotal + FEES_AND_TAX,
                },
          };
        }
        case "send_login_otp":
          if (String(args.email).startsWith("nobody"))
            throw new Error("grubhub send_login_otp: unknown email");
          return { ok: true };
        case "verify_login_otp":
          if (args.code !== state.loginCode) throw new Error("grubhub verify_login_otp: invalid code");
          state.signedIn.add(user!);
          return { ok: true };
        case "get_payment_methods":
          if (!state.hasCard) return [{ id: "pm-apple", type: "APPLE_PAY", default: true }];
          return [
            { id: "pm-apple", type: "APPLE_PAY", default: true },
            {
              id: "pm-visa",
              type: "CREDIT_CARD",
              brand: "VISA",
              expiration_month: 12,
              expiration_year: 2031,
            },
          ];
        case "cart_checkout":
          return state.checkout();
        case "track_order":
          return { status: state.tracking.shift() ?? "DELIVERED", estimated_delivery_minutes: 9 };
        default:
          throw new Error(`unexpected grubhub tool ${tool}`);
      }
    };
  return {
    state,
    overrides: {
      diningCaller: make(null),
      diningCallerFor: (userId: string) => (state.signedIn.has(userId) ? make(userId) : null),
      diningLoginFor: (userId: string) => make(userId),
    },
  };
}

let sim: Simulator;
let gh: ReturnType<typeof fakeGrubhub>;
let conversationId = "";

async function start(env: Record<string, string> = GRUBHUB_ENV, model?: FakeModelClient) {
  gh = fakeGrubhub();
  sim = await makeSim({ env, overrides: gh.overrides, ...(model ? { model } : {}) });
}

afterEach(async () => {
  await sim.c.close();
});

const task = async () => (await sim.c.tasks.findActive<GroupMealState>(conversationId, "group_meal"))!;
const groupTexts = () => sim.c.fakes.messaging!.to(GROUP).map((m) => m.text);
const lastGroup = (t: { sent: Array<{ kind: string; text: string }> }) =>
  t.sent.filter((m) => m.kind === "group").at(-1)!.text;
const accountCalls = (tool: string) => gh.state.calls.filter((c) => c.tool === tool);

/** Avery asks, Casey confirms the restaurant: the order is quoted and posted for share 👍s. */
async function planAndConfirm() {
  const ask = await sim.group(
    GROUP,
    AVERY.externalId,
    ALL_MEMBERS,
    "@agent order taco bell for dinner? under $20 each",
  );
  conversationId = ask.outcomes[0]!.conversationId!;
  expect(lastGroup(ask)).toMatch(/^Proposal: Taco Bell/);
  return sim.group(GROUP, CASEY.externalId, ALL_MEMBERS, "@agent confirm");
}

let seq = 0;
function react(from: string, type: "like" | "dislike", targetMessageId: string) {
  const msg: InboundMessage = {
    platform: "imessage",
    providerMessageId: `react-${++seq}`,
    providerConversationId: GROUP,
    senderExternalId: from,
    participantExternalIds: ALL_MEMBERS,
    isGroup: true,
    text: "",
    timestamp: new Date().toISOString(),
    reaction: { type, targetMessageId, removed: false },
  };
  return sim.push(msg);
}

/** Blake and Casey 👍 the order message: Avery is asked to pay. */
async function everyoneAgrees() {
  const id = (await task()).state.order!.confirmations!.messageId!;
  await react(BLAKE.externalId, "like", id);
  return react(CASEY.externalId, "like", id);
}

describe("group order: the requester pays on their own Grubhub account", () => {
  it("wires Grubhub as the dining provider", async () => {
    await start();
    expect(sim.c.wiring.dining).toBe("real");
  });

  it("quotes the cart on the requester's account and asks everyone else to agree to their share first", async () => {
    await start();
    const confirm = await planAndConfirm();
    const t = await task();
    const o = t.state.order!;
    expect(t.status).toBe("awaiting_confirmations");
    expect(o.payerUserId).toBe(AVERY.userId); // she asked; Casey only confirmed the restaurant
    expect(o.quote).toMatchObject({ provider: "grubhub", totalMinor: o.totalMinor });
    // The cart lives on Avery's own account; search and menus use the shared session.
    expect(new Set(accountCalls("cart_new").map((c) => c.user))).toEqual(new Set([AVERY.userId]));
    expect(accountCalls("search_restaurants").every((c) => c.user === null)).toBe(true);
    expect([...o.confirmations!.needed].sort()).toEqual([BLAKE.userId, CASEY.userId].sort());
    expect(o.confirmations!.confirmed).toEqual([]);
    const text = lastGroup(confirm);
    expect(text).toContain(`Total $${(o.totalMinor / 100).toFixed(2)} with tax and fees. Avery is paying.`);
    expect(text).toMatch(
      /Blake owes Avery \$[\d.]+, Casey owes Avery \$[\d.]+|Casey owes Avery \$[\d.]+, Blake owes Avery/,
    );
    expect(text).toMatch(/👍 this message to agree to your share/);
    expect(o.confirmations!.messageId).toBe(confirm.sent.filter((m) => m.kind === "group").at(-1)!.messageId);
    // Nobody is asked to pay before everyone agrees.
    expect(confirm.sent.some((m) => m.kind === "dm")).toBe(false);
  });

  it("each share holder's 👍 on exactly the order message counts once; the payer's own 👍 doesn't", async () => {
    await start();
    await planAndConfirm();
    const id = (await task()).state.order!.confirmations!.messageId!;
    await react(AVERY.externalId, "like", id); // payer: nothing to agree to
    await react(BLAKE.externalId, "like", "some-other-message");
    expect((await task()).state.order!.confirmations!.confirmed).toEqual([]);

    const blake = await react(BLAKE.externalId, "like", id);
    expect(blake.sent.map((m) => m.text)).toEqual(["Blake is in. Still waiting on Casey."]);
    const again = await react(BLAKE.externalId, "like", id);
    expect(again.sent).toEqual([]);
    expect((await task()).state.order!.confirmations!.confirmed).toEqual([BLAKE.userId]);

    const casey = await react(CASEY.externalId, "like", id);
    const t = await task();
    expect(t.status).toBe("awaiting_payment");
    expect(lastGroup(casey)).toMatch(/^Everyone's in\. Avery, I sent you a private link to approve \$/);
    const dm = casey.sent.find((m) => m.kind === "dm")!;
    expect(dm.to).toBe(AVERY.externalId);
    expect(dm.text).toContain(`/approve/${t.state.order!.approvalId}`);
  });

  it("a share holder can agree by text instead of 👍", async () => {
    await start();
    await planAndConfirm();
    const blake = await sim.group(GROUP, BLAKE.externalId, ALL_MEMBERS, "@agent confirm");
    expect(lastGroup(blake)).toBe("Blake is in. Still waiting on Casey.");
    const avery = await sim.group(GROUP, AVERY.externalId, ALL_MEMBERS, "@agent confirm");
    expect(lastGroup(avery)).toMatch(/^You're paying, so there's nothing for you to agree to/);
    await sim.group(GROUP, CASEY.externalId, ALL_MEMBERS, "@agent confirm");
    expect((await task()).status).toBe("awaiting_payment");
  });

  it("a 👎 from someone with a share cancels the order; nobody is asked to pay", async () => {
    await start();
    await planAndConfirm();
    const id = (await task()).state.order!.confirmations!.messageId!;
    const no = await react(CASEY.externalId, "dislike", id);
    expect(lastGroup(no)).toBe(
      "Casey turned down their share, so I cancelled the order. Nothing was ordered.",
    );
    expect(await sim.c.tasks.findActive(conversationId, "group_meal")).toBeNull();
    expect(sim.c.fakes.approvals!.approvals.filter((a) => a.kind === "spend_handoff")).toEqual([]);
  });

  it("checkout off (the default): only the payer can approve, and it fails closed — nothing charged", async () => {
    await start();
    await planAndConfirm();
    await everyoneAgrees();
    const o = (await task()).state.order!;
    expect((await sim.c.orders.approveAndPlace(o.approvalId!, CASEY.userId)).status).toBe("forbidden");
    const r = await sim.c.orders.approveAndPlace(o.approvalId!, AVERY.userId);
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/isn't switched on yet.*wasn't placed\. Nothing was charged/);
    expect(accountCalls("cart_checkout")).toEqual([]);
    expect(accountCalls("get_payment_methods")).toEqual([]);
    expect(groupTexts().some((t) => t.startsWith("Order placed"))).toBe(false);
  });

  it("checkout on: pays with the payer's plain saved card, DMs each person their share, tracks on the payer's account", async () => {
    await start(CHECKOUT_ON);
    await planAndConfirm();
    await everyoneAgrees();
    const { id: taskId, state } = await task();
    const o = state.order!;
    const before = sim.c.fakes.messaging!.sent.length;
    const r = await sim.c.orders.approveAndPlace(o.approvalId!, AVERY.userId);
    expect(r).toMatchObject({ status: "placed", orderId: "GH-777" });
    // Apple Pay is the default but can't be used: the saved Visa is, on Avery's own account.
    expect(accountCalls("cart_add_payment")).toEqual([
      {
        user: AVERY.userId,
        tool: "cart_add_payment",
        args: {
          cart_id: o.quote!.cartId,
          payment_id: "pm-visa",
          payment_type: "CREDIT_CARD",
          amount_cents: o.totalMinor,
        },
      },
    ]);
    expect(accountCalls("cart_checkout").map((c) => c.user)).toEqual([AVERY.userId]);

    const sent = sim.c.fakes.messaging!.sent.slice(before);
    expect(sent.find((m) => m.kind === "group")!.text).toMatch(
      /^Order placed with Taco Bell on Grubhub: \$[\d.]+, paid by Avery/,
    );
    const dms = sent.filter((m) => m.kind === "dm");
    expect(dms.map((m) => m.to).sort()).toEqual([BLAKE.externalId, CASEY.externalId].sort());
    for (const s of o.splits) {
      const dm = dms.find((m) => m.to === (s.userId === BLAKE.userId ? BLAKE.externalId : CASEY.externalId))!;
      expect(dm.text).toMatch(
        new RegExp(
          `^Your share of the Taco Bell order is \\$${(s.owesMinor / 100).toFixed(2)} \\(.+\\)\\. Pay Avery back\\.$`,
        ),
      );
    }

    for (let i = 0; i < 3; i++) await sim.c.orders.trackOrders();
    expect(accountCalls("track_order").every((c) => c.user === AVERY.userId)).toBe(true);
    const updates = groupTexts();
    expect(updates).toContain("Taco Bell is preparing the order.");
    expect(updates).toContain("The food is on the way (about 9 min).");
    expect(updates.at(-1)).toMatch(/^Delivered\. Enjoy! Split: .*owes Avery/);
    expect((await sim.c.tasks.get(taskId))!.status).toBe("completed");
  });

  it("checkout that can't be confirmed (timeout) → needs reconciliation, never 'ordered'", async () => {
    await start(CHECKOUT_ON);
    gh.state.checkout = () => {
      throw new Error("timed out");
    };
    await planAndConfirm();
    await everyoneAgrees();
    const t = await task();
    const r = await sim.c.orders.approveAndPlace(t.state.order!.approvalId!, AVERY.userId);
    expect(r.status).toBe("unknown_outcome");
    expect((await sim.c.tasks.get(t.id))!.status).toBe("needs_reconciliation");
    expect(groupTexts().at(-1)).toMatch(/couldn't confirm it went through\. Check the app/);
    expect(groupTexts().some((x) => x.startsWith("Order placed"))).toBe(false);
  });

  it("the requester has no Grubhub account → the group is told; nothing is quoted or charged", async () => {
    await start();
    gh.state.signedIn.delete(AVERY.userId);
    const confirm = await planAndConfirm();
    expect(lastGroup(confirm)).toContain(
      "Avery needs to connect a Grubhub account before I can order on it. Nothing was ordered.",
    );
    expect(accountCalls("cart_new")).toEqual([]);
    // The only DM is the sign-in ask to Avery; no payment link to anyone.
    const dms = confirm.sent.filter((m) => m.kind === "dm");
    expect(dms.map((m) => m.to)).toEqual([AVERY.externalId]);
    expect(dms[0]!.text).not.toMatch(/approve/);
  });

  it("refuses to place the order if the provider's total changed after everyone agreed", async () => {
    await start(CHECKOUT_ON);
    await planAndConfirm();
    await everyoneAgrees();
    const o = (await task()).state.order!;
    gh.state.totalOverride = o.quote!.totalMinor + 150;
    const r = await sim.c.orders.approveAndPlace(o.approvalId!, AVERY.userId);
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/changed the total to \$/);
    expect(accountCalls("cart_checkout")).toEqual([]);
  });

  it("never asks anyone to agree or pay when the provider gives no final total", async () => {
    await start();
    gh.state.noTotal = true;
    const confirm = await planAndConfirm();
    expect(lastGroup(confirm)).toContain("didn't give me the final total");
    expect(confirm.sent.some((m) => m.kind === "dm")).toBe(false);
  });
});

describe("personal order (1:1 chat) on the person's own account", () => {
  /** Scripted agent: search → menu → quote → tell the total; "place it" → submit_order. */
  const agent = () =>
    new FakeModelClient((req: ModelRequest) => {
      const text = lastMessageText(req);
      const results =
        req.messages
          .map((m) => m.content)
          .join("\n")
          .split("<tool_result").length - 1;
      const call = (tool: string, args: unknown) => ({
        proposals: [{ kind: "tool_call", tool, argsJson: JSON.stringify(args), rationale: null }],
      });
      const say = (t: string) => ({ proposals: [{ kind: "reply", text: t }] });
      if (/place it/i.test(text)) {
        const cart = gh.state.lastCart;
        const total = gh.state.carts.get(cart)!.subtotal + FEES_AND_TAX;
        return results === 0
          ? call("dining__submit_order", { cartId: cart, approvedTotalMinor: total })
          : say("I sent you a private link to approve it.");
      }
      if (results === 0) return call("dining__search_options", { query: "taco bell" });
      if (results === 1) return call("dining__get_menu", { optionId: "gh_926742" });
      if (results === 2)
        return call("dining__quote_order", { optionId: "gh_926742", items: [{ itemId: "11", quantity: 2 }] });
      return say("That's $8.10 with tax and fees. Want me to place it?");
    });

  it("quote → 'place it' → the person approves on the page → placed with their card; updates in their DM", async () => {
    await start(CHECKOUT_ON, agent());
    await sim.dm(BLAKE.externalId, "get me two bean burritos from taco bell");
    expect(accountCalls("cart_new").map((c) => c.user)).toEqual([BLAKE.userId]);

    const yes = await sim.dm(BLAKE.externalId, "yes place it");
    const prompt = yes.sent.find((m) => /\/approve\//.test(m.text))!;
    expect(prompt.to).toBe(BLAKE.externalId);
    const approvalId = /\/approve\/([0-9a-f-]{36})/.exec(prompt.text)![1]!;

    const pending = (await sim.c.orders.findByApproval(approvalId)) as {
      type: string;
      state: PersonalMealState;
    };
    expect(pending.type).toBe("personal_meal");
    expect(pending.state.order).toMatchObject({
      restaurant: "Taco Bell",
      payerUserId: BLAKE.userId,
      totalMinor: 2 * 199 + FEES_AND_TAX,
      splits: [],
      lines: [{ userId: BLAKE.userId, items: [{ itemId: "11", name: "Bean Burrito", quantity: 2 }] }],
      delivery: { providerConversationId: BLAKE.externalId, dm: true },
    });
    expect(accountCalls("cart_checkout")).toEqual([]); // nothing placed before the approval

    expect((await sim.c.orders.approveAndPlace(approvalId, AVERY.userId)).status).toBe("forbidden");
    const before = sim.c.fakes.messaging!.sent.length;
    expect(await sim.c.orders.approveAndPlace(approvalId, BLAKE.userId)).toMatchObject({ status: "placed" });
    expect(accountCalls("cart_checkout").map((c) => c.user)).toEqual([BLAKE.userId]);
    await sim.c.orders.trackOrders();
    const sent = sim.c.fakes.messaging!.sent.slice(before);
    expect(sent.every((m) => m.kind === "dm" && m.to === BLAKE.externalId)).toBe(true);
    expect(sent.map((m) => m.text)).toEqual([
      "Order placed with Taco Bell on Grubhub: $8.10, paid with the card on your Grubhub account. I'll text you updates.",
      "Taco Bell is preparing the order.",
    ]);
    expect(accountCalls("track_order").map((c) => c.user)).toEqual([BLAKE.userId]);
  });
});

describe("connecting your own Grubhub account from your 1:1 chat", () => {
  const dmTo = (t: { sent: Array<{ kind: string; to: string; text: string }> }, who: string) =>
    t.sent.filter((m) => m.kind === "dm" && m.to === who).map((m) => m.text);

  it("'connect grubhub' → email → emailed code → connected; no model call, nothing remembered", async () => {
    await start();
    gh.state.signedIn.delete(BLAKE.userId);
    const ask = await sim.dm(BLAKE.externalId, "can you connect my grubhub account?");
    expect(dmTo(ask, BLAKE.externalId)[0]).toMatch(
      /reply here with the email you use for Grubhub.*never need your password/,
    );

    const email = await sim.dm(BLAKE.externalId, "blake.k@example.com");
    expect(dmTo(email, BLAKE.externalId)).toEqual([
      "Grubhub just emailed a sign-in code to blake.k@example.com. Reply here with the code.",
    ]);
    expect(accountCalls("send_login_otp")).toEqual([
      { user: BLAKE.userId, tool: "send_login_otp", args: { email: "blake.k@example.com" } },
    ]);

    const wrong = await sim.dm(BLAKE.externalId, "000000");
    expect(dmTo(wrong, BLAKE.externalId)[0]).toMatch(/^That code didn't work/);
    const ok = await sim.dm(BLAKE.externalId, "123 456");
    expect(dmTo(ok, BLAKE.externalId)[0]).toMatch(/^Connected! Your Grubhub account is linked/);
    expect(gh.state.signedIn.has(BLAKE.userId)).toBe(true);
    expect(accountCalls("verify_login_otp").at(-1)).toMatchObject({
      user: BLAKE.userId,
      args: { email: "blake.k@example.com", code: "123456" },
    });

    // The email and code never reached the model or memory.
    expect(sim.c.fakes.model!.allPromptText()).not.toMatch(/blake\.k@example\.com|123 ?456/);
    expect(JSON.stringify(sim.c.fakes.memoryStore!.writes)).not.toMatch(/blake\.k@example\.com/);
    // The finished sign-in forgets the email.
    const tasks = await sim.c.tasks.listByStatus("dining_account_link", ["connected"]);
    expect(tasks.map((t) => t.state)).toEqual([{}]);
  });

  it("email in the first message; warns when there's no usable saved card", async () => {
    await start();
    gh.state.signedIn.delete(BLAKE.userId);
    gh.state.hasCard = false;
    const t = await sim.dm(BLAKE.externalId, "connect grubhub, it's blake.k@example.com");
    expect(dmTo(t, BLAKE.externalId)[0]).toMatch(/^Grubhub just emailed a sign-in code/);
    const ok = await sim.dm(BLAKE.externalId, "123456");
    expect(dmTo(ok, BLAKE.externalId)[0]).toMatch(/don't see a credit or debit card saved on it/);
  });

  it("a refused email, 'cancel', and three wrong codes all end safely", async () => {
    await start();
    gh.state.signedIn.delete(BLAKE.userId);
    await sim.dm(BLAKE.externalId, "link my grubhub");
    const bad = await sim.dm(BLAKE.externalId, "nobody@example.com");
    expect(dmTo(bad, BLAKE.externalId)[0]).toMatch(/^Grubhub didn't accept that email/);
    const cancel = await sim.dm(BLAKE.externalId, "cancel");
    expect(dmTo(cancel, BLAKE.externalId)).toEqual(["Okay, I won't connect Grubhub."]);

    await sim.dm(BLAKE.externalId, "connect grubhub blake.k@example.com");
    await sim.dm(BLAKE.externalId, "111111");
    await sim.dm(BLAKE.externalId, "222222");
    const third = await sim.dm(BLAKE.externalId, "333333");
    expect(dmTo(third, BLAKE.externalId)[0]).toMatch(
      /so I stopped\. Text me "connect grubhub" to start over/,
    );
    expect(gh.state.signedIn.has(BLAKE.userId)).toBe(false);
    // Afterwards a number is just a message for the agent again.
    const after = await sim.dm(BLAKE.externalId, "123456");
    expect(after.outcomes[0]!.detail).not.toEqual({ intent: "account_link" });
  });

  it("group order whose payer isn't connected: the payer is asked privately, connects, and can order", async () => {
    await start();
    gh.state.signedIn.delete(AVERY.userId);
    const confirm = await planAndConfirm();
    expect(lastGroup(confirm)).toMatch(/Avery needs to connect a Grubhub account.*Avery, I texted you how/);
    expect(dmTo(confirm, AVERY.externalId)[0]).toMatch(/reply here with the email you use for Grubhub/);

    await sim.dm(AVERY.externalId, "avery@example.com");
    const ok = await sim.dm(AVERY.externalId, "123456");
    expect(dmTo(ok, AVERY.externalId)[0]).toMatch(/^Connected!/);

    await planAndConfirm();
    expect((await task()).status).toBe("awaiting_confirmations");
    expect(accountCalls("cart_new").map((c) => c.user)).toEqual([AVERY.userId]);
  });
});
