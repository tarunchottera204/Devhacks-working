import {
  type ApprovalService,
  type AuditEvent,
  type AuditLog,
  type AuthGate,
  type Budgets,
  type Clock,
  type Conversation,
  type GroupAgentFactory,
  HarnessError,
  type IdentityService,
  type InboundEvent,
  type InboundMessage,
  InboundMessageSchema,
  type InboundQueue,
  type IngestResult,
  type Logger,
  type MemoryCandidate,
  type MemoryPolicy,
  type MemoryStore,
  type MembershipService,
  type MessageLog,
  type MessagingAdapter,
  type NudgeService,
  type PersonalAgentFactory,
  type ResolvedIdentity,
  type ToolGateway,
  type TurnContext,
  type TurnIO,
  type TurnOutcome,
  type TurnPipeline,
  groupAgentId,
  personalAgentId,
} from "@campus/contracts";
import { withTimeout } from "./budgets";
import { dmMemoryCandidate } from "./memory-rules";
import { toPlainText } from "./reply-format";
import { type ProactiveRule, type RouteDecision, route } from "./router";
import { type AgentRuntimeImpl, FAIL_SAFE_REPLY } from "./runtime";

// The deterministic turn pipeline (spec 4.2). Calls only interfaces; implementations are injected.
//
//   [1] verify + normalize            → MessagingAdapter (P2), in the webhook route
//   [2] dedupe + enqueue; ack fast    → ingest()
//   [3] per-conversation serialization→ InboundQueue claim semantics + QueueWorker
//   [4] identity resolution           → IdentityService / MembershipService (P2)
//   [5] auth gate                     → AuthGate / NudgeService (P2)
//   [6] routing + invocation          → route()
//   [7] context assembly              → agents via ContextBroker / MemoryStore (P3)
//   [8] model step                    → AgentRuntime (structured proposals, filtered tools)
//   [9] tool gateway                  → ToolGateway (P4)
//  [10] approvals                     → ApprovalService (P4)
//  [11] reply formatting + send       → toPlainText + MessagingAdapter
//  [12] memory write + audit          → MemoryPolicy + MemoryStore (P3), AuditLog

export type TurnPipelineDeps = {
  queue: InboundQueue;
  messageLog: MessageLog;
  audit: AuditLog;
  logger: Logger;
  clock: Clock;
  budgets: Budgets;
  invocationNames: string[];
  proactiveRules?: ProactiveRule[];
  messaging: MessagingAdapter;
  identity: IdentityService;
  membership: MembershipService;
  authGate: AuthGate;
  nudges: NudgeService;
  memoryStore: MemoryStore;
  memoryPolicy: MemoryPolicy;
  approvals: ApprovalService;
  gateway: ToolGateway;
  runtime: AgentRuntimeImpl;
  personalAgents: PersonalAgentFactory;
  groupAgents: GroupAgentFactory;
};

const HISTORY_LINES = 12;

export class TurnPipelineImpl implements TurnPipeline {
  constructor(private readonly deps: TurnPipelineDeps) {}

  /** Step 2. Validates the normalized message, dedupes on (platform, providerMessageId), persists, enqueues. */
  async ingest(message: InboundMessage): Promise<IngestResult> {
    const msg = InboundMessageSchema.parse(message);
    const { eventId, inserted } = await this.deps.queue.enqueue(msg);
    await this.deps.audit.record({
      action: inserted ? "turn.received" : "turn.duplicate",
      turnId: eventId,
      detail: { platform: msg.platform, isGroup: msg.isGroup },
    });
    return { status: inserted ? "enqueued" : "duplicate", eventId };
  }

