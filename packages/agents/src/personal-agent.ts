import { createHash } from "node:crypto";
import {
  type AgentRuntime,
  type AgentTurnInput,
  type AgentTurnResult,
  type AuditLog,
  type Clock,
  type ContextBroker,
  ChooseItemsPayloadSchema,
  type CoordinationRequest,
  type CoordinationResponse,
  type DataBlock,
  EvaluateOptionsPayloadSchema,
  type Logger,
  type MealOption,
  type MemoryStore,
  type PersonalAgent,
  type PersonalAgentFactory,
  SHAREABLE_CONTEXT_FIELDS,
  ShareConstraintPayloadSchema,
  type TurnContext,
  type TurnIO,
  isContextFieldName,
  parseContextFields,
  personalAgentId,
} from "@campus/contracts";
import type { AccountLinkFlow } from "./account-link";
import { formatHistory, personalSystemPrompt } from "./prompts";

// PersonalAgent(userId): identity + authorized context, instantiated on demand (spec 4.1).
// Evaluates group proposals privately and answers with projections only (spec 4.6, 5.7).

export type PersonalAgentDeps = {
  runtime: AgentRuntime;
  broker: ContextBroker;
  memoryStore: MemoryStore;
  audit: AuditLog;
  logger: Logger;
  clock: Clock;
  agentName: string;
  /** Connecting their own ordering account from this chat (absent with test data). */
  accountLink?: AccountLinkFlow;
};

/** Fields a personal agent reads (for itself only) to evaluate meal options. */
const MEAL_EVAL_FIELDS = [
  "meal.max_price_per_person_minor",
  "meal.required_tags",
  "meal.avoid_cuisines",
] as const;

export class PersonalAgentImpl implements PersonalAgent {
  readonly agentId: string;

  constructor(
    readonly userId: string,
    private readonly deps: PersonalAgentDeps,
  ) {
    this.agentId = personalAgentId(userId);
  }

  async handleTurn(ctx: TurnContext, input: AgentTurnInput, io: TurnIO): Promise<AgentTurnResult> {
    // The harness picked this agent from the verified sender; refuse anything else (isolation by structure).
    if (ctx.userId !== this.userId || ctx.agent.id !== this.agentId) {
      throw new Error("personal agent invoked for a different principal");
    }
    // A sign-in to their ordering account is handled without the model and kept out of memory.
    const linked = input.reaction ? null : await this.deps.accountLink?.handle(ctx, input.text);
    if (linked)
      return {
        replies: [linked],
        memoryCandidates: [],
        skipMessageMemory: true,
        detail: { intent: "account_link" },
      };
    const principal = { kind: "user" as const, userId: this.userId };
    const dataBlocks: DataBlock[] = [];
    try {
      const profile = await this.deps.memoryStore.profile(principal, { buckets: ["preferences"] });
      const facts = [...profile.static, ...profile.dynamic].slice(0, 12);
      if (facts.length)
        dataBlocks.push({ label: "memory: what you know about the person", content: facts.join("\n") });
      const recalled = await this.deps.memoryStore.search(principal, { query: input.text, limit: 5 });
      if (recalled.length)
        dataBlocks.push({
          label: "memory: related notes",
          content: recalled.map((m) => m.content).join("\n"),
        });
    } catch (err) {
      this.deps.logger.warn("memory read failed; continuing without memory", { turnId: ctx.turnId, err });
    }
    if (input.history.length)
      dataBlocks.push({
        label: "recent messages in this chat",
        content: formatHistory(input.history, "You"),
      });

    const loop = await this.deps.runtime.runModelLoop(
      ctx,
      {
        purpose: "personal_dm",
        systemPrompt: personalSystemPrompt(this.deps.agentName, input.senderDisplayName),
        dataBlocks,
        userText: input.text,
        allowedKinds: ["reply", "tool_call", "permission_change"],
      },
      io,
    );
    return {
      replies: loop.replyText ? [loop.replyText] : [],
      memoryCandidates: [],
      status: loop.status,
      detail: { tools: loop.toolOutcomes },
    };
  }

