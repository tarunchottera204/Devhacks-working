import {
  type AgentRuntime,
  type AgentTask,
  type AgentTurnInput,
  type AgentTurnResult,
  type ApprovalService,
  type AuditLog,
  ChooseItemsAnswerSchema,
  type Clock,
  type ContextBroker,
  type CoordinationBus,
  type Coordinator,
  type DataBlock,
  type GroupAgent,
  type GroupAgentFactory,
  type GroupMealParams,
  type GroupMealState,
  type Logger,
  type MealOption,
  MealOptionSchema,
  MenuItemSchema,
  type MemoryCandidate,
  type MemoryStore,
  type MembershipService,
  type OptionVerdicts,
  type TaskIntent,
  type TaskStore,
  type TurnContext,
  type TurnIO,
  groupAgentId,
  personalAgentId,
} from "@campus/contracts";
import { z } from "zod";
import { counterofferCeiling } from "./coordinator";
import { formatHistory, formatMoney, groupSystemPrompt } from "./prompts";

// GroupAgent(conversationId): shared context + task state (spec 4.1, 4.6). It never reads any user's
// private memory; it asks personal agents through the bus and receives projections only.

export type GroupAgentDeps = {
  runtime: AgentRuntime;
  tasks: TaskStore;
  membership: MembershipService;
  coordinator: Coordinator;
  bus: CoordinationBus;
  broker: ContextBroker;
  memoryStore: MemoryStore;
  approvals: ApprovalService;
  audit: AuditLog;
  logger: Logger;
  clock: Clock;
  agentName: string;
  /** How members address the agent, e.g. "@agent" (first configured invocation name). */
  invocationHint: string;
  /** Namespaced tool that returns `{ options: MealOption[] }`. */
  optionsTool: string;
  coordinationTtlMs?: number;
  maxRounds?: number;
};

const TASK_TYPE = "group_meal";
const ToolOptionsSchema = z.object({ options: z.array(MealOptionSchema) });
const ToolMenuSchema = z.object({ restaurant: z.string().optional(), items: z.array(MenuItemSchema) });
const ToolQuoteSchema = z.object({
  provider: z.string().default("provider"),
  cartId: z.string().min(1),
  totalMinor: z.number().int().positive().nullable(),
  subtotalMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nullable().optional(),
  feesMinor: z.number().int().nullable().optional(),
  tipMinor: z.number().int().nonnegative().default(0),
});
const ToolErrorSchema = z.object({ error: z.string() });
type GroupOrder = NonNullable<GroupMealState["order"]>;
type Task = AgentTask<GroupMealState>;

/** Statuses in which a new plan can't start: say "cancel" first. */
const OPEN_STATUSES = ["collecting", "proposed", "awaiting_confirmations", "awaiting_payment"];

/**
 * The same turn, acting for the payer: the cart is built on their own provider account and the
 * spend approval goes to their 1:1 chat, whoever's message moved the order along.
 */
const asPayer = (ctx: TurnContext, payerUserId: string): TurnContext => ({ ...ctx, userId: payerUserId });

export class GroupAgentImpl implements GroupAgent {
  readonly agentId: string;

  constructor(
    readonly conversationId: string,
    private readonly deps: GroupAgentDeps,
  ) {
    this.agentId = groupAgentId(conversationId);
  }

  async handleTurn(ctx: TurnContext, input: AgentTurnInput, io: TurnIO): Promise<AgentTurnResult> {
    if (ctx.conversationId !== this.conversationId || ctx.agent.id !== this.agentId) {
      throw new Error("group agent invoked for a different conversation");
    }
    const active = await this.deps.tasks.findActive<GroupMealState>(this.conversationId, TASK_TYPE);
    if (input.reaction) return this.handleReaction(ctx, input.reaction, active, io);
    const dataBlocks: DataBlock[] = [];
    try {
      const recalled = await this.deps.memoryStore.search(
        { kind: "group", conversationId: this.conversationId },
        { query: input.text, limit: 5 },
      );
      if (recalled.length)
        dataBlocks.push({
          label: "group memory: past chat and decisions",
          content: recalled.map((m) => m.content).join("\n"),
        });
    } catch (err) {
      this.deps.logger.warn("group memory read failed", { turnId: ctx.turnId, err });
    }
    if (input.history.length)
      dataBlocks.push({ label: "recent group messages", content: formatHistory(input.history, "Member") });
    if (active) dataBlocks.push({ label: "current group plan", content: this.describeTask(active) });

    const loop = await this.deps.runtime.runModelLoop(
      ctx,
      {
        purpose: "group_turn",
        systemPrompt: groupSystemPrompt(this.deps.agentName),
        dataBlocks,
        userText: input.text,
        allowedKinds: ["reply", "tool_call", "start_task", "confirm_task", "cancel_task"],
      },
      io,
    );

    const replies: string[] = [];
    const memoryCandidates: MemoryCandidate[] = [];
    const intent = loop.intents[0];
    if (intent) {
      const out = await this.handleIntent(ctx, intent, active, io);
      replies.push(...out.replies);
      memoryCandidates.push(...out.memoryCandidates);
    } else if (loop.replyText) {
      replies.push(await this.discloseChecked(ctx, loop.replyText, loop.usedToolData, io));
    }
    return { replies, memoryCandidates, status: loop.status, detail: { intent: intent?.kind ?? null } };
  }

