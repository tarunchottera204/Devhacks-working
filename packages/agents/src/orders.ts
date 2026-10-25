import {
  type AgentTask,
  type AuditLog,
  type Clock,
  type GroupMealState,
  type IdentityService,
  type Logger,
  type MealOrder,
  type MessagingAdapter,
  type PersonalMealState,
  type Platform,
  type TaskStore,
  type ToolGateway,
  type TurnContext,
  groupAgentId,
  newId,
  personalAgentId,
} from "@campus/contracts";
import { z } from "zod";
import { formatMoney } from "./prompts";

// Real food orders after the payer approves (P2 contribution; P4's approval logic will replace the
// fake approval call). Two kinds, both paid on the payer's OWN provider account:
//   - group_meal: the person who asked pays; everyone else agreed to their share in the group first.
//   - personal_meal: someone orders for themselves in their 1:1 chat.
// Everything goes through the tool gateway:
//   - approveAndPlace: the payer approved the exact quote on the authenticated web page → the gateway
//     runs exactly the approved submit_order (it re-checks the provider total) → post the outcome;
//     for a group, DM each person what they owe the payer.
//   - trackOrders: poll the provider's delivery status and post changes to the same chat.
// Honesty rule: only say "ordered" when the provider returned an order id; unknown outcomes are
// marked needs_reconciliation (never retried blindly).

type Task = AgentTask<GroupMealState> | AgentTask<PersonalMealState>;
type Order = MealOrder;

export type WebApprovals = { approveFromWeb?(approvalId: string, userId: string): boolean };

/** A quoted cart as the dining provider describes it (in memory on the provider side). */
export type QuotedCart = {
  cartId: string;
  userId: string;
  restaurant: string;
  currency: string;
  items: Array<{ itemId: string; name: string; quantity: number; priceMinor: number }>;
  subtotalMinor: number;
  taxMinor: number | null;
  feesMinor: number | null;
  tipMinor: number;
  totalMinor: number | null;
};

export type OrderServiceDeps = {
  tasks: TaskStore;
  gateway: ToolGateway;
  messaging: MessagingAdapter;
  /** Marks a spend approval approved from the web page (fake today; P4's ApprovalService later). */
  approvals: WebApprovals;
  /** Names and 1:1 addresses (split DMs, personal orders). */
  identity: Pick<IdentityService, "getPrimaryExternalId" | "getUser">;
  audit: AuditLog;
  clock: Clock;
  logger: Logger;
  /** Namespaced tools, e.g. "dining__order_status". */
  statusTool: string;
  /** The provider's quoted cart, for personal orders (absent with test data). */
  describeCart?: (cartId: string) => QuotedCart | null;
};

const GROUP = "group_meal";
const PERSONAL = "personal_meal";
const TYPES = [GROUP, PERSONAL] as const;
const SubmitArgsSchema = z.object({ cartId: z.string().min(1), approvedTotalMinor: z.number().int() });
const SubmitResultSchema = z.object({
  placed: z.boolean(),
  orderId: z.string().optional(),
  reason: z.string().optional(),
  currentTotalMinor: z.number().nullable().optional(),
  outcomeUnknown: z.boolean().optional(),
});
const StatusSchema = z.object({
  status: z.enum(["placed", "preparing", "on_the_way", "delivered", "cancelled", "unknown"]),
  etaMinutes: z.number().nullable().optional(),
});

export type PlaceResult =
  | { status: "placed"; orderId: string; message: string }
  | { status: "not_found" | "forbidden" | "failed" | "unknown_outcome"; message: string };

const UNKNOWN = "Couldn't confirm the order. Check the ordering app before trying again.";

export class OrderService {
  constructor(private readonly deps: OrderServiceDeps) {}

