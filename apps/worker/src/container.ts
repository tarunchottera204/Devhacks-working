import {
  DeterministicCoordinator,
  GroupAgentRegistry,
  InProcessCoordinationBus,
  AccountLinkFlow,
  type DiningAccounts,
  OrderService,
  PersonalAgentRegistry,
  type QuotedCart,
  type WebApprovals,
} from "@campus/agents";
import {
  type AppConfig,
  type ApprovalService,
  type AuditLog,
  type AuthGate,
  type BucketProvisioner,
  type Clock,
  type ConnectionService,
  type ConsentService,
  type ContextBroker,
  type ContextModule,
  type IdentityModule,
  type IdentityService,
  type InboundQueue,
  type Logger,
  type MemoryPolicy,
  type MemoryStore,
  type MembershipService,
  type MessageLog,
  type MessagingAdapter,
  type ModelClient,
  type ModuleDeps,
  ModuleNotImplementedError,
  type NudgeService,
  type PermissionResolver,
  REAL_MODULES,
  type SqlClient,
  type TaskStore,
  type ToolGateway,
  type ToolManifest,
  type ToolProposal,
  type ToolsModule,
  type TurnContext,
  createLogger,
  invocationNames,
  loadConfig,
  systemClock,
} from "@campus/contracts";
import {
  FakeApprovalService,
  FakeAuthGate,
  FakeBucketProvisioner,
  FakeConnectionService,
  FakeConsentService,
  FakeContextBroker,
  FakeIdentityService,
  FakeMembershipService,
  FakeMemoryPolicy,
  FakeMemoryStore,
  FakeMessagingAdapter,
  FakeModelClient,
  FakeNudgeService,
  FakePermissionResolver,
  FakeToolGateway,
  FakeToolProvider,
  InMemoryAuditLog,
  InMemoryInboundQueue,
  InMemoryMessageLog,
  InMemoryTaskStore,
  heuristicResponder,
} from "@campus/contracts/fakes";
import { sampleToolManifests } from "@campus/contracts/fixtures";
import { PgAuditLog, PgInboundQueue, PgMessageLog, PgTaskStore, createSqlClient } from "@campus/db";
import {
  GrubhubAccounts,
  type GrubhubCaller,
  type GrubhubCallerFor,
  GrubhubProcess,
  createGrubhubDining,
  savedCard,
} from "@campus/grubhub";
import {
  AgentRuntimeImpl,
  AnthropicModelClient,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  GeminiModelClient,
  MaintenanceScheduler,
  QueueWorker,
  TurnPipelineImpl,
  budgetsFromConfig,
} from "@campus/harness";
import { MirroringIdentityService, MirroringMembershipService } from "./dev-pg-mirror";

// Dependency-injection container (spec 18.3 item 7). Each USE_REAL_* flag selects the owner's real
// implementation (loaded by its factory export, see REAL_MODULES) or the in-memory fake.
// This file is the only place that names concrete implementations.

export type Container = {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  sql: SqlClient | null;
  audit: AuditLog;
  tasks: TaskStore;
  queue: InboundQueue;
  messageLog: MessageLog;
  messaging: MessagingAdapter;
  identity: IdentityService;
  membership: MembershipService;
  authGate: AuthGate;
  nudges: NudgeService;
  memoryStore: MemoryStore;
  broker: ContextBroker;
  consent: ConsentService;
  buckets: BucketProvisioner;
  memoryPolicy: MemoryPolicy;
  approvals: ApprovalService;
  gateway: ToolGateway;
  permissions: PermissionResolver;
  connections: ConnectionService;
  model: ModelClient;
  runtime: AgentRuntimeImpl;
  pipeline: TurnPipelineImpl;
  worker: QueueWorker;
  /** Background jobs (memory cleanup/retention/group chat, order tracking). Start with the worker. */
  maintenance: MaintenanceScheduler | null;
  /** Real orders (group and personal): payer approval → place → delivery tracking. */
  orders: OrderService;
  /** Which implementation each slot uses ("fake" | "real"), for logs and the simulator banner. */
  wiring: Record<string, "fake" | "real">;
  /** Present when the corresponding fakes are wired (simulator/test seeding). */
  fakes: {
    messaging?: FakeMessagingAdapter;
    identity?: FakeIdentityService;
    broker?: FakeContextBroker;
    consent?: FakeConsentService;
    memoryStore?: FakeMemoryStore;
    connections?: FakeConnectionService;
    toolProvider?: FakeToolProvider;
    approvals?: FakeApprovalService;
    permissions?: FakePermissionResolver;
    model?: FakeModelClient;
  };
  close(): Promise<void>;
};