  /**
   * Tapbacks (P2 contribution): a 👍 from a verified member on EXACTLY the proposal message we sent
   * confirms it — deterministic, no model call, so chat text can't fake a confirmation. On the order
   * message, a 👍 / 👎 from someone with a share agrees to / turns down their share. Everything else
   * (other reactions, other messages, an un-like, the payer's own 👍, a repeat) is ignored silently.
   */
  private async handleReaction(
    ctx: TurnContext,
    reaction: NonNullable<AgentTurnInput["reaction"]>,
    active: Task | null,
    io: TurnIO,
  ): Promise<AgentTurnResult> {
    if (active?.status === "awaiting_confirmations")
      return this.handleShareReaction(ctx, reaction, active, io);
    const proposalId = active?.status === "proposed" ? active.state.proposal?.messageId : undefined;
    const matches =
      reaction.type === "like" &&
      !reaction.removed &&
      !!proposalId &&
      reaction.targetMessageId === proposalId;
    await this.audit(ctx, "coordination.reaction", {
      type: reaction.type,
      removed: reaction.removed,
      onProposal: !!proposalId && reaction.targetMessageId === proposalId,
      confirms: matches,
    });
    if (!matches) return { replies: [], memoryCandidates: [], detail: { intent: "reaction_ignored" } };
    const out = await this.confirmMeal(ctx, active, io);
    return { ...out, detail: { intent: "confirm_task", via: "reaction" } };
  }

  private async handleShareReaction(
    ctx: TurnContext,
    reaction: NonNullable<AgentTurnInput["reaction"]>,
    active: Task,
    io: TurnIO,
  ): Promise<AgentTurnResult> {
    const c = active.state.order?.confirmations;
    const onOrder = !!c?.messageId && reaction.targetMessageId === c.messageId;
    const open = !!c && c.needed.includes(ctx.userId) && !c.confirmed.includes(ctx.userId);
    const vote =
      onOrder && open && !reaction.removed
        ? reaction.type === "like"
          ? "agree"
          : reaction.type === "dislike"
            ? "decline"
            : null
        : null;
    await this.audit(ctx, "coordination.reaction", {
      type: reaction.type,
      removed: reaction.removed,
      onOrder,
      confirms: vote === "agree",
      declines: vote === "decline",
    });
    if (!vote) return { replies: [], memoryCandidates: [], detail: { intent: "reaction_ignored" } };
    if (vote === "decline") {
      await this.update(ctx, active, "cancelled", active.state);
      const name = this.nameIn(active.state.order!, ctx.userId);
      return {
        replies: [`${name} turned down their share, so I cancelled the order. Nothing was ordered.`],
        memoryCandidates: [],
        detail: { intent: "cancel_task", via: "reaction" },
      };
    }
    const out = await this.confirmShare(ctx, active, io);
    return { ...out, detail: { intent: "confirm_task", via: "reaction" } };
  }

  // ---- intents ----

  private async handleIntent(
    ctx: TurnContext,
    intent: TaskIntent,
    active: Task | null,
    io: TurnIO,
  ): Promise<{ replies: string[]; memoryCandidates: MemoryCandidate[] }> {
    switch (intent.kind) {
      case "start_task":
        if (active && OPEN_STATUSES.includes(active.status)) {
          const order = active.status === "awaiting_confirmations" || active.status === "awaiting_payment";
          return {
            replies: [
              order
                ? `There's an order open: ${this.describeTask(active)} Say "cancel" to drop it first.`
                : `We already have a plan going: ${this.describeTask(active)} Say "confirm" to lock it in or "cancel" to start over.`,
            ],
            memoryCandidates: [],
          };
        }
        return { replies: [await this.startMeal(ctx, intent.params, io)], memoryCandidates: [] };
      case "confirm_task":
        // A member with a share agreeing to it in words ("confirm") counts like their 👍.
        if (active?.status === "awaiting_confirmations") return this.confirmShare(ctx, active, io);
        return this.confirmMeal(ctx, active, io);
      case "cancel_task":
        if (!active) return { replies: ["There's no plan to cancel."], memoryCandidates: [] };
        await this.update(ctx, active, "cancelled", active.state);
        return { replies: ["Okay, cancelled the plan."], memoryCandidates: [] };
    }
  }