  /** The open order (group or personal) waiting on this approval (for the approval page). */
  async findByApproval(approvalId: string): Promise<Task | null> {
    for (const type of TYPES) {
      const open = await this.deps.tasks.listByStatus<GroupMealState>(type, ["awaiting_payment"]);
      const hit = open.find((t) => t.state.order?.approvalId === approvalId);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * A personal agent proposed submit_order in someone's 1:1 chat and the gateway asked them to
   * approve it: remember the order so the approval page can show it and place it. Only for a cart
   * quoted on their own account at exactly the amount being approved. Returns whether it was recorded.
   */
  async recordPersonalOrder(ctx: TurnContext, approvalId: string, args: unknown): Promise<boolean> {
    const d = this.deps;
    const a = SubmitArgsSchema.safeParse(args);
    const cart = a.success ? (d.describeCart?.(a.data.cartId) ?? null) : null;
    if (!a.success || !cart || cart.userId !== ctx.userId || cart.totalMinor !== a.data.approvedTotalMinor) {
      d.logger.warn("personal order not recorded: no matching quote", { turnId: ctx.turnId });
      return false;
    }
    // A newer order replaces one still waiting for payment.
    const older = await d.tasks.listByStatus<PersonalMealState>(PERSONAL, ["awaiting_payment"]);
    for (const t of older.filter((t) => t.ownerId === ctx.userId))
      await d.tasks.update(t.id, { status: "cancelled" }, t.version).catch(() => undefined);

    const name = (await d.identity.getUser(ctx.userId))?.displayName ?? null;
    const order: Order = {
      restaurant: cart.restaurant,
      currency: cart.currency,
      lines: [
        {
          userId: ctx.userId,
          name,
          items: cart.items,
          subtotalMinor: cart.items.reduce((n, i) => n + i.priceMinor * i.quantity, 0),
        },
      ],
      notIncluded: [],
      totalMinor: cart.totalMinor,
      payerUserId: ctx.userId,
      payerName: name,
      splits: [],
      quote: {
        provider: "grubhub",
        cartId: cart.cartId,
        totalMinor: cart.totalMinor,
        subtotalMinor: cart.subtotalMinor,
        taxMinor: cart.taxMinor,
        feesMinor: cart.feesMinor,
        tipMinor: cart.tipMinor,
      },
      approvalId,
      delivery: { platform: ctx.platform, providerConversationId: ctx.providerConversationId, dm: true },
    };
    const task = await d.tasks.create<PersonalMealState>({
      ownerType: "user",
      ownerId: ctx.userId,
      conversationId: ctx.conversationId,
      type: PERSONAL,
      status: "awaiting_payment",
      state: { userId: ctx.userId, order },
    });
    await d.audit.record({
      action: "task.created",
      turnId: ctx.turnId,
      conversationId: ctx.conversationId,
      actorUserId: ctx.userId,
      detail: { taskId: task.id, type: PERSONAL },
    });
    return true;
  }

  async approveAndPlace(approvalId: string, userId: string): Promise<PlaceResult> {
    const d = this.deps;
    const task = await this.findByApproval(approvalId);
    const order = task?.state.order;
    if (!task || !order?.quote || !order.delivery)
      return { status: "not_found", message: "This order isn't waiting for payment." };
    if (order.payerUserId !== userId)
      return { status: "forbidden", message: "Only the payer can approve this order." };
    if (d.approvals.approveFromWeb && !d.approvals.approveFromWeb(approvalId, userId))
      return {
        status: "failed",
        message: `This approval expired or was already used. ${order.delivery.dm ? "Ask me to order again." : "Ask in the group to plan again."}`,
      };

    const ctx = this.systemContext(task, order, userId);
    const outcome = await d.gateway.executeApproved(ctx, approvalId);
    if (outcome.status === "error") return this.unknownOutcome(task, order);
    if (outcome.status !== "executed" || !outcome.result.ok) {
      const reason =
        outcome.status === "executed"
          ? (outcome.result.errorCode ?? "provider_error")
          : "reasonCode" in outcome
            ? outcome.reasonCode
            : outcome.status;
      await this.audit(task, "order.failed", { reason });
      return { status: "failed", message: `The order wasn't placed (${reason}). Nothing was charged.` };
    }
    const r = SubmitResultSchema.safeParse(outcome.result.data); // provider output is untrusted data
    if (!r.success || !r.data.placed || !r.data.orderId) {
      if (r.success && r.data.outcomeUnknown) return this.unknownOutcome(task, order);
      await this.update(task, "failed", order);
      const msg = this.notPlacedMessage(order, r.success ? r.data : null);
      await this.post(order, msg);
      await this.audit(task, "order.failed", {
        reason: r.success ? (r.data.reason ?? "not_placed") : "invalid_result",
      });
      return { status: "failed", message: msg };
    }

    const placedAt = d.clock.now().toISOString();
    const next: Order = { ...order, providerOrderId: r.data.orderId, trackingStatus: "placed", placedAt };
    await this.update(task, "ordered", next);
    await this.audit(task, "order.placed", {
      totalMinor: order.quote.totalMinor,
      provider: order.quote.provider,
    });
    const money = formatMoney(order.quote.totalMinor, order.currency);
    const where = providerName(order.quote.provider);
    await this.post(
      next,
      order.delivery.dm
        ? `Order placed with ${order.restaurant} on ${where}: ${money}, paid with the card on your ${where} account. I'll text you updates.`
        : `Order placed with ${order.restaurant} on ${where}: ${money}, paid by ${this.payerName(order)}. I'll post updates here.`,
    );
    if (!order.delivery.dm) await this.sendSplits(task, next);
    return {
      status: "placed",
      orderId: r.data.orderId,
      message: order.delivery.dm
        ? "Order placed. I'll text you updates."
        : "Order placed. Updates will show up in the group chat.",
    };
  }

  /** Worker job: post delivery updates for placed orders. Never throws. */
  async trackOrders(): Promise<{ checked: number; updated: number }> {
    const d = this.deps;
    const open: Task[] = [];
    for (const type of TYPES) open.push(...(await d.tasks.listByStatus<GroupMealState>(type, ["ordered"])));
    let updated = 0;
    for (const task of open) {
      const order = task.state.order;
      if (!order?.providerOrderId || !order.delivery) continue;
      try {
        const [server, tool] = d.statusTool.split("__") as [string, string];
        // The order is on the payer's own account.
        const outcome = await d.gateway.propose(this.systemContext(task, order, order.payerUserId), {
          proposalId: newId(),
          server,
          tool,
          args: { orderId: order.providerOrderId },
        });
        if (outcome.status !== "executed" || !outcome.result.ok) continue;
        const s = StatusSchema.safeParse(outcome.result.data);
        if (!s.success || s.data.status === "unknown" || s.data.status === order.trackingStatus) continue;
        const next: Order = { ...order, trackingStatus: s.data.status };
        const done = s.data.status === "delivered" || s.data.status === "cancelled";
        await this.update(task, done ? "completed" : "ordered", next);
        await this.post(
          next,
          statusLine(next, s.data.status, s.data.etaMinutes ?? null, this.payerName(order)),
        );
        await this.audit(task, "order.status", { status: s.data.status });
        updated += 1;
      } catch (err) {
        d.logger.warn("order tracking failed", { taskId: task.id, err });
      }
    }
    return { checked: open.length, updated };
  }

  /** After a group order is placed: DM each person what they owe the payer. Never throws. */
  private async sendSplits(task: Task, order: Order): Promise<void> {
    const d = this.deps;
    const payer = this.payerName(order);
    let sent = 0;
    for (const s of order.splits) {
      try {
        const to = await d.identity.getPrimaryExternalId(s.userId, order.delivery!.platform as Platform);
        if (!to) continue;
        const items = order.lines
          .find((l) => l.userId === s.userId)
          ?.items.map((i) => `${i.quantity > 1 ? `${i.quantity}x ` : ""}${i.name}`)
          .join(", ");
        await d.messaging.sendDM(
          to,
          `Your share of the ${order.restaurant} order is ${formatMoney(s.owesMinor, order.currency)}${items ? ` (${items})` : ""}. Pay ${payer} back.`,
        );
        sent += 1;
      } catch (err) {
        d.logger.warn("split DM failed", { taskId: task.id, err });
      }
    }
    await this.audit(task, "order.split_sent", { sent, people: order.splits.length });
  }

  private async unknownOutcome(task: Task, order: Order): Promise<PlaceResult> {
    await this.update(task, "needs_reconciliation", order);
    await this.post(
      order,
      `I sent the order to ${order.restaurant}, but couldn't confirm it went through. Check the app before trying again.`,
    );
    await this.audit(task, "order.failed", { reason: "outcome_unknown" });
    return { status: "unknown_outcome", message: UNKNOWN };
  }

  private notPlacedMessage(order: Order, r: z.infer<typeof SubmitResultSchema> | null): string {
    const where = providerName(order.quote?.provider ?? "");
    const account = order.delivery?.dm
      ? `your ${where} account`
      : `${this.payerName(order)}'s ${where} account`;
    const nothing = "Nothing was charged.";
    switch (r?.reason) {
      case "total_changed":
        return `${order.restaurant} changed the total${r.currentTotalMinor ? ` to ${formatMoney(r.currentTotalMinor, order.currency)}` : ""}, so I didn't place the order. ${order.delivery?.dm ? "Ask me again" : "Ask me to plan again"} for a fresh quote.`;
      case "checkout_not_available":
        return `Placing orders on ${where} isn't switched on yet, so the order at ${order.restaurant} wasn't placed. ${nothing}`;
      case "no_saved_card":
        return `There's no saved card I can use on ${account} (Apple Pay and wallets don't work here; add a credit or debit card in the ${where} app). The order wasn't placed. ${nothing}`;
      case "account_not_connected":
        return `${account[0]!.toUpperCase()}${account.slice(1)} isn't connected, so the order wasn't placed. ${nothing}`;
      case "payment_rejected":
        return `${where} didn't accept the saved card on ${account}, so the order wasn't placed. ${nothing}`;
      case "checkout_rejected":
        return `${where} turned the order down at checkout, so it wasn't placed. ${nothing}`;
      case "not_your_cart":
        return `That order was quoted on someone else's account, so I didn't place it. ${nothing}`;
      default:
        return `The order at ${order.restaurant} wasn't placed. ${nothing}`;
    }
  }

  private payerName(order: Order): string {
    return order.lines.find((l) => l.userId === order.payerUserId)?.name ?? order.payerName ?? "the payer";
  }

  /** A turn context for work started outside a chat turn (the payer's web approval, the tracker). */
  private systemContext(task: Task, order: Order, userId: string): TurnContext {
    const now = this.deps.clock.now();
    const dm = !!order.delivery!.dm;
    return {
      turnId: newId(),
      platform: order.delivery!.platform as Platform,
      conversationId: task.conversationId!,
      conversationType: dm ? "dm" : "group",
      providerConversationId: order.delivery!.providerConversationId,
      providerMessageId: "",
      userId,
      externalIdentityId: "",
      agent: dm
        ? { kind: "personal", id: personalAgentId(userId) }
        : { kind: "group", id: groupAgentId(task.conversationId!) },
      // Least authority: never "user_dm" (that alone may change permissions).
      provenance: "group_message",
      receivedAt: now.toISOString(),
      deadlineMs: now.getTime() + 60_000,
    };
  }

  private async update(task: Task, status: string, order: Order): Promise<void> {
    const fresh = (await this.deps.tasks.get<GroupMealState>(task.id))!;
    await this.deps.tasks.update(task.id, { status, state: { ...fresh.state, order } }, fresh.version);
  }

  private async post(order: Order, text: string): Promise<void> {
    if (!order.delivery) return;
    const to = order.delivery.providerConversationId;
    await (order.delivery.dm ? this.deps.messaging.sendDM(to, text) : this.deps.messaging.sendGroup(to, text))
      .then(() => undefined)
      .catch((err) => this.deps.logger.warn("order update send failed", { err }));
  }

  private audit(
    task: Task,
    action: "order.placed" | "order.failed" | "order.status" | "order.split_sent",
    detail: Record<string, unknown>,
  ) {
    return this.deps.audit.record({
      action,
      conversationId: task.conversationId,
      actorUserId: task.state.order?.payerUserId ?? null,
      detail: { taskId: task.id, type: task.type, ...detail },
    });
  }
}

const providerName = (p: string) => (p === "grubhub" ? "Grubhub" : p || "the app");

function statusLine(order: Order, status: string, eta: number | null, payer: string): string {
  switch (status) {
    case "preparing":
      return `${order.restaurant} is preparing the order.`;
    case "on_the_way":
      return `The food is on the way${eta ? ` (about ${eta} min)` : ""}.`;
    case "delivered": {
      const split = order.splits.length
        ? ` Split: ${order.splits.map((s) => `${s.name ?? "someone"} owes ${payer} ${formatMoney(s.owesMinor, order.currency)}`).join(", ")}.`
        : "";
      return `Delivered. Enjoy!${split}`;
    }
    case "cancelled":
      return `${order.restaurant} cancelled the order. Check the app for the refund.`;
    default:
      return `Order update: ${status}.`;
  }
}