export type ContainerOverrides = Partial<
  Pick<Container, "messaging" | "model" | "audit" | "tasks" | "queue" | "messageLog"> & {
    sql: SqlClient;
    /** Tests: a fake Grubhub instead of starting the grubhub-mcp process (DINING_PROVIDER=grubhub). */
    diningCaller: GrubhubCaller;
    /** Tests: each person's own fake Grubhub account (null = not signed in). */
    diningCallerFor: GrubhubCallerFor;
    /** Tests: the fake Grubhub a person signs in on (send/verify the emailed code). */
    diningLoginFor: (userId: string) => GrubhubCaller;
  }
>;

/**
 * Fake approvals that also notice a personal order: when a 1:1 chat's agent proposes
 * dining__submit_order, the order is recorded so the payer's approval page can show and place it.
 * (Fake tools path only; P4's gateway doesn't do this yet.)
 */
class SpendAwareApprovals extends FakeApprovalService {
  onPersonalSpend: ((ctx: TurnContext, approvalId: string, args: unknown) => Promise<unknown>) | null = null;

  override async createToolAsk(ctx: TurnContext, input: { proposal: ToolProposal; manifest: ToolManifest }) {
    const ask = await super.createToolAsk(ctx, input);
    const m = input.manifest;
    if (
      this.onPersonalSpend &&
      ctx.conversationType === "dm" &&
      m.riskClass === "spend" &&
      m.server === "dining" &&
      m.name === "submit_order"
    )
      await this.onPersonalSpend(ctx, ask.approvalId, input.proposal.args);
    return ask;
  }
}

async function loadReal<T>(key: keyof typeof REAL_MODULES, deps: unknown): Promise<T> {
  const spec = REAL_MODULES[key];
  const mod = (await import(spec.pkg)) as Record<string, unknown>;
  const factory = mod[spec.exportName];
  if (typeof factory !== "function") throw new ModuleNotImplementedError(spec.pkg, spec.exportName);
  return (await (factory as (d: unknown) => T | Promise<T>)(deps)) as T;
}