  private async startMeal(ctx: TurnContext, params: GroupMealParams, io: TurnIO): Promise<string> {
    const members = await this.deps.membership.listActiveMembers(this.conversationId);
    const verified = members.filter((m) => m.status === "verified" && m.userId);
    const unverifiedCount = members.length - verified.length;

    let task = (await this.deps.tasks.create<GroupMealState>({
      ownerType: "group",
      ownerId: this.conversationId,
      conversationId: this.conversationId,
      type: TASK_TYPE,
      status: "collecting",
      state: { params, invokedByUserId: ctx.userId, options: [], round: 0 },
    })) as Task;
    await this.audit(ctx, "task.created", {
      taskId: task.id,
      type: TASK_TYPE,
      verifiedMembers: verified.length,
      unverifiedMembers: unverifiedCount,
    });

    // Groups have no typing indicator → a short "on it" (spec 4.5).
    await io.reply("On it - checking options with everyone's agents.");

    const options = await this.fetchOptions(ctx, params, params.budgetPerPersonMinor, io);
    if (!options.ok) {
      await this.update(ctx, task, "failed", task.state);
      return `I couldn't look up places right now (${options.reason}). Whoever asked may need to connect a dining account first.`;
    }

    const participants = verified.map((m) => ({ userId: m.userId!, name: m.displayName }));
    const maxRounds = this.deps.maxRounds ?? 2;
    let decision = null as ReturnType<Coordinator["decide"]> | null;
    let candidates = options.options;

    for (let round = 1; round <= maxRounds; round++) {
      task = await this.update(ctx, task, "collecting", { ...task.state, options: candidates, round });
      const verdicts = await this.ask(ctx, task.id, participants, "evaluate_option", {
        options: candidates,
        ...(params.budgetPerPersonMinor ? { groupBudgetPerPersonMinor: params.budgetPerPersonMinor } : {}),
      });
      decision = this.deps.coordinator.decide({
        options: candidates,
        verdicts,
        groupBudgetPerPersonMinor: params.budgetPerPersonMinor,
      });
      await this.audit(ctx, "coordination.decision", {
        taskId: task.id,
        round,
        kind: decision.kind,
        ...(decision.kind === "propose"
          ? {
              optionId: decision.option.id,
              acceptCount: decision.acceptCount,
              respondents: decision.respondents,
            }
          : {}),
      });
      if (decision.kind !== "counteroffer_needed" || round === maxRounds) break;

      // Counteroffer round: ask agents that rejected everything for a coarse, shareable constraint,
      // then re-source options under it.
      const rejecters = participants.filter(
        (p) => verdicts.find((v) => v.agentId === personalAgentId(p.userId))?.response.status === "rejected",
      );
      if (rejecters.length === 0) break;
      const counters = await this.ask(ctx, task.id, rejecters, "share_constraint", {
        fields: ["meal.price_band"],
      });
      const ceiling = counterofferCeiling(counters);
      if (ceiling === null) break;
      const cap =
        params.budgetPerPersonMinor === null ? ceiling : Math.min(ceiling, params.budgetPerPersonMinor);
      const refreshed = await this.fetchOptions(ctx, params, cap, io);
      const next = this.deps.coordinator.applyCounteroffers(
        refreshed.ok ? refreshed.options : candidates,
        counters,
      );
      if (next.length === 0 || sameIds(next, candidates)) break;
      candidates = next;
    }

    const nameOf = (agentId: string) =>
      participants.find((p) => personalAgentId(p.userId) === agentId)?.name ?? "someone";
    const waiting: string[] = [];
    if (decision && decision.kind !== "no_options") waiting.push(...decision.pending.map(nameOf));
    const waitingText = [
      waiting.length ? `Still waiting on ${waiting.join(", ")} to share preferences with their agent.` : "",
      unverifiedCount
        ? `${unverifiedCount} member${unverifiedCount > 1 ? "s haven't" : " hasn't"} verified yet, so I couldn't include them - they can message me to get set up.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");

    if (!decision || decision.kind === "no_options") {
      await this.update(ctx, task, "no_consensus", task.state);
      return `I couldn't find any places${params.budgetPerPersonMinor ? ` under ${formatMoney(params.budgetPerPersonMinor)} per person` : ""}. Want to try a different budget or cuisine?`;
    }
    if (decision.kind === "counteroffer_needed") {
      await this.update(ctx, task, "no_consensus", task.state);
      const closest = decision.bestPartial
        ? ` Closest: ${decision.bestPartial.option.name} (${decision.bestPartial.acceptCount} of ${decision.respondents} agents in).`
        : "";
      return `I couldn't find a place that works for everyone.${closest} Want me to try a different budget or cuisine? ${waitingText}`.trim();
    }

    const o = decision.option;
    const proposal = {
      optionId: o.id,
      acceptCount: decision.acceptCount,
      respondents: decision.respondents,
      waitingOn: waiting,
    };
    task = await this.update(ctx, task, "proposed", { ...task.state, proposal });
    const text = [
      `Proposal: ${o.name} (${o.cuisine}), about ${formatMoney(o.pricePerPersonMinor, o.currency)} per person${o.distanceMeters !== undefined ? `, ${(o.distanceMeters / 1000).toFixed(1)} km away` : ""}.`,
      `${decision.acceptCount} of ${decision.respondents} members' agents are in.`,
      waitingText,
      `👍 this message to lock it in (or reply "${this.deps.invocationHint} confirm"), or "${this.deps.invocationHint} cancel".`,
    ]
      .filter(Boolean)
      .join(" ");
    // Sent here (not returned) so we know its message id: a 👍 on exactly this message confirms.
    const sent = await io.reply(text);
    if (sent)
      await this.update(ctx, task, "proposed", {
        ...task.state,
        proposal: { ...proposal, messageId: sent.messageId },
      });
    return "";
  }

