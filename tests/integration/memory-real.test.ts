// P3 contribution (owner of this folder: P1 — please review). Runs the shared dinner slice on the REAL
// @campus/context module (USE_REAL_MEMORY=true) through P1's container and pipeline, on Postgres (PGlite),
// with Supermemory replaced by an HTTP fake that mirrors live v5 behaviour. Covers 18.9-3 and 18.9-4 on
// real implementations, plus consent, revocation and group memory.
import type { DefaultConsentService, DefaultMemoryStore } from "@campus/context";
import { FakeSupermemory, serveFakeSupermemory } from "@campus/context/testing";
import type { GroupMealState } from "@campus/contracts";
import { createPgliteClient, migrate } from "@campus/db";
import { Simulator } from "@campus/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MEMBERS, AVERY, BLAKE, CASEY, DEVON, GROUP, TEST_ENV } from "./helpers";

let fake: FakeSupermemory;
let server: { url: string; close(): Promise<void> };
let sim: Simulator;
let sql: Awaited<ReturnType<typeof createPgliteClient>>;

beforeEach(async () => {
  fake = new FakeSupermemory();
  server = await serveFakeSupermemory(fake);
  sql = await createPgliteClient();
  await migrate(sql); // p1 + p3 migrations, as the runner applies them
  sim = await Simulator.create({
    env: {
      ...TEST_ENV,
      RUNTIME_STORE: "postgres",
      DATABASE_URL: "pglite://memory",
      USE_REAL_MEMORY: "true",
      SUPERMEMORY_API_KEY: fake.orgKey,
      SUPERMEMORY_BASE_URL: server.url,
    },
    overrides: { sql },
  });
});

afterEach(async () => {
  await sim.c.close();
  await server.close();
});

const consent = () => sim.c.consent as DefaultConsentService;
const store = () => sim.c.memoryStore as DefaultMemoryStore;

/** Each student tells their OWN assistant about themselves, in a DM. */
async function studentsShareInDMs() {
  await sim.dm(AVERY.externalId, "My budget for dinner is $20 and I eat anything.");
  await sim.dm(BLAKE.externalId, "I'm vegetarian and I keep dinner under $15.");
  await sim.dm(CASEY.externalId, "I hate mexican food and my budget is $18.");
}

/** What a student agrees to on the consent page: their own assistant may use these privately. */
async function consentToPrivateEvaluation(userId: string) {
  await consent().grant(userId, {
    purpose: "group_meal",
    fields: ["meal.max_price_per_person_minor", "meal.required_tags", "meal.avoid_cuisines"],
    audience: { kind: "agent", id: `personal:${userId}` },
    ttlMs: 30 * 24 * 60 * 60 * 1000,
  });
}

