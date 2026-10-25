// Task state (core.agent_tasks / core.coordination_events). Owned by P1 (TaskStore).

export type TaskOwnerType = "user" | "group";

/** Generic statuses; workflows may use their own strings, but these are understood by the runtime. */
export const TERMINAL_TASK_STATUSES = [
  "completed",
  "cancelled",
  "failed",
  "expired",
  "no_consensus",
] as const;

export type AgentTask<State = Record<string, unknown>> = {
  id: string;
  ownerType: TaskOwnerType;
  ownerId: string;
  conversationId: string | null;
  type: string;
  status: string;
  state: State;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type NewTask<State = Record<string, unknown>> = {
  ownerType: TaskOwnerType;
  ownerId: string;
  conversationId: string | null;
  type: string;
  status: string;
  state: State;
};

export type CoordinationEvent = {
  id: string;
  taskId: string;
  fromAgent: string;
  toAgent: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

// ---- group_meal task state (dinner slice) ----

export type GroupMealStatus =
  | "collecting"
  | "proposed"
  | "decided"
  | "handed_off"
  /** Real order quoted; waiting for everyone with a share to agree to it (👍 or "confirm"). */
  | "awaiting_confirmations"
  /** Real order quoted; waiting for the payer to approve the exact total. */
  | "awaiting_payment"
  /** Placed with the provider; tracking until delivered. */
  | "ordered"
  /** Provider outcome unknown (timeout/error after submit): check before any retry. */
  | "needs_reconciliation"
  | "completed"
  | "no_consensus"
  | "cancelled"
  | "failed";

export type GroupMealState = {
  params: { budgetPerPersonMinor: number | null; cuisine: string | null; notes: string | null };
  invokedByUserId: string;
  options: Array<{
    id: string;
    name: string;
    cuisine: string;
    pricePerPersonMinor: number;
    currency: string;
    distanceMeters?: number;
    tags: string[];
  }>;
  round: number;
  proposal?: {
    optionId: string;
    acceptCount: number;
    respondents: number;
    waitingOn: string[];
    /** The proposal message we sent; a 👍 on exactly this message confirms. */
    messageId?: string;
  };
  decision?: { optionId: string; decidedByUserId: string; decidedAt: string };
  handoff?: { approvalId: string; payerUserId: string; sandbox: boolean };
  /** Item-level group order built from each member's agent's picks (additive, P2 contribution). */
  order?: MealOrder;
};

/** A food order: who gets what, who pays, the provider quote and where updates go. */
export type MealOrder = {
  restaurant: string;
  currency: string;
  lines: Array<{
    userId: string;
    name: string | null;
    items: Array<{ itemId: string; name: string; quantity: number; priceMinor: number }>;
    subtotalMinor: number;
  }>;
  /** Members whose agent picked nothing (no acceptable item, or no answer). */
  notIncluded: string[];
  totalMinor: number;
  /** Pays on their own provider account: the person who asked for the order. */
  payerUserId: string;
  /** For messages, when the payer has no line of their own. */
  payerName?: string | null;
  /** Each non-payer owes the payer their share (their items + a proportional share of tax/fees). */
  splits: Array<{ userId: string; name: string | null; owesMinor: number }>;
  /** Real provider quote (exact amount the payer approves). Absent with test data. */
  quote?: {
    provider: string;
    cartId: string;
    totalMinor: number;
    subtotalMinor: number;
    taxMinor: number | null;
    feesMinor: number | null;
    tipMinor: number;
  };
  /**
   * Group orders: everyone with a share agrees to it before the payer is asked to pay. A 👍 on exactly
   * `messageId` (the order message we sent), or a "confirm" from them, counts.
   */
  confirmations?: { messageId?: string; needed: string[]; confirmed: string[] };
  /** The gateway approval for submit_order (spend). */
  approvalId?: string;
  /** Where to post order updates: the group, or the person's 1:1 chat when `dm`. */
  delivery?: { platform: string; providerConversationId: string; dm?: boolean };
  providerOrderId?: string;
  trackingStatus?: string;
  placedAt?: string;
};

// ---- personal_meal task state (one person orders for themselves in their 1:1 chat) ----

export type PersonalMealStatus =
  "awaiting_payment" | "ordered" | "needs_reconciliation" | "completed" | "cancelled" | "failed";

export type PersonalMealState = {
  userId: string;
  /** One line (theirs), no splits; paid with the card saved on their own provider account. */
  order: MealOrder;
};