  private async confirmMeal(
    ctx: TurnContext,
    active: Task | null,
    io: TurnIO,
  ): Promise<{ replies: string[]; memoryCandidates: MemoryCandidate[] }> {
    if (!active || active.status !== "proposed" || !active.state.proposal) {
      return {
        replies: ["There's nothing to confirm yet. Ask me to plan something first."],
        memoryCandidates: [],
      };
    }
    const option = active.state.options.find((x) => x.id === active.state.proposal!.optionId);
    if (!option)
      return { replies: ["I lost track of that proposal. Ask me to plan again."], memoryCandidates: [] };

    const decidedAt = this.deps.clock.now().toISOString();
    let task = await this.update(ctx, active, "decided", {
      ...active.state,
      decision: { optionId: option.id, decidedByUserId: ctx.userId, decidedAt },
    });
    const memoryCandidates: MemoryCandidate[] = [
      {
        principal: { kind: "group", conversationId: this.conversationId },
        authorUserId: ctx.userId,
        write: {
          content: `Group decision (${decidedAt.slice(0, 10)}): ${option.name} (${option.cuisine}), about ${formatMoney(option.pricePerPersonMinor, option.currency)} per person.`,
          kind: "decision",
          customId: `task_${task.id}`,
          metadata: { author_user_id: ctx.userId, task_id: task.id, kind: "decision", decided_at: decidedAt },
        },
      },
    ];

    // Item-level group order (P2 contribution): each member's agent picks their items privately.
    const order = await this.buildOrder(ctx, task, option, io);
    if (order) task = await this.update(ctx, task, "decided", { ...task.state, order });

    // Real provider (e.g. Grubhub): quote the exact cart, then ask the payer to approve that amount.
    if (order) {
      const real = await this.quoteAndRequestPayment(ctx, task, option, order, io);
      if (real !== null) return { replies: real ? [real] : [], memoryCandidates };
    }

    // Money never moves on a chat message: hand the payer an authenticated approval page (spec 4.2 step 10).
    // The payer is whoever asked for the plan.
    const payerUserId = active.state.invokedByUserId;
    try {
      const handoff = await this.deps.approvals.createSpendHandoff(ctx, {
        taskId: task.id,
        payerUserId,
        summary: order
          ? `Group order at ${option.name}: ${formatMoney(order.totalMinor, order.currency)} total for ${order.lines.length} people`
          : `Group order at ${option.name}, about ${formatMoney(option.pricePerPersonMinor, option.currency)} per person for ${active.state.proposal.respondents} people`,
      });
      const delivered = await io.dmUser(
        payerUserId,
        order
          ? `Pay ${formatMoney(order.totalMinor, order.currency)} for the group order at ${option.name}: ${handoff.url}${handoff.sandbox ? " (sandbox test - no real money moves)" : ""}`
          : `Approve the group order at ${option.name} here: ${handoff.url}${handoff.sandbox ? " (sandbox test - no real money moves)" : ""}`,
      );
      task = await this.update(ctx, task, "handed_off", {
        ...task.state,
        handoff: { approvalId: handoff.approvalId, payerUserId, sandbox: handoff.sandbox },
      });
      await this.audit(ctx, "spend.handoff_requested", {
        taskId: task.id,
        approvalId: handoff.approvalId,
        sandbox: handoff.sandbox,
        delivered,
      });
      if (order)
        return {
          replies: [
            this.describeOrder(option.name, order, handoff.sandbox) +
              ` I sent ${this.nameIn(order, order.payerUserId)} a private link to pay. Nothing is ordered until it's paid and the restaurant confirms.`,
          ],
          memoryCandidates,
        };
      return {
        replies: [
          `Locked in: ${option.name}. I sent a private link to approve the order${handoff.sandbox ? " (sandbox test)" : ""}. Nothing is ordered until it's approved and the restaurant confirms.`,
        ],
        memoryCandidates,
      };
    } catch (err) {
      this.deps.logger.warn("spend handoff unavailable", { turnId: ctx.turnId, err });
      return {
        replies: [
          order
            ? `${this.describeOrder(option.name, order, true)} Payment isn't set up yet, so nothing was ordered.`
            : `Locked in: ${option.name}. Ordering isn't set up yet, so nothing was ordered.`,
        ],
        memoryCandidates,
      };
    }
  }