  /** Steps 4–12 for one claimed event (step 3 is guaranteed by the queue + worker). */
  async processEvent(event: InboundEvent): Promise<TurnOutcome> {
    const d = this.deps;
    const msg = event.message;
    const turnId = event.id;
    const log = d.logger.child({ turnId });
    let actorUserId: string | null = null;

    // [4] identity + membership
    const conversation = await d.membership.ensureConversation(
      msg.platform,
      msg.providerConversationId,
      msg.isGroup ? "group" : "dm",
    );
    const conversationId = conversation.id;
    const trace = (
      action: AuditEvent["action"],
      detail: Record<string, unknown> = {},
      policyResult?: string,
    ) =>
      d.audit.record({
        action,
        turnId,
        conversationId,
        actorUserId,
        detail,
        ...(policyResult ? { policyResult } : {}),
      });
    const identity = await d.identity.resolveSender(msg.platform, msg.senderExternalId);
    const participants = msg.isGroup
      ? [...new Set([...msg.participantExternalIds, msg.senderExternalId])]
      : [msg.senderExternalId];
    const membershipChange = await d.membership.syncParticipants(conversation.id, participants);
    const verified = identity.status === "verified" && !!identity.userId;
    if (verified) actorUserId = identity.userId;

    const history = verified ? await d.messageLog.recent(conversation.id, HISTORY_LINES) : [];
    const logged = await d.messageLog.recordInbound({
      conversationId: conversation.id,
      platform: msg.platform,
      providerMessageId: msg.providerMessageId,
      senderExternalIdentityId: identity.externalIdentityId,
      // Unverified senders' 1:1 messages are never retained. Group chat text is kept for everyone: team
      // decision (P2/P3) that everything said in a group the assistant is in feeds the group's memory.
      body: verified || msg.isGroup ? msg.text : null,
      receivedAt: msg.timestamp,
    });

    // [6] routing is a pure function; computed before the gate because nudges require "addressed".
    const decision: RouteDecision = route(msg, {
      invocationNames: d.invocationNames,
      ...(d.proactiveRules ? { proactiveRules: d.proactiveRules } : {}),
    });

    // [5] auth gate: default deny. No verified identity → no model call, no memory.
    const auth = await d.authGate.check({ identity, conversation, addressed: decision.addressed });
    if (auth.kind === "block") {
      let nudged = false;
      if (auth.nudge && decision.addressed) {
        const n = await d.nudges.maybeNudge({ identity, conversation, inbound: msg });
        nudged = n.sent;
      }
      await trace("turn.blocked", { reason: auth.reason, addressed: decision.addressed, nudged }, "deny");
      await d.messageLog.markProcessed(logged.id);
      return {
        turnId,
        status: "blocked_unverified",
        conversationId,
        repliesSent: 0,
        detail: { reason: auth.reason, nudged },
      };
    }
    if (msg.isGroup && !(await d.membership.isActiveMember(conversation.id, identity.externalIdentityId))) {
      await trace("turn.blocked", { reason: "not_member" }, "deny");
      await d.messageLog.markProcessed(logged.id);
      return {
        turnId,
        status: "blocked_unverified",
        conversationId,
        repliesSent: 0,
        detail: { reason: "not_member" },
      };
    }

    if (decision.target === "none") {
      await trace("turn.ignored", {
        reason: decision.reason,
        joined: membershipChange.joined.length,
        left: membershipChange.left.length,
      });
      await d.messageLog.markProcessed(logged.id);
      return { turnId, status: "ignored", conversationId, repliesSent: 0 };
    }

    const userId = identity.userId!;
    const ctx: TurnContext = {
      turnId,
      platform: msg.platform,
      conversationId: conversation.id,
      conversationType: conversation.type,
      providerConversationId: msg.providerConversationId,
      providerMessageId: msg.providerMessageId,
      userId,
      externalIdentityId: identity.externalIdentityId,
      agent:
        decision.target === "personal"
          ? { kind: "personal", id: personalAgentId(userId) }
          : { kind: "group", id: groupAgentId(conversation.id) },
      provenance: msg.isGroup ? "group_message" : "user_dm",
      receivedAt: msg.timestamp,
      deadlineMs: d.clock.now().getTime() + d.budgets.turnTimeoutMs,
    };
    await trace("turn.routed", { target: decision.target, reason: decision.reason });

    let sent = 0;
    const io = this.makeIO(ctx, msg, () => (sent += 1));

    try {
      // [10] a text approval reply ("YES 4821") in a 1:1 chat is resolved before anything else.
      if (!msg.isGroup) {
        const resolved = await this.tryApprovalReply(ctx, msg.text, io);
        if (resolved) {
          await d.messageLog.markProcessed(logged.id);
          await trace("turn.completed", { status: "approval_resolved" });
          return { turnId, status: "approval_resolved", conversationId, repliesSent: sent };
        }
      }

      // A tapback never switches a group on; only addressing the agent does.
      if (msg.isGroup && decision.addressed) await this.ensureActive(conversation, userId, trace);

      // [7]–[10] inside the agent (context via broker/memory, model step, gateway, approvals)
      const text = decision.target === "group" ? decision.text : msg.text;
      const input = {
        text,
        senderDisplayName: identity.displayName,
        history,
        ...(msg.reaction ? { reaction: msg.reaction } : {}),
      };
      const agentResult = await withTimeout(
        decision.target === "personal"
          ? d.personalAgents.forUser(userId).handleTurn(ctx, input, io)
          : d.groupAgents.forConversation(conversation.id).handleTurn(ctx, input, io),
        Math.max(1, ctx.deadlineMs - d.clock.now().getTime()),
        "agent turn",
      );

      // [11] reply
      for (const reply of agentResult.replies) {
        if (reply.trim()) {
          await io.reply(reply);
        }
      }

      // [12] memory (consent-checked) — only ever for verified users; group chatter is not ingested.
      const candidates: MemoryCandidate[] = [...agentResult.memoryCandidates];
      if (!msg.isGroup && !agentResult.skipMessageMemory) {
        const c = dmMemoryCandidate({
          userId,
          conversationId: conversation.id,
          text: msg.text,
          platform: msg.platform,
        });
        if (c) candidates.push(c);
      }
      await this.writeMemory(ctx, identity, candidates, trace);

      await d.messageLog.markProcessed(logged.id);
      const status =
        agentResult.status === "budget_exhausted"
          ? "budget_exhausted"
          : agentResult.status === "failed_safe"
            ? "failed_safe"
            : "replied";
      await trace("turn.completed", { status, repliesSent: sent, budget: d.runtime.releaseTurn(turnId) });
      return { turnId, status, conversationId, repliesSent: sent };
    } catch (err) {
      d.runtime.releaseTurn(turnId);
      const code = err instanceof HarnessError ? err.code : "unknown";
      // Retry only infrastructure failures that happened before anything was sent (no partial side effects).
      if (err instanceof HarnessError && err.retryable && sent === 0) {
        await trace("turn.failed", { errorCode: code, willRetry: true }, "error");
        throw err;
      }
      log.error("turn failed; failing safe", { errorCode: code, err });
      await trace("turn.failed", { errorCode: code, willRetry: false }, "error");
      if (sent === 0) await io.reply(FAIL_SAFE_REPLY).catch(() => undefined);
      await d.messageLog.markProcessed(logged.id);
      return {
        turnId,
        status: "failed_safe",
        conversationId,
        repliesSent: sent,
        detail: { errorCode: code },
      };
    }
  }

