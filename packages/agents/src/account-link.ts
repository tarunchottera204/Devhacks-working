import type { AgentTask, AuditLog, Clock, Logger, TaskStore, TurnContext } from "@campus/contracts";

// Connecting someone's own food-ordering account (Grubhub) from their 1:1 chat (P2 contribution):
//   "connect grubhub" → "what's the email on your account?" → Grubhub emails them a one-time code →
//   they reply with it → signed in on the server, so orders run on their own account and card.
// Deterministic, before any model call: the email and the code never reach the model, and these
// messages are kept out of memory. No password is ever asked for.

/** The provider side (wired by the container; Grubhub today). */
export type DiningAccounts = {
  /** Shown to people, e.g. "Grubhub". */
  provider: string;
  isConnected(userId: string): boolean;
  /** Asks the provider to email a one-time sign-in code. Throws if it refuses. */
  sendCode(userId: string, email: string): Promise<void>;
  /** Signs in with the code (throws if wrong). `hasCard`: a usable saved card; null = couldn't check. */
  verifyCode(userId: string, email: string, code: string): Promise<{ hasCard: boolean | null }>;
};

export type AccountLinkDeps = {
  tasks: TaskStore;
  accounts: DiningAccounts;
  audit: AuditLog;
  clock: Clock;
  logger: Logger;
  /** How long a started sign-in waits for the next reply. */
  ttlMs?: number;
};

type LinkState = { email?: string; attempts?: number };
type LinkTask = AgentTask<LinkState>;

const TASK_TYPE = "dining_account_link";
const PENDING = ["awaiting_email", "awaiting_code"];
const MAX_ATTEMPTS = 3;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const CODE = /^\s*(\d[\d -]{2,10}\d)\s*[.!]?\s*$/;
const CANCEL = /^\s*(cancel|stop|never ?mind|nvm)\s*[.!]?\s*$/i;

export class AccountLinkFlow {
  private readonly start: RegExp;

  constructor(private readonly deps: AccountLinkDeps) {
    const p = deps.accounts.provider.toLowerCase().replace(/\s+/g, " ?");
    this.start = new RegExp(`\\b(connect|link|add|set ?up|sign ?in|log ?in)\\b.{0,25}\\b${p}\\b`, "i");
  }

  get provider(): string {
    return this.deps.accounts.provider;
  }

  isConnected(userId: string): boolean {
    return this.deps.accounts.isConnected(userId);
  }

  /** What to text someone to start connecting (also used when an order needs their account). */
  askForEmail(): string {
    const p = this.provider;
    return `To order on your own ${p} account, reply here with the email you use for ${p}. ${p} will email you a sign-in code to send me. I never need your password.`;
  }

  /** Start (or restart) a sign-in for this person; returns the message to send them. */
  async begin(ctx: TurnContext, userId: string): Promise<string> {
    await this.cancelPending(userId);
    const task = await this.deps.tasks.create<LinkState>({
      ownerType: "user",
      ownerId: userId,
      conversationId: null,
      type: TASK_TYPE,
      status: "awaiting_email",
      state: {},
    });
    await this.audit(ctx, userId, "account_link.started", { taskId: task.id });
    return this.askForEmail();
  }

  /**
   * Handles a 1:1 message that belongs to a sign-in (starting one, the email, the code, "cancel").
   * Returns the reply, or null when the message isn't part of one (the agent handles it as usual).
   */
  async handle(ctx: TurnContext, text: string): Promise<string | null> {
    const userId = ctx.userId;
    const pending = await this.pending(userId);
    const email = EMAIL.exec(text)?.[0];
    if (!pending) {
      if (!this.start.test(text)) return null;
      const reply = await this.begin(ctx, userId);
      // "connect grubhub, it's me@x.com" → straight to the code.
      return email ? this.sendCode(ctx, (await this.pending(userId))!, email) : reply;
    }
    if (CANCEL.test(text)) {
      await this.finish(pending, "cancelled");
      return `Okay, I won't connect ${this.provider}.`;
    }
    if (email) return this.sendCode(ctx, pending, email);
    const code = CODE.exec(text)?.[1];
    if (pending.status === "awaiting_code" && code && pending.state.email)
      return this.verify(ctx, pending, pending.state.email, code.replace(/\D/g, ""));
    if (this.start.test(text)) return this.begin(ctx, userId);
    return null;
  }