  /**
   * Fetch the menu, ask each verified member's agent to pick (projections: item ids only), and price
   * the order. Null when the provider has no menu (the restaurant-level flow still works).
   */
  private async buildOrder(
    ctx: TurnContext,
    task: Task,
    option: MealOption,
    io: TurnIO,
  ): Promise<GroupOrder | null> {
    const menuTool = this.deps.optionsTool.replace(/__.+$/, "__get_menu");
    const outcome = await this.deps.runtime.invokeTool(ctx, menuTool, { optionId: option.id }, io);
    if (outcome.status !== "executed" || !outcome.result.ok) return null;
    const menu = ToolMenuSchema.safeParse(outcome.result.data); // tool output is untrusted data
    if (!menu.success || menu.data.items.length === 0) return null;
    const byId = new Map(menu.data.items.map((i) => [i.id, i]));

    const members = (await this.deps.membership.listActiveMembers(this.conversationId)).filter(
      (m) => m.status === "verified" && m.userId,
    );
    const budget = task.state.params.budgetPerPersonMinor;
    const answers = await this.ask(
      ctx,
      task.id,
      members.map((m) => ({ userId: m.userId! })),
      "choose_items",
      { restaurant: option.name, menu: menu.data.items, ...(budget ? { budgetPerPersonMinor: budget } : {}) },
    );

    const lines: GroupOrder["lines"] = [];
    const notIncluded: string[] = [];
    for (const m of members) {
      const r = answers.find((a) => a.agentId === personalAgentId(m.userId!))?.response;
      const picks = r?.status === "accepted" ? ChooseItemsAnswerSchema.safeParse(r.payload) : null;
      const items = (picks?.success ? picks.data.items : []).flatMap((p) => {
        const item = byId.get(p.itemId);
        return item
          ? [{ itemId: item.id, name: item.name, quantity: p.quantity, priceMinor: item.priceMinor }]
          : [];
      });
      if (!items.length) {
        notIncluded.push(m.displayName ?? "someone");
        continue;
      }
      lines.push({
        userId: m.userId!,
        name: m.displayName,
        items,
        subtotalMinor: items.reduce((n, i) => n + i.priceMinor * i.quantity, 0),
      });
    }
    if (!lines.length) return null;
    // The person who asked for the order pays, on their own account.
    const payerUserId = task.state.invokedByUserId;
    const order: GroupOrder = {
      restaurant: option.name,
      currency: option.currency,
      lines,
      notIncluded,
      totalMinor: lines.reduce((n, l) => n + l.subtotalMinor, 0),
      payerUserId,
      payerName: members.find((m) => m.userId === payerUserId)?.displayName ?? null,
      splits: lines
        .filter((l) => l.userId !== payerUserId)
        .map((l) => ({ userId: l.userId, name: l.name, owesMinor: l.subtotalMinor })),
    };
    await this.audit(ctx, "coordination.order_built", {
      taskId: task.id,
      people: lines.length,
      notIncluded: notIncluded.length,
      totalMinor: order.totalMinor,
    });
    return order;
  }