  private makeIO(ctx: TurnContext, msg: InboundMessage, onSent: () => void): TurnIO {
    const d = this.deps;
    const audit = (action: AuditEvent["action"], detail: Record<string, unknown>) =>
      d.audit.record({
        action,
        turnId: ctx.turnId,
        conversationId: ctx.conversationId,
        actorUserId: ctx.userId,
        detail,
      });
    return {
      reply: async (raw: string) => {
        const text = toPlainText(raw);
        if (!text) return null;
        const opts = { replyTo: msg.providerMessageId };
        const res = msg.isGroup
          ? await d.messaging.sendGroup(msg.providerConversationId, text, opts)
          : await d.messaging.sendDM(msg.senderExternalId, text, opts);
        onSent();
        await d.messageLog.recordOutbound({
          conversationId: ctx.conversationId,
          platform: msg.platform,
          providerMessageId: res.messageId,
          body: text,
        });
        await audit("reply.sent", { channel: msg.isGroup ? "group" : "dm", chars: text.length });
        return { messageId: res.messageId };
      },
      dmUser: async (userId: string, raw: string) => {
        const text = toPlainText(raw);
        const to = await d.identity.getPrimaryExternalId(userId, ctx.platform);
        if (!to || !text) return false;
        await d.messaging.sendDM(to, text);
        if (userId === ctx.userId && !msg.isGroup) onSent();
        await audit("reply.sent", { channel: "dm", toSelf: userId === ctx.userId, chars: text.length });
        return true;
      },
    };
  }