export async function buildContainer(
  opts: {
    config?: AppConfig;
    env?: Record<string, string | undefined>;
    overrides?: ContainerOverrides;
    logger?: Logger;
    clock?: Clock;
  } = {},
): Promise<Container> {
  const config = opts.config ?? loadConfig(opts.env ?? process.env);
  const logger = opts.logger ?? createLogger({ level: config.LOG_LEVEL });
  const clock = opts.clock ?? systemClock;
  const o = opts.overrides ?? {};
  const wiring: Container["wiring"] = {};
  const fakes: Container["fakes"] = {};
  const closers: Array<() => Promise<void>> = [];

  // ---- database handles ----
  const needsDb =
    config.RUNTIME_STORE === "postgres" ||
    config.USE_REAL_IDENTITY ||
    config.USE_REAL_MEMORY ||
    config.USE_REAL_TOOLS;
  let sql: SqlClient | null = o.sql ?? null;
  if (!sql && needsDb && config.DATABASE_URL) {
    sql = await createSqlClient(config.DATABASE_URL);
    closers.push(() => sql!.close());
  }
  let sqlVault: SqlClient | null = null;
  if (config.USE_REAL_TOOLS && config.DATABASE_URL_VAULT) {
    sqlVault = await createSqlClient(config.DATABASE_URL_VAULT);
    closers.push(() => sqlVault!.close());
  }

  // ---- P1 runtime stores ----
  const pg = config.RUNTIME_STORE === "postgres" && sql;
  const audit = o.audit ?? (pg ? new PgAuditLog(sql!) : new InMemoryAuditLog(clock));
  const tasks = o.tasks ?? (pg ? new PgTaskStore(sql!) : new InMemoryTaskStore(clock));
  const queue = o.queue ?? (pg ? new PgInboundQueue(sql!) : new InMemoryInboundQueue(clock));
  wiring.runtimeStore = pg ? "real" : "fake";

  const moduleDeps: ModuleDeps = { config, logger, sql, audit, clock };

  // ---- P2: messaging ----
  let messaging: MessagingAdapter;
  if (o.messaging) messaging = o.messaging;
  else if (config.USE_REAL_MESSAGING) messaging = await loadReal<MessagingAdapter>("messaging", moduleDeps);
  else messaging = fakes.messaging = new FakeMessagingAdapter();
  wiring.messaging = config.USE_REAL_MESSAGING && !o.messaging ? "real" : "fake";

  // ---- P2: identity, membership, auth gate, nudges ----
  let identity: IdentityService, membership: MembershipService, authGate: AuthGate, nudges: NudgeService;
  if (config.USE_REAL_IDENTITY) {
    ({ identity, membership, authGate, nudges } = await loadReal<IdentityModule>("identity", {
      ...moduleDeps,
      messaging,
    }));
    wiring.identity = "real";
  } else {
    const fakeIdentity = (fakes.identity = new FakeIdentityService({ defaultStatus: "verified" }));
    const fakeMembership = new FakeMembershipService(fakeIdentity, clock);
    // Dev glue: with fake identity + Postgres runtime store, mirror identities/conversations into the
    // P2 tables so core.messages / core.agent_tasks foreign keys hold. Never used with real identity.
    identity = pg ? new MirroringIdentityService(fakeIdentity, sql!) : fakeIdentity;
    membership = pg ? new MirroringMembershipService(fakeMembership, fakeIdentity, sql!) : fakeMembership;
    authGate = new FakeAuthGate();
    nudges = new FakeNudgeService(messaging, {
      ...(config.APP_ORIGIN ? { appOrigin: config.APP_ORIGIN } : {}),
      intervalHours: config.NUDGE_INTERVAL_HOURS,
      clock,
    });
    wiring.identity = "fake";
  }

  const messageLog =
    o.messageLog ??
    (pg
      ? new PgMessageLog(sql!)
      : new InMemoryMessageLog((id) => {
          const rec = fakes.identity?.byExternalIdentityId(id);
          return rec
            ? { userId: rec.status === "verified" ? rec.userId : null, displayName: rec.displayName }
            : undefined;
        }));

  // ---- P3: memory, broker, consent ----
  let memoryStore: MemoryStore,
    broker: ContextBroker,
    consent: ConsentService,
    buckets: BucketProvisioner,
    memoryPolicy: MemoryPolicy;
  let maintenance: MaintenanceScheduler | null = null;
  let memoryMaintenance: ContextModule["maintenance"] | undefined;
  if (config.USE_REAL_MEMORY) {
    const contextModule = await loadReal<ContextModule>("context", { ...moduleDeps, membership });
    ({ memoryStore, broker, consent, buckets, memoryPolicy } = contextModule);
    memoryMaintenance = contextModule.maintenance;
    wiring.memory = "real";
  } else {
    memoryStore = fakes.memoryStore = new FakeMemoryStore();
    broker = fakes.broker = new FakeContextBroker();
    consent = fakes.consent = new FakeConsentService();
    buckets = new FakeBucketProvisioner();
    memoryPolicy = new FakeMemoryPolicy(consent);
    wiring.memory = "fake";
  }

  // ---- P4: approvals, tools ----
  let approvals: ApprovalService,
    gateway: ToolGateway,
    permissions: PermissionResolver,
    connections: ConnectionService;
  let describeCart: ((cartId: string) => QuotedCart | null) | undefined;
  let diningAccounts: DiningAccounts | undefined;
  let spendAware: SpendAwareApprovals | null = null;
  if (config.USE_REAL_TOOLS) {
    approvals = await loadReal<ApprovalService>("approvals", moduleDeps);
    ({ gateway, permissions, connections } = await loadReal<ToolsModule>("tools", {
      ...moduleDeps,
      sqlVault,
      approvals,
      broker,
    }));
    wiring.tools = "real";
  } else {
    // Interim real dining connector (DINING_PROVIDER=grubhub): the dining__* tools come from Grubhub;
    // everything still goes through the gateway (submit_order is spend: approval + cap).
    let provider: FakeToolProvider;
    if (config.DINING_PROVIDER === "grubhub") {
      // Search and menus: the shared session. Quotes, orders and tracking: each person's own account.
      let call = o.diningCaller;
      let callFor = o.diningCallerFor;
      if (!call) {
        const gh = new GrubhubProcess({ sessionDir: config.GRUBHUB_SESSION_DIR, logger });
        closers.push(() => gh.close());
        call = gh.call;
      }
      let loginFor = o.diningLoginFor;
      if (!callFor && !o.diningCaller) {
        const accounts = new GrubhubAccounts({ sessionDir: config.GRUBHUB_SESSION_DIR, logger });
        closers.push(() => accounts.close());
        callFor = accounts.forUser;
        loginFor = accounts.loginCaller;
      }
      // People connect their own account from their 1:1 chat ("connect grubhub" → emailed code).
      if (callFor && loginFor) {
        const accountFor = callFor;
        const login = loginFor;
        diningAccounts = {
          provider: "Grubhub",
          isConnected: (userId) => accountFor(userId) !== null,
          sendCode: async (userId, email) => {
            await login(userId)("send_login_otp", { email });
          },
          verifyCode: async (userId, email, code) => {
            const gh = login(userId);
            await gh("verify_login_otp", { email, code });
            const payments = await gh("get_payment_methods", {}).catch(() => undefined);
            return { hasCard: payments === undefined ? null : savedCard(payments) !== null };
          },
        };
      }
      const dining = createGrubhubDining({
        call,
        ...(callFor ? { callFor } : {}),
        checkoutEnabled: config.GRUBHUB_CHECKOUT_ENABLED,
        latitude: config.DELIVERY_LATITUDE!,
        longitude: config.DELIVERY_LONGITUDE!,
        // Required by the config loader when DINING_PROVIDER=grubhub.
        delivery: {
          street: config.DELIVERY_STREET!,
          city: config.DELIVERY_CITY!,
          state: config.DELIVERY_STATE!,
          postalCode: config.DELIVERY_POSTAL_CODE!,
          phone: config.DELIVERY_PHONE!,
          email: config.DELIVERY_EMAIL!,
          ...(config.DELIVERY_UNIT ? { unit: config.DELIVERY_UNIT } : {}),
          ...(config.DELIVERY_INSTRUCTIONS ? { instructions: config.DELIVERY_INSTRUCTIONS } : {}),
        },
        maxOrderMinor: config.GRUBHUB_MAX_ORDER_MINOR,
        logger,
      });
      provider = new FakeToolProvider([
        ...sampleToolManifests.filter((m) => m.server !== "dining"),
        ...dining.manifests,
      ]);
      for (const [tool, fn] of Object.entries(dining.handlers)) provider.handle("dining", tool, fn);
      describeCart = dining.describeCart;
      wiring.dining = "real"; // Grubhub
    } else provider = new FakeToolProvider();
    fakes.toolProvider = provider;
    const fakeConnections = (fakes.connections = new FakeConnectionService({ defaultConnected: true }));
    const fakePermissions = (fakes.permissions = new FakePermissionResolver());
    const fakeApprovals =
      (fakes.approvals =
      spendAware =
        new SpendAwareApprovals({
          ...(config.APP_ORIGIN ? { appOrigin: config.APP_ORIGIN } : {}),
          clock,
        }));
    approvals = fakeApprovals;
    permissions = fakePermissions;
    connections = fakeConnections;
    gateway = new FakeToolGateway({
      provider,
      connections: fakeConnections,
      permissions: fakePermissions,
      approvals: fakeApprovals,
    });
    wiring.tools = "fake";
  }

  // ---- P1: model, runtime, agents, pipeline, worker ----
  let model: ModelClient;
  if (o.model) model = o.model;
  else if (config.USE_REAL_MODEL) {
    const common = {
      apiKey: config.MODEL_API_KEY!,
      effort: config.MODEL_EFFORT,
      structuredOutput: config.MODEL_STRUCTURED_OUTPUT,
      logger,
    };
    model =
      config.MODEL_PROVIDER === "gemini"
        ? new GeminiModelClient({ ...common, model: config.MODEL_NAME ?? DEFAULT_GEMINI_MODEL })
        : new AnthropicModelClient({ ...common, model: config.MODEL_NAME ?? DEFAULT_ANTHROPIC_MODEL });
  } else model = fakes.model = new FakeModelClient(heuristicResponder);
  wiring.model = config.USE_REAL_MODEL && !o.model ? "real" : "fake";

  const budgets = budgetsFromConfig(config);
  const runtime = new AgentRuntimeImpl({
    model,
    gateway,
    approvals,
    audit,
    logger,
    clock,
    budgets,
    rateLimits: {
      userModelCallsPer10Min: config.RATE_LIMIT_USER_MODEL_CALLS_PER_10MIN,
      conversationModelCallsPer10Min: config.RATE_LIMIT_CONVERSATION_MODEL_CALLS_PER_10MIN,
    },
  });

  const names = invocationNames(config);
  const accountLink = diningAccounts
    ? new AccountLinkFlow({ tasks, accounts: diningAccounts, audit, clock, logger })
    : undefined;
  const personalAgents = new PersonalAgentRegistry({
    ...(accountLink ? { accountLink } : {}),
    runtime,
    broker,
    memoryStore,
    audit,
    logger,
    clock,
    agentName: config.AGENT_DISPLAY_NAME,
  });
  const bus = new InProcessCoordinationBus({
    personalAgents,
    tasks,
    audit,
    logger,
    clock,
    timeoutMs: 10_000,
  });
  const groupAgents = new GroupAgentRegistry({
    runtime,
    tasks,
    membership,
    coordinator: new DeterministicCoordinator(),
    bus,
    broker,
    memoryStore,
    approvals,
    audit,
    logger,
    clock,
    agentName: config.AGENT_DISPLAY_NAME,
    invocationHint: names[0] ?? "agent",
    optionsTool: config.GROUP_MEAL_OPTIONS_TOOL,
    ...(accountLink ? { accountLink } : {}),
  });

  // Real orders, group and personal (payer approval → place → tracking). Scheduled with the memory jobs.
  const orders = new OrderService({
    tasks,
    gateway,
    messaging,
    approvals: approvals as unknown as WebApprovals,
    identity,
    audit,
    clock,
    logger,
    statusTool: config.GROUP_MEAL_OPTIONS_TOOL.replace(/__.+$/, "__order_status"),
    ...(describeCart ? { describeCart } : {}),
  });
  if (spendAware)
    spendAware.onPersonalSpend = (ctx, approvalId, args) => orders.recordPersonalOrder(ctx, approvalId, args);
  const orderJob = { name: "orders.track", everyMs: 30_000, run: () => orders.trackOrders() };
  maintenance = memoryMaintenance
    ? MaintenanceScheduler.forMemory(memoryMaintenance, {
        cleanupEveryMs: config.MEMORY_CLEANUP_INTERVAL_MS,
        purgeEveryMs: config.MEMORY_PURGE_INTERVAL_MS,
        groupIngestEveryMs: config.MEMORY_GROUP_INGEST_INTERVAL_MS,
        extraJobs: [orderJob],
        logger,
      })
    : new MaintenanceScheduler([orderJob], logger);

  const pipeline = new TurnPipelineImpl({
    queue,
    messageLog,
    audit,
    logger,
    clock,
    budgets,
    invocationNames: names,
    messaging,
    identity,
    membership,
    authGate,
    nudges,
    memoryStore,
    memoryPolicy,
    approvals,
    gateway,
    runtime,
    personalAgents,
    groupAgents,
  });

  const worker = new QueueWorker({
    queue,
    pipeline,
    audit,
    logger,
    clock,
    maxAttempts: config.QUEUE_MAX_ATTEMPTS,
    pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
    concurrency: Math.max(1, config.WORKER_CONCURRENCY),
  });

  logger.info("container ready", { wiring });

  return {
    config,
    logger,
    clock,
    sql,
    audit,
    tasks,
    queue,
    messageLog,
    messaging,
    identity,
    membership,
    authGate,
    nudges,
    memoryStore,
    broker,
    consent,
    buckets,
    memoryPolicy,
    approvals,
    gateway,
    permissions,
    connections,
    model,
    runtime,
    pipeline,
    worker,
    maintenance,
    orders,
    wiring,
    fakes,
    close: async () => {
      await worker.stop();
      await maintenance?.stop();
      for (const c of closers.reverse()) await c().catch(() => undefined);
    },
  };
}