  /**
   * Quote the real cart on the payer's own account (provider total incl. tax/fees; no charge), then
   * post the order with everyone's share: each of them 👍s it (or says "confirm") before the payer is
   * asked to pay. Returns the group message ("" when already sent), or null when the provider has no
   * quotes (test data: old flow).
   */
  private async quoteAndRequestPayment(
    ctx: TurnContext,
    task: Task,
    option: MealOption,
    order: GroupOrder,
    io: TurnIO,
  ): Promise<string | null> {
    const quoteTool = this.deps.optionsTool.replace(/__.+$/, "__quote_order");
    const items = order.lines.flatMap((l) =>
      l.items.map((i) => ({ itemId: i.itemId, quantity: i.quantity })),
    );
    const payer = this.nameIn(order, order.payerUserId);
    const q = await this.deps.runtime.invokeTool(
      asPayer(ctx, order.payerUserId),
      quoteTool,
      { optionId: option.id, items },
      io,
    );
    if (q.status === "denied" && q.reasonCode === "tool_unknown") return null;
    if (q.status !== "executed" || !q.result.ok) {
      await this.update(ctx, task, "failed", task.state);
      return `${this.describeOrder(option.name, order, false)}\nI couldn't get a price from ${option.name} right now, so nothing was ordered. Try again in a bit.`;
    }
    const failed = ToolErrorSchema.safeParse(q.result.data);
    if (failed.success && failed.data.error === "account_not_connected") {
      await this.update(ctx, task, "failed", task.state);
      return `${this.describeOrder(option.name, order, false)}\n${payer} needs to connect a Grubhub account before I can order on it. Nothing was ordered.`;
    }
    const quote = ToolQuoteSchema.safeParse(q.result.data); // provider output is untrusted data
    if (!quote.success) return null;
    if (quote.data.totalMinor === null) {
      await this.update(ctx, task, "failed", task.state);
      return `${this.describeOrder(option.name, order, false)}\n${option.name} didn't give me the final total (tax and fees), so I can't ask anyone to pay yet. Nothing was ordered.`;
    }
    const total = quote.data.totalMinor;
    const splits = shareSplits(order, total);
    const priced: GroupOrder = {
      ...order,
      totalMinor: total,
      splits,
      quote: {
        provider: quote.data.provider,
        cartId: quote.data.cartId,
        totalMinor: total,
        subtotalMinor: quote.data.subtotalMinor,
        taxMinor: quote.data.taxMinor ?? null,
        feesMinor: quote.data.feesMinor ?? null,
        tipMinor: quote.data.tipMinor,
      },
      confirmations: { needed: splits.map((x) => x.userId), confirmed: [] },
      delivery: { platform: ctx.platform, providerConversationId: ctx.providerConversationId },
    };
    await this.audit(ctx, "order.quoted", {
      taskId: task.id,
      totalMinor: total,
      provider: quote.data.provider,
    });

    // Only the payer has items: nobody else has a share to agree to.
    if (!splits.length) {
      task = await this.update(ctx, task, "decided", { ...task.state, order: priced });
      return `${this.describeOrder(option.name, priced, false)}\n${await this.requestPayment(ctx, task, io)}`;
    }
    task = await this.update(ctx, task, "awaiting_confirmations", { ...task.state, order: priced });
    const who = splits.map((x) => x.name ?? "someone").join(", ");
    const text = [
      this.describeOrder(option.name, priced, false),
      `${who}: 👍 this message to agree to your share (or reply "${this.deps.invocationHint} confirm"). A 👎 cancels the order.`,
      `Nothing is ordered until everyone agrees and ${payer} approves the total.`,
    ].join("\n");
    // Sent here (not returned) so we know its message id: a 👍 on exactly this message agrees.
    const sent = await io.reply(text);
    if (sent)
      await this.update(ctx, task, "awaiting_confirmations", {
        ...task.state,
        order: { ...priced, confirmations: { ...priced.confirmations!, messageId: sent.messageId } },
      });
    return "";
  }

  /** One member with a share agreed to it (👍 or "confirm"). Once everyone has, ask the payer to pay. */
  private async confirmShare(
    ctx: TurnContext,
    active: Task,
    io: TurnIO,
  ): Promise<{ replies: string[]; memoryCandidates: MemoryCandidate[] }> {
    const order = active.state.order!;
    const c = order.confirmations ?? { needed: [], confirmed: [] };
    const names = (ids: string[]) => ids.map((u) => this.nameIn(order, u)).join(", ");
    const waitingOn = (confirmed: string[]) => c.needed.filter((u) => !confirmed.includes(u));
    if (!c.needed.includes(ctx.userId))
      return {
        replies: [
          ctx.userId === order.payerUserId
            ? `You're paying, so there's nothing for you to agree to. Waiting on ${names(waitingOn(c.confirmed))}.`
            : "You don't have a share in this order.",
        ],
        memoryCandidates: [],
      };
    if (c.confirmed.includes(ctx.userId))
      return {
        replies: [`You already agreed. Waiting on ${names(waitingOn(c.confirmed))}.`],
        memoryCandidates: [],
      };
    const confirmed = [...c.confirmed, ctx.userId];
    const task = await this.update(ctx, active, "awaiting_confirmations", {
      ...active.state,
      order: { ...order, confirmations: { ...c, confirmed } },
    });
    await this.audit(ctx, "order.share_confirmed", {
      taskId: task.id,
      confirmed: confirmed.length,
      needed: c.needed.length,
    });
    const waiting = waitingOn(confirmed);
    if (waiting.length)
      return {
        replies: [`${this.nameIn(order, ctx.userId)} is in. Still waiting on ${names(waiting)}.`],
        memoryCandidates: [],
      };
    return { replies: [`Everyone's in. ${await this.requestPayment(ctx, task, io)}`], memoryCandidates: [] };
  }