  async evaluate(request: CoordinationRequest): Promise<CoordinationResponse> {
    const base = { taskId: request.taskId };
    if (new Date(request.expiresAt).getTime() <= this.deps.clock.now().getTime()) {
      return { ...base, status: "rejected", payload: {}, reasonCode: "expired" };
    }
    switch (request.requestType) {
      case "evaluate_option":
        return this.evaluateOptions(request);
      case "share_constraint":
        return this.shareConstraint(request);
      case "choose_items":
        return this.chooseItems(request);
      default:
        return { ...base, status: "rejected", payload: {}, reasonCode: "unsupported_request" };
    }
  }

  private async evaluateOptions(request: CoordinationRequest): Promise<CoordinationResponse> {
    const parsed = EvaluateOptionsPayloadSchema.safeParse(request.payload);
    if (!parsed.success)
      return { taskId: request.taskId, status: "rejected", payload: {}, reasonCode: "invalid_payload" };

    // Read our own owner's context; the audience is this personal agent, not the group.
    const ctx = await this.deps.broker.requestContext({
      taskId: request.taskId,
      requesterAgentId: this.agentId,
      subjectUserId: this.userId,
      purpose: "group_meal",
      fields: [...MEAL_EVAL_FIELDS],
      audience: { kind: "agent", id: this.agentId },
    });
    if (ctx.status === "needs_consent")
      return { taskId: request.taskId, status: "needs_consent", payload: {}, reasonCode: "consent_required" };
    if (ctx.status === "denied")
      return { taskId: request.taskId, status: "needs_consent", payload: {}, reasonCode: "context_denied" };

    const { values } = parseContextFields(ctx.fields);
    const acceptable = (o: MealOption) =>
      (values["meal.max_price_per_person_minor"] === undefined ||
        o.pricePerPersonMinor <= values["meal.max_price_per_person_minor"]) &&
      (parsed.data.groupBudgetPerPersonMinor === undefined ||
        o.pricePerPersonMinor <= parsed.data.groupBudgetPerPersonMinor) &&
      (values["meal.required_tags"] ?? []).every((t) => o.tags.includes(t)) &&
      !(values["meal.avoid_cuisines"] ?? []).map((c) => c.toLowerCase()).includes(o.cuisine.toLowerCase());

    // Projection only: which option ids are acceptable. No budget, no tags, no reasons that reveal them.
    const acceptedOptionIds = parsed.data.options.filter(acceptable).map((o) => o.id);
    return acceptedOptionIds.length
      ? { taskId: request.taskId, status: "accepted", payload: { acceptedOptionIds } }
      : {
          taskId: request.taskId,
          status: "rejected",
          payload: { acceptedOptionIds: [] },
          reasonCode: "no_acceptable_option",
        };
  }