  private async sendCode(ctx: TurnContext, task: LinkTask, email: string): Promise<string> {
    try {
      await this.deps.accounts.sendCode(task.ownerId, email);
    } catch (err) {
      this.deps.logger.warn("account link: send code failed", { err });
      await this.audit(ctx, task.ownerId, "account_link.failed", { taskId: task.id, step: "send_code" });
      return `${this.provider} didn't accept that email. Check it's the one on your ${this.provider} account and send it again, or say "cancel".`;
    }
    await this.deps.tasks.update<LinkState>(
      task.id,
      { status: "awaiting_code", state: { email, attempts: 0 } },
      task.version,
    );
    await this.audit(ctx, task.ownerId, "account_link.code_sent", { taskId: task.id });
    return `${this.provider} just emailed a sign-in code to ${email}. Reply here with the code.`;
  }

  private async verify(ctx: TurnContext, task: LinkTask, email: string, code: string): Promise<string> {
    let hasCard: boolean | null;
    try {
      ({ hasCard } = await this.deps.accounts.verifyCode(task.ownerId, email, code));
    } catch (err) {
      this.deps.logger.warn("account link: verify failed", { err });
      const attempts = (task.state.attempts ?? 0) + 1;
      await this.audit(ctx, task.ownerId, "account_link.failed", {
        taskId: task.id,
        step: "verify",
        attempts,
      });
      if (attempts >= MAX_ATTEMPTS) {
        await this.finish(task, "failed");
        return `That code didn't work either, so I stopped. Text me "connect ${this.provider.toLowerCase()}" to start over.`;
      }
      await this.deps.tasks.update<LinkState>(task.id, { state: { email, attempts } }, task.version);
      return `That code didn't work. Check the latest email from ${this.provider} and send the code again.`;
    }
    await this.finish(task, "connected");
    await this.audit(ctx, task.ownerId, "account_link.connected", { taskId: task.id, hasCard });
    const p = this.provider;
    const card =
      hasCard === false
        ? ` One thing: I don't see a credit or debit card saved on it. Add one in the ${p} app (Apple Pay and other wallets can't be used here).`
        : "";
    return `Connected! Your ${p} account is linked, so food you order through me is ordered on it and paid with your saved card, after you approve each total.${card}`;
  }

  /** The person's sign-in that's still waiting for a reply; older ones expire. */
  private async pending(userId: string): Promise<LinkTask | null> {
    const open = (await this.deps.tasks.listByStatus<LinkState>(TASK_TYPE, PENDING)).filter(
      (t) => t.ownerId === userId,
    );
    const ttl = this.deps.ttlMs ?? 15 * 60_000;
    const now = this.deps.clock.now().getTime();
    let live: LinkTask | null = null;
    for (const t of open.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      if (!live && now - new Date(t.updatedAt).getTime() <= ttl) live = t;
      else await this.finish(t, "expired");
    }
    return live;
  }

  private async cancelPending(userId: string): Promise<void> {
    for (const t of await this.deps.tasks.listByStatus<LinkState>(TASK_TYPE, PENDING))
      if (t.ownerId === userId) await this.finish(t, "cancelled");
  }

  /** Ends a sign-in and forgets the email. */
  private async finish(task: LinkTask, status: string): Promise<void> {
    const fresh = await this.deps.tasks.get<LinkState>(task.id);
    if (!fresh) return;
    await this.deps.tasks
      .update<LinkState>(task.id, { status, state: {} }, fresh.version)
      .catch((err) => this.deps.logger.warn("account link: update failed", { err }));
  }

  private audit(
    ctx: TurnContext,
    userId: string,
    action:
      "account_link.started" | "account_link.code_sent" | "account_link.connected" | "account_link.failed",
    detail: Record<string, unknown>,
  ) {
    return this.deps.audit.record({
      action,
      turnId: ctx.turnId,
      conversationId: ctx.conversationId,
      actorUserId: userId,
      detail: { provider: this.provider, ...detail },
    });
  }
}