  /**
   * Propose submit_order through the gateway as the payer — a spend tool, so the gateway asks them
   * privately (the runtime DMs them the approval link) to approve the exact amount.
   */
  private async requestPayment(ctx: TurnContext, task: Task, io: TurnIO): Promise<string> {
    const order = task.state.order!;
    const submitTool = this.deps.optionsTool.replace(/__.+$/, "__submit_order");
    const s = await this.deps.runtime.invokeTool(
      asPayer(ctx, order.payerUserId),
      submitTool,
      { cartId: order.quote!.cartId, approvedTotalMinor: order.totalMinor },
      io,
    );
    if (s.status !== "needs_approval") {
      await this.update(ctx, task, "failed", task.state);
      return "I couldn't set up the payment, so nothing was ordered.";
    }
    await this.update(ctx, task, "awaiting_payment", {
      ...task.state,
      order: { ...order, approvalId: s.approvalId },
    });
    const payer = this.nameIn(order, order.payerUserId);
    return `${payer}, I sent you a private link to approve ${formatMoney(order.totalMinor, order.currency)}. Nothing is ordered until you do.`;
  }

  private nameIn(order: GroupOrder, userId: string): string {
    const name = order.lines.find((l) => l.userId === userId)?.name;
    if (name) return name;
    if (userId === order.payerUserId) return order.payerName ?? "the payer";
    return "someone";
  }