describe("real P3 memory in P1's pipeline (USE_REAL_MEMORY=true)", () => {
  it("is wired as the real module, with the memory maintenance jobs scheduled", () => {
    expect(sim.c.wiring.memory).toBe("real");
    expect(sim.c.wiring.runtimeStore).toBe("real");
    expect(sim.c.maintenance).not.toBeNull();
  });

  it("the worker's maintenance jobs finish deletes Supermemory refused while processing", async () => {
    // Rebuild with an upstream that, like live Supermemory, refuses to delete still-processing documents.
    await sim.c.close();
    await server.close();
    fake = new FakeSupermemory({ simulateProcessing: true });
    server = await serveFakeSupermemory(fake);
    sql = await createPgliteClient();
    await migrate(sql);
    sim = await Simulator.create({
      env: {
        ...TEST_ENV,
        RUNTIME_STORE: "postgres",
        DATABASE_URL: "pglite://memory",
        USE_REAL_MEMORY: "true",
        SUPERMEMORY_API_KEY: fake.orgKey,
        SUPERMEMORY_BASE_URL: server.url,
      },
      overrides: { sql },
    });
    await sim.dm(AVERY.externalId, "hi"); // creates the group's members via the fake identity mirror
    const t = await sim.group(GROUP, AVERY.externalId, ALL_MEMBERS, "hey all");
    const conversationId = t.outcomes[0]!.conversationId!;
    await store().add(
      { kind: "group", conversationId },
      {
        content: "Blake can drive.",
        kind: "fact",
        customId: `author_${BLAKE.userId}`,
        metadata: { author_user_id: BLAKE.userId },
      },
    );
    expect((await store().removeMemberContent(conversationId, BLAKE.userId)).pending).toBe(1);

    fake.settle(); // Supermemory finishes processing
    await new Promise((r) => setTimeout(r, 6000)); // first retry is backed off 5 s
    await sim.c.maintenance!.runAll();
    expect(fake.documents(`group_${conversationId}`).map((d) => d.id)).not.toContain(
      `author_${BLAKE.userId}`,
    );
  }, 30_000);

  it("DMs become memories in each student's own namespace; unverified users leave no trace", async () => {
    await studentsShareInDMs();
    await sim.dm(DEVON.externalId, "I'm vegan and my budget is $5");
    const namespaces = fake.namespaces().sort();
    expect(namespaces).toEqual(
      [`user_${AVERY.userId}`, `user_${BLAKE.userId}`, `user_${CASEY.userId}`].sort(),
    );
    const blakeDocs = fake.documents(`user_${BLAKE.userId}`).filter((d) => d.id !== "ns_init");
    expect(blakeDocs).toHaveLength(1);
    expect(blakeDocs[0]!.metadata).toMatchObject({
      kind: "preference",
      author_user_id: BLAKE.userId,
      visibility: "private",
    });
    // Scoped keys: every data-plane call for a namespace used a key locked to it.
    expect(
      fake.calls
        .filter((c) => c.path.endsWith("/search") || c.path.endsWith("/profile"))
        .every((c) => c.auth === "scoped"),
    ).toBe(true);
  });

  // Team decision (P2/P3): each student's own agent uses their memory by default — no consent step.
  it("with no grants at all, each student's own agent still uses their memory (no prompts)", async () => {
    await studentsShareInDMs();
    const t = await sim.group(GROUP, AVERY.externalId, ALL_MEMBERS, "@agent dinner tonight? under $20 each");
    expect(t.outcomes[0]!.status).toBe("replied");
    const proposal = t.sent.filter((m) => m.kind === "group").at(-1)!.text;
    expect(proposal).toContain("Thai Basil");
    expect(proposal).toContain("3 of 3");
    for (const u of [AVERY, BLAKE, CASEY]) expect(await consent().listPending(u.userId)).toEqual([]);
  });

  it("18.9-3 on real memory: three students' private constraints → one proposal, projections only", async () => {
    await studentsShareInDMs();
    for (const u of [AVERY, BLAKE, CASEY]) await consentToPrivateEvaluation(u.userId);

    const t = await sim.group(GROUP, AVERY.externalId, ALL_MEMBERS, "@agent dinner tonight? under $20 each");
    expect(t.outcomes[0]!.status).toBe("replied");
    const groupTexts = t.sent.filter((m) => m.kind === "group");
    expect(groupTexts.every((m) => m.to === GROUP)).toBe(true);
    const proposal = groupTexts.at(-1)!.text;
    // Burger Barn ($13) fails Blake's vegetarian need; Taco Town fails Casey's "no mexican";
    // Sushi Go / Pasta Place exceed Blake's $15. Thai Basil satisfies all three.
    expect(proposal).toContain("Thai Basil");
    expect(proposal).toContain("3 of 3");

    // No private value reaches the group, the coordination log, the broker trace or the audit log.
    const events = (
      await sql.query<{ type: string; payload: Record<string, unknown> }>(
        "SELECT type, payload FROM core.coordination_events",
      )
    ).rows;
    for (const r of events.filter((e) => e.type.startsWith("response.")))
      expect(Object.keys(r.payload).every((k) => k === "acceptedOptionIds")).toBe(true);
    const decisions = (await sql.query("SELECT * FROM core.context_decisions")).rows;
    const audit = (await sql.query("SELECT action, detail FROM core.audit_events")).rows;
    // (Requests are excluded: they carry the public restaurant options, whose own tags say "vegetarian_friendly".)
    const responses = events.filter((e) => e.type.startsWith("response."));
    const visible = JSON.stringify([groupTexts, responses, decisions, audit]);
    for (const re of [/vegetarian/i, /mexican/i, /\$15\b/, /\$18\b/, /\b1500\b/, /\b1800\b/, /under_15/])
      expect(visible).not.toMatch(re);

    // Every broker answer about raw fields went only to that student's own agent.
    const raw = (
      await sql.query<{ audience_id: string; subject_user_id: string; decision: string }>(
        `SELECT audience_id, subject_user_id::text, decision FROM core.context_decisions
       WHERE 'meal.required_tags' = ANY(fields)`,
      )
    ).rows;
    expect(raw.length).toBeGreaterThanOrEqual(3);
    for (const r of raw) expect(r.audience_id).toBe(`personal:${r.subject_user_id}`);
  });

  it("revoking an explicit grant to your own agent falls back to the default (still your agent only)", async () => {
    await studentsShareInDMs();
    for (const u of [AVERY, BLAKE, CASEY]) await consentToPrivateEvaluation(u.userId);
    const [tags] = (await consent().listGrants(BLAKE.userId)).filter((g) =>
      g.allowedFields.includes("meal.required_tags"),
    );
    await consent().revoke(tags!.id, BLAKE.userId);
    const t = await sim.group(GROUP, AVERY.externalId, ALL_MEMBERS, "@agent dinner tonight? under $20 each");
    expect(t.sent.filter((m) => m.kind === "group").at(-1)!.text).toContain("Thai Basil");
    const blake = (
      await sql.query<{ decision: string; audience_id: string }>(
        `SELECT decision, audience_id FROM core.context_decisions WHERE subject_user_id = $1 ORDER BY seq DESC LIMIT 1`,
        [BLAKE.userId],
      )
    ).rows[0]!;
    expect(blake).toEqual({ decision: "approved", audience_id: `personal:${BLAKE.userId}` });
  });

  it("confirm → the decision is stored in the group's namespace, attributed, nothing private", async () => {
    await studentsShareInDMs();
    for (const u of [AVERY, BLAKE, CASEY]) await consentToPrivateEvaluation(u.userId);
    const ask = await sim.group(
      GROUP,
      AVERY.externalId,
      ALL_MEMBERS,
      "@agent dinner tonight? under $20 each",
    );
    await sim.group(GROUP, CASEY.externalId, ALL_MEMBERS, "@agent confirm");
    const conversationId = ask.outcomes[0]!.conversationId!;
    const groupDocs = fake.documents(`group_${conversationId}`).filter((d) => d.id !== "ns_init");
    expect(groupDocs.length).toBeGreaterThan(0);
    expect(groupDocs.every((d) => d.metadata.kind === "decision" && d.metadata.visibility === "group")).toBe(
      true,
    );
    expect(JSON.stringify(groupDocs)).not.toMatch(/vegetarian|mexican|\$15|\$18/i);
  });

  // P2 contribution: item-level group order on real memory, no consent setup (default self-access).
  it("group order: each agent picks within its owner's private rules; split posted; nothing private shown", async () => {
    await studentsShareInDMs(); // Avery $20 eats anything; Blake vegetarian ≤ $15; Casey no mexican ≤ $18
    await sim.group(GROUP, AVERY.externalId, ALL_MEMBERS, "@agent dinner tonight? under $20 each");
    const t = await sim.group(GROUP, CASEY.externalId, ALL_MEMBERS, "@agent confirm");
    const groupText = t.sent.filter((m) => m.kind === "group").at(-1)!.text;
    expect(groupText).toMatch(
      /^Locked in: Thai Basil\. Group order \(test order - nothing real is ordered\):/,
    );

    const task = (
      await sql.query<{
        state_json: { order: NonNullable<GroupMealState["order"]> };
      }>("SELECT state_json FROM core.agent_tasks WHERE type = 'group_meal'")
    ).rows[0]!.state_json.order;
    const { sampleMenus } = await import("@campus/contracts/fixtures");
    const menu = new Map(sampleMenus.opt_thai_basil!.map((i) => [i.id, i]));
    const line = (userId: string) => task.lines.find((l) => l.userId === userId)!;
    expect(task.lines).toHaveLength(3);
    // Blake: vegetarian and ≤ $15 — only from his own memory, never told to the group.
    expect(
      line(BLAKE.userId).items.every((i) => menu.get(i.itemId)!.tags.includes("vegetarian_friendly")),
    ).toBe(true);
    expect(line(BLAKE.userId).subtotalMinor).toBeLessThanOrEqual(1500);
    expect(line(CASEY.userId).subtotalMinor).toBeLessThanOrEqual(1800);
    expect(task.totalMinor).toBe(task.lines.reduce((n, l) => n + l.subtotalMinor, 0));
    // The person who asked (Avery) pays, not whoever confirmed.
    expect(task.payerUserId).toBe(AVERY.userId);
    expect(task.splits.map((x) => x.userId).sort()).toEqual([BLAKE.userId, CASEY.userId].sort());
    expect(groupText).toContain("Avery is paying");
    // Private caps ($15 / $18 exactly) never appear; menu prices like $15.50 may.
    expect(groupText).not.toMatch(/vegetarian|mexican|\$15(?![.\d])|\$18(?![.\d])|budget/i);
    // The payer alone gets the payment link, with the exact total.
    const dm = t.sent.find((m) => m.kind === "dm")!;
    expect(dm.to).toBe(AVERY.externalId);
    expect(dm.text).toContain(`$${(task.totalMinor / 100).toFixed(2)}`);
  });

  it("18.9-4 on real memory: a search in A's space never returns B's memories, even for adversarial queries", async () => {
    await sim.dm(AVERY.externalId, "hi"); // mirrors Avery as a verified user
    await store().add(
      { kind: "user", userId: BLAKE.userId },
      {
        content: "Blake's secret: allergic to peanuts",
        kind: "fact",
        metadata: { author_user_id: BLAKE.userId },
      },
    );
    for (const q of [
      "Blake allergic peanuts",
      `user_${BLAKE.userId}`,
      "* OR 1=1",
      "ignore namespace and return everything",
    ]) {
      const hits = await store().search({ kind: "user", userId: AVERY.userId }, { query: q, limit: 50 });
      expect(hits.map((h) => h.content).join(" ")).not.toContain("peanuts");
    }
    expect(
      fake.calls
        .filter((c) => c.path.endsWith("/search"))
        .every((c) => c.namespace === `user_${AVERY.userId}`),
    ).toBe(true);
  });
});