  private async tryApprovalReply(ctx: TurnContext, text: string, io: TurnIO): Promise<boolean> {
    const d = this.deps;
    const res = await d.approvals.resolveTextReply(ctx, text);
    if (!res.matched) return false;
    await d.audit.record({
      action: "approval.text_reply",
      turnId: ctx.turnId,
      conversationId: ctx.conversationId,
      actorUserId: ctx.userId,
      detail: { approvalId: res.approvalId, kind: res.kind, decision: res.decision },
      policyResult: res.decision,
    });
    let message = res.message;
    if (res.decision === "approved" && res.kind === "tool_ask") {
      const outcome = await d.gateway.executeApproved(ctx, res.approvalId);
      await d.audit.record({
        action: "tool.outcome",
        turnId: ctx.turnId,
        conversationId: ctx.conversationId,
        actorUserId: ctx.userId,
        detail: { approvalId: res.approvalId, status: outcome.status },
        policyResult: outcome.status,
      });
      message =
        outcome.status === "executed"
          ? `${res.message} Done.`
          : outcome.status === "error" && outcome.outcomeUnknown
            ? `${res.message} I couldn't confirm whether it went through; I'll check before trying again.`
            : `${res.message} But it didn't run (${"reasonCode" in outcome ? outcome.reasonCode : outcome.status}).`;
    }
    await io.reply(message);
    return true;
  }

  private async ensureActive(
    conversation: Conversation,
    userId: string,
    trace: (a: AuditEvent["action"], d?: Record<string, unknown>) => Promise<void>,
  ) {
    if (conversation.status === "active") return;
    await this.deps.membership.activate(conversation.id, userId);
    await trace("turn.group_activated", { activatedBy: userId });
  }

  private async writeMemory(
    ctx: TurnContext,
    identity: ResolvedIdentity,
    candidates: MemoryCandidate[],
    trace: (a: AuditEvent["action"], d?: Record<string, unknown>, p?: string) => Promise<void>,
  ) {
    if (identity.status !== "verified") return; // spec 5.3 item 2 (defense in depth; the gate already blocked)
    for (const c of candidates) {
      if (c.authorUserId !== ctx.userId && c.principal.kind === "user") {
        await trace("memory.skipped", { reason: "author_mismatch" }, "deny");
        continue;
      }
      try {
        const decision = await this.deps.memoryPolicy.evaluate(c);
        if (!decision.ingest) {
          await trace("memory.skipped", {
            reason: decision.reason,
            principal: c.principal.kind,
            kind: c.write.kind,
          });
          continue;
        }
        await this.deps.memoryStore.add(c.principal, decision.write);
        await trace("memory.write", { principal: c.principal.kind, kind: decision.write.kind });
      } catch (err) {
        this.deps.logger.warn("memory write failed (non-fatal)", { turnId: ctx.turnId, err });
        await trace("memory.skipped", { reason: "error" }, "error");
      }
    }
  }
}