  private describeOrder(restaurant: string, order: GroupOrder, sandbox: boolean): string {
    const lines = order.lines.map(
      (l) =>
        `- ${l.name ?? "Someone"}: ${l.items.map((i) => `${i.quantity > 1 ? `${i.quantity}x ` : ""}${i.name}`).join(", ")} ${formatMoney(l.subtotalMinor, order.currency)}`,
    );
    const payer = this.nameIn(order, order.payerUserId);
    const split = order.splits.length
      ? `Split: ${order.splits.map((x) => `${x.name ?? "someone"} owes ${payer} ${formatMoney(x.owesMinor, order.currency)}`).join(", ")}.`
      : "";
    const total = order.quote
      ? `Total ${formatMoney(order.totalMinor, order.currency)} with tax and fees.`
      : `Total ${formatMoney(order.totalMinor, order.currency)}.`;
    return [
      `Locked in: ${restaurant}. Group order${sandbox ? " (test order - nothing real is ordered)" : ""}:`,
      ...lines,
      `${total} ${payer} is paying. ${split}`.trim(),
      order.notIncluded.length
        ? `Not included: ${order.notIncluded.join(", ")} (nothing on the menu fit, or no answer).`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ---- helpers ----

  private async fetchOptions(
    ctx: TurnContext,
    params: GroupMealParams,
    maxPrice: number | null,
    io: TurnIO,
  ): Promise<{ ok: true; options: MealOption[] } | { ok: false; reason: string }> {
    const args: Record<string, unknown> = {};
    if (maxPrice !== null && Number.isFinite(maxPrice)) args.maxPricePerPersonMinor = maxPrice;
    if (params.cuisine) args.cuisine = params.cuisine;
    const outcome = await this.deps.runtime.invokeTool(ctx, this.deps.optionsTool, args, io);
    if (outcome.status !== "executed")
      return { ok: false, reason: "reasonCode" in outcome ? outcome.reasonCode : outcome.status };
    if (!outcome.result.ok) return { ok: false, reason: outcome.result.errorCode ?? "provider_error" };
    const parsed = ToolOptionsSchema.safeParse(outcome.result.data); // tool output is untrusted data
    if (!parsed.success) return { ok: false, reason: "invalid_options" };
    return { ok: true, options: parsed.data.options };
  }

  private async ask(
    ctx: TurnContext,
    taskId: string,
    participants: Array<{ userId: string }>,
    requestType: "evaluate_option" | "share_constraint" | "choose_items",
    payload: Record<string, unknown>,
  ): Promise<OptionVerdicts> {
    const expiresAt = new Date(
      this.deps.clock.now().getTime() + (this.deps.coordinationTtlMs ?? 30_000),
    ).toISOString();
    const trace = { turnId: ctx.turnId, conversationId: ctx.conversationId };
    return Promise.all(
      participants.map(async (p) => {
        const agentId = personalAgentId(p.userId);
        const response = await this.deps.bus.request(
          {
            taskId,
            requesterAgentId: this.agentId,
            targetAgentId: agentId,
            requestType,
            purpose: TASK_TYPE,
            payload,
            expiresAt,
          },
          trace,
        );
        return { agentId, response };
      }),
    );
  }

  /** Disclose check before tool-derived content reaches the group (spec 6.5 step 10). */
  private async discloseChecked(
    ctx: TurnContext,
    reply: string,
    used: Array<{ server: string; tool: string }>,
    io: TurnIO,
  ): Promise<string> {
    if (used.length === 0) return reply;
    const res = await this.deps.broker.disclose({
      subjectUserId: ctx.userId,
      purpose: "other",
      audience: { kind: "group", id: this.agentId },
      dataClasses: used.map((u) => `tool:${u.server}__${u.tool}`),
    });
    if (res.allowed) return reply;
    await this.audit(ctx, "reply.withheld_disclosure", {
      reasonCode: res.reasonCode,
      tools: used.map((u) => `${u.server}__${u.tool}`),
    });
    const sent = await io.dmUser(ctx.userId, reply);
    return sent
      ? "That includes private info, so I sent it to you directly."
      : "That includes private info, so I can't share it here.";
  }

  private async update(ctx: TurnContext, task: Task, status: string, state: GroupMealState): Promise<Task> {
    const next = (await this.deps.tasks.update<GroupMealState>(
      task.id,
      { status, state },
      task.version,
    )) as Task;
    await this.audit(ctx, "task.updated", { taskId: task.id, status });
    return next;
  }

  private describeTask(task: Task): string {
    const p = task.state.proposal;
    const option = p ? task.state.options.find((o) => o.id === p.optionId) : undefined;
    if (task.status === "proposed" && option)
      return `Proposed ${option.name}, about ${formatMoney(option.pricePerPersonMinor, option.currency)} per person (${p!.acceptCount} of ${p!.respondents} agents in).`;
    const order = task.state.order;
    if (order) {
      const money = formatMoney(order.totalMinor, order.currency);
      const payer = this.nameIn(order, order.payerUserId);
      if (task.status === "awaiting_confirmations") {
        const c = order.confirmations;
        const waiting = (c?.needed ?? []).filter((u) => !c!.confirmed.includes(u));
        return `Order at ${order.restaurant} (${money}, ${payer} paying) is waiting for ${waiting.map((u) => this.nameIn(order, u)).join(", ")} to agree to their share.`;
      }
      if (task.status === "awaiting_payment")
        return `Order at ${order.restaurant} (${money}) is waiting for ${payer} to approve the payment.`;
      if (task.status === "ordered")
        return `Order at ${order.restaurant} is placed; I'm tracking the delivery.`;
    }
    return `Meal plan is ${task.status}.`;
  }

  private audit(
    ctx: TurnContext,
    action: Parameters<AuditLog["record"]>[0]["action"],
    detail: Record<string, unknown>,
  ) {
    return this.deps.audit.record({
      action,
      turnId: ctx.turnId,
      conversationId: ctx.conversationId,
      actorUserId: ctx.userId,
      resource: `agent:${this.agentId}`,
      detail,
    });
  }
}

function sameIds(a: MealOption[], b: MealOption[]): boolean {
  return a.length === b.length && a.every((o, i) => o.id === b[i]?.id);
}

export class GroupAgentRegistry implements GroupAgentFactory {
  constructor(private readonly deps: GroupAgentDeps) {}
  forConversation(conversationId: string): GroupAgent {
    return new GroupAgentImpl(conversationId, this.deps);
  }
}

/** Each non-payer's share: their items plus a proportional part of tax/fees (rounded; payer absorbs pennies). */
function shareSplits(order: NonNullable<GroupMealState["order"]>, totalMinor: number) {
  const subtotal = order.lines.reduce((n, l) => n + l.subtotalMinor, 0) || 1;
  return order.lines
    .filter((l) => l.userId !== order.payerUserId)
    .map((l) => ({
      userId: l.userId,
      name: l.name,
      owesMinor: Math.round((l.subtotalMinor * totalMinor) / subtotal),
    }));
}
