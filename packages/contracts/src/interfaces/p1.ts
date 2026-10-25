import type { AuditEvent, AuditQuery } from "../schemas/audit";
import type { CoordinationRequest, CoordinationResponse, MealOption } from "../schemas/coordination";
import type { MemoryCandidate } from "../schemas/memory";
import type { InboundMessage } from "../schemas/messaging";
import type { ModelRequest, ModelResponse, ProposalKind } from "../schemas/model";
import type { AgentTask, CoordinationEvent, NewTask } from "../schemas/tasks";
import type { GatewayOutcome } from "../schemas/tools";
import type { TurnContext, TurnOutcome } from "../schemas/turn";

// Interfaces implemented by P1 (spine): ModelClient, AuditLog, TurnPipeline, TaskStore, Coordinator,
// PersonalAgent, GroupAgent — plus the runtime plumbing they need (queue, message log, bus, runtime).

/** Provider-swappable model client (spec 4.4). Validation + single retry live in the harness. */
export interface ModelClient {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Audit writer (spec 12). `detail` must never contain secrets or private values. */
export interface AuditLog {
  record(event: AuditEvent): Promise<void>;
  query(query: AuditQuery): Promise<AuditEvent[]>;
}

export type IngestResult = { status: "enqueued" | "duplicate"; eventId: string };

/** A persisted inbound event awaiting processing (core.inbound_events). */
export type InboundEvent = {
  id: string;
  /** `${platform}:${providerConversationId}` — the per-conversation serialization key. */
  conversationKey: string;
  message: InboundMessage;
  attempts: number;
  receivedAt: string;
};

/** The deterministic turn pipeline (spec 4.2). */
export interface TurnPipeline {
  /** Step 2: dedupe + persist + enqueue. Called by the webhook route after verify + normalize. Fast. */
  ingest(message: InboundMessage): Promise<IngestResult>;
  /** Steps 3–12 for one claimed event. Called by the queue worker, serialized per conversation. */
  processEvent(event: InboundEvent): Promise<TurnOutcome>;
}

/** Durable inbound queue with dedupe on (platform, providerMessageId) and per-conversation FIFO. */
export interface InboundQueue {
  enqueue(message: InboundMessage): Promise<{ eventId: string; inserted: boolean }>;
  /** Claims the oldest pending event whose conversation has nothing else in flight. */
  claimNext(): Promise<InboundEvent | null>;
  complete(eventId: string): Promise<void>;
  /** Re-queue at `retryAt`, or dead-letter when `deadLetter` is true (poison messages, spec 4.7). */
  fail(eventId: string, error: string, opts: { retryAt?: Date; deadLetter: boolean }): Promise<void>;
  counts(): Promise<Record<string, number>>;
}

export type ConversationLine = {
  direction: "inbound" | "outbound";
  senderUserId: string | null;
  senderDisplayName: string | null;
  body: string;
  at: string;
};

/** core.messages: minimal conversation log; doubles as the recent-turn cache (spec 5.3 item 5). */
export interface MessageLog {
  recordInbound(input: {
    conversationId: string;
    platform: InboundMessage["platform"];
    providerMessageId: string;
    senderExternalIdentityId: string | null;
    /** null for unverified senders in 1:1 chats (never retained, spec 4.3); group chat text is kept (team decision). */
    body: string | null;
    receivedAt: string;
  }): Promise<{ id: string; inserted: boolean }>;
  recordOutbound(input: {
    conversationId: string;
    platform: InboundMessage["platform"];
    providerMessageId: string;
    body: string;
  }): Promise<void>;
  markProcessed(id: string): Promise<void>;
  recent(conversationId: string, limit: number): Promise<ConversationLine[]>;
}

export interface TaskStore {
  create<S extends Record<string, unknown>>(task: NewTask<S>): Promise<AgentTask<S>>;
  get<S extends Record<string, unknown>>(taskId: string): Promise<AgentTask<S> | null>;
  /** Most recent non-terminal task of `type` in a conversation. */
  /** Tasks of `type` currently in one of `statuses` (e.g. orders waiting on payment or delivery). */
  listByStatus<S extends Record<string, unknown>>(
    type: string,
    statuses: string[],
  ): Promise<Array<AgentTask<S>>>;
  findActive<S extends Record<string, unknown>>(
    conversationId: string,
    type: string,
  ): Promise<AgentTask<S> | null>;
  /** Optimistic concurrency: throws HarnessError("task_conflict") if `expectedVersion` is stale. */
  update<S extends Record<string, unknown>>(
    taskId: string,
    patch: { status?: string; state?: S },
    expectedVersion: number,
  ): Promise<AgentTask<S>>;
  appendEvent(event: Omit<CoordinationEvent, "id" | "createdAt">): Promise<CoordinationEvent>;
  listEvents(taskId: string): Promise<CoordinationEvent[]>;
}

// ---- coordination ----

export type OptionVerdicts = Array<{ agentId: string; response: CoordinationResponse }>;

export type CoordinatorDecision =
  | {
      kind: "propose";
      option: MealOption;
      acceptCount: number;
      respondents: number;
      /** Agent ids that have not answered accepted/rejected (needs_consent, timeouts). */
      pending: string[];
      ranking: Array<{ optionId: string; acceptCount: number }>;
    }
  | {
      kind: "counteroffer_needed";
      bestPartial: { option: MealOption; acceptCount: number } | null;
      respondents: number;
      pending: string[];
    }
  | { kind: "no_options" };

/** Deterministic coordinator (spec 4.6): hard-constraint filter, fixed ranking, counteroffers. */
export interface Coordinator {
  decide(input: {
    options: MealOption[];
    verdicts: OptionVerdicts;
    groupBudgetPerPersonMinor: number | null;
  }): CoordinatorDecision;
  /** Narrow options using counteroffer projections (e.g. coarse price bands). */
  applyCounteroffers(options: MealOption[], counteroffers: OptionVerdicts): MealOption[];
}

export interface CoordinationBus {
  /** `trace` links the exchange to the originating turn in the audit trail (never sent to agents). */
  request(
    request: CoordinationRequest,
    trace?: { turnId: string; conversationId: string },
  ): Promise<CoordinationResponse>;
}

// ---- agents ----

/** Outbound side channel the harness gives an agent for the current turn. Plain text only. */
export interface TurnIO {
  /**
   * Send immediately to the current conversation (e.g. a short "on it" in groups, spec 4.5).
   * Returns the provider message id (so a later tapback on it can be matched), or null if nothing was sent.
   */
  reply(text: string): Promise<{ messageId: string } | null>;
  /** Send to a verified user's 1:1 chat (approval prompts, payer links). Returns false if not possible. */
  dmUser(userId: string, text: string): Promise<boolean>;
}

export type AgentTurnInput = {
  text: string;
  senderDisplayName: string | null;
  /** Recent conversation lines (verified senders only). Untrusted data. */
  history: ConversationLine[];
  /** Present when the turn is a tapback (e.g. a 👍 on the bot's proposal). `text` is then empty. */
  reaction?: InboundMessage["reaction"];
};

export type AgentTurnResult = {
  /** Final replies to the current conversation; the pipeline formats + sends them (step 11). */
  replies: string[];
  /** Consent-checked by MemoryPolicy before ingestion (step 12). */
  memoryCandidates: MemoryCandidate[];
  /** Don't ingest the person's own message into memory (e.g. a reply in an account sign-in). */
  skipMessageMemory?: boolean;
  status?: "ok" | "budget_exhausted" | "failed_safe";
  detail?: Record<string, unknown>;
};

export interface PersonalAgent {
  readonly userId: string;
  readonly agentId: string;
  handleTurn(ctx: TurnContext, input: AgentTurnInput, io: TurnIO): Promise<AgentTurnResult>;
  /** Answer a coordination request with approved projections only. */
  evaluate(request: CoordinationRequest): Promise<CoordinationResponse>;
}

export interface PersonalAgentFactory {
  /** Logical agents are instantiated on demand (spec 4.1); no process per user. */
  forUser(userId: string): PersonalAgent;
}

export interface GroupAgent {
  handleTurn(ctx: TurnContext, input: AgentTurnInput, io: TurnIO): Promise<AgentTurnResult>;
}

export interface GroupAgentFactory {
  forConversation(conversationId: string): GroupAgent;
}

// ---- runtime (model step + tool gateway + approvals, used by agents) ----

export type DataBlock = { label: string; content: string };

export type ModelLoopInput = {
  purpose: string;
  systemPrompt: string;
  /** Untrusted context (memory, history, task state). Wrapped and labeled as data. */
  dataBlocks: DataBlock[];
  /** The triggering message text. Untrusted. */
  userText: string;
  /** Proposal kinds this agent may act on; anything else is rejected deterministically. */
  allowedKinds: ProposalKind[];
};

export type TaskIntent =
  | {
      kind: "start_task";
      taskType: "group_meal";
      params: { budgetPerPersonMinor: number | null; cuisine: string | null; notes: string | null };
    }
  | { kind: "confirm_task" }
  | { kind: "cancel_task" };

export type ModelLoopResult = {
  replyText: string;
  intents: TaskIntent[];
  toolOutcomes: Array<{ tool: string; status: GatewayOutcome["status"]; reasonCode?: string }>;
  /** Servers/tools whose results informed the reply — drives the group Disclose check (spec 6.5 step 10). */
  usedToolData: Array<{ server: string; tool: string }>;
  status: "ok" | "budget_exhausted" | "failed_safe";
};

export interface AgentRuntime {
  runModelLoop(ctx: TurnContext, input: ModelLoopInput, io: TurnIO): Promise<ModelLoopResult>;
  /** Deterministic (non-model) tool call through the full gateway on behalf of ctx.userId. */
  invokeTool(ctx: TurnContext, tool: string, args: unknown, io: TurnIO): Promise<GatewayOutcome>;
}