  /**
   * Group order (P2 contribution): pick one main for the owner from the menu, privately. Hard rules
   * from the owner's own context (dietary tags, their budget, the group budget) filter items; what
   * they told their assistant ("I love pad see ew") ranks the rest. Only the chosen item ids leave.
   */
  private async chooseItems(request: CoordinationRequest): Promise<CoordinationResponse> {
    const parsed = ChooseItemsPayloadSchema.safeParse(request.payload);
    if (!parsed.success)
      return { taskId: request.taskId, status: "rejected", payload: {}, reasonCode: "invalid_payload" };
    const ctx = await this.deps.broker.requestContext({
      taskId: request.taskId,
      requesterAgentId: this.agentId,
      subjectUserId: this.userId,
      purpose: "group_meal",
      fields: [...MEAL_EVAL_FIELDS],
      audience: { kind: "agent", id: this.agentId },
    });
    if (ctx.status !== "approved")
      return { taskId: request.taskId, status: "needs_consent", payload: {}, reasonCode: "consent_required" };
    const { values } = parseContextFields(ctx.fields);
    const cap = Math.min(
      values["meal.max_price_per_person_minor"] ?? Number.POSITIVE_INFINITY,
      parsed.data.budgetPerPersonMinor ?? Number.POSITIVE_INFINITY,
    );
    const required = values["meal.required_tags"] ?? [];
    const mains = parsed.data.menu.filter(
      (i) => i.category === "main" && i.priceMinor <= cap && required.every((t) => i.tags.includes(t)),
    );
    if (!mains.length)
      return {
        taskId: request.taskId,
        status: "rejected",
        payload: { items: [] },
        reasonCode: "no_acceptable_item",
      };

    // Rank by overlap with what the owner said about food (their own memory, read only here).
    let notes = "";
    try {
      const hits = await this.deps.memoryStore.search(
        { kind: "user", userId: this.userId },
        {
          query: `${parsed.data.restaurant} favorite food order ${mains.map((i) => i.name).join(", ")}`,
          limit: 8,
        },
      );
      notes = hits
        .map((h) => h.content)
        .join(" ")
        .toLowerCase();
    } catch (err) {
      this.deps.logger.warn("memory read failed; choosing without favorites", { err });
    }
    const score = (name: string) =>
      name
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length >= 4 && notes.includes(w)).length;
    // No stated favorite → a stable per-person choice (same inputs, same pick) so a group with no
    // preferences doesn't all get the cheapest dish.
    const tie = (id: string) => createHash("sha256").update(`${this.userId}:${id}`).digest().readUInt32BE(0);
    const [pick] = [...mains].sort((a, b) => score(b.name) - score(a.name) || tie(a.id) - tie(b.id));
    return {
      taskId: request.taskId,
      status: "accepted",
      payload: { items: [{ itemId: pick!.id, quantity: 1 }] },
    };
  }

  private async shareConstraint(request: CoordinationRequest): Promise<CoordinationResponse> {
    const parsed = ShareConstraintPayloadSchema.safeParse(request.payload);
    if (!parsed.success)
      return { taskId: request.taskId, status: "rejected", payload: {}, reasonCode: "invalid_payload" };
    const shareable = new Set<string>(SHAREABLE_CONTEXT_FIELDS);
    const fields = parsed.data.fields.filter((f) => isContextFieldName(f) && shareable.has(f));
    if (fields.length === 0)
      return { taskId: request.taskId, status: "rejected", payload: {}, reasonCode: "field_not_shareable" };

    // Disclosure to the requesting (group) agent: the broker decides, audience = requester.
    const ctx = await this.deps.broker.requestContext({
      taskId: request.taskId,
      requesterAgentId: request.requesterAgentId,
      subjectUserId: this.userId,
      purpose: "group_meal",
      fields,
      audience: { kind: "agent", id: request.requesterAgentId },
    });
    if (ctx.status === "needs_consent")
      return { taskId: request.taskId, status: "needs_consent", payload: {}, reasonCode: "consent_required" };
    if (ctx.status === "denied")
      return { taskId: request.taskId, status: "rejected", payload: {}, reasonCode: "not_shared" };
    const { values } = parseContextFields(ctx.fields);
    const payload: Record<string, unknown> = {};
    for (const f of fields) if (f in values) payload[f] = (values as Record<string, unknown>)[f];
    return Object.keys(payload).length
      ? { taskId: request.taskId, status: "counteroffer", payload }
      : { taskId: request.taskId, status: "rejected", payload: {}, reasonCode: "not_shared" };
  }
}

export class PersonalAgentRegistry implements PersonalAgentFactory {
  constructor(private readonly deps: PersonalAgentDeps) {}
  forUser(userId: string): PersonalAgent {
    return new PersonalAgentImpl(userId, this.deps);
  }
}
