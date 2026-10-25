// @campus/web — owner: P2 (front door). Server-rendered pages mounted on the API server.
//
//   /onboard        sign up / sign in: the person texts a short code to the bot from their iMessage
//                   address (spec 4.3 onboarding; self-built inverted OTP since the transport is BlueBubbles)
//   /me             account: verified addresses, groups, sign out, revoke
//   /me/memory      what the assistant has learnt (Supermemory profile) and recent memory activity
//   /me/connections connected tool accounts (ConnectionService, P4)
//   /me/settings    memory settings + consent grants/requests (P3's ConsentService)
//   /approve/:id    the payer approves the exact order total and places it (approval logic: P4's, fake for now)
//
// Security: sessions only after a server-confirmed verification; cookies HttpOnly + SameSite=Lax
// (+ Secure on https); state-changing requests are JSON POSTs that must carry our Origin; strict CSP
// with a per-response script nonce; no-referrer (nudge links carry a token). API keys never reach
// the browser.
import { type HarnessError, type MemoryProfile, personalAgentId } from "@campus/contracts";
import { type IdentityServices, type WebSession, createIdentityServices } from "@campus/identity";
import type { Container } from "@campus/worker";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerDevSimulator } from "./dev-simulator";
import { type Html, csp, esc, html, newNonce, page, raw } from "./html";

const SESSION_COOKIE = "cv_session";
const VERIFY_COOKIE = "cv_verify";

const services = new WeakMap<Container, IdentityServices>();

/**
 * P2's identity services for this container (verification, sessions, …). Null when the container
 * runs fake identity (simulator/tests): the pages then explain that sign-up is off.
 */
export function frontDoor(c: Container): IdentityServices | null {
  if (c.wiring.identity !== "real" || !c.sql) return null;
  let s = services.get(c);
  if (!s) {
    s = createIdentityServices({
      config: c.config,
      logger: c.logger,
      sql: c.sql,
      audit: c.audit,
      clock: c.clock,
      messaging: c.messaging,
    });
    services.set(c, s);
  }
  return s;
}

// ---- P3 surface beyond the ConsentService / MemoryStore interfaces (duck-typed; see context README) ----
type Grant = {
  id: string;
  purpose: string;
  audienceKind: string;
  audienceId: string;
  allowedFields: string[];
  expiresAt: string | null;
  revokedAt: string | null;
};
type ConsentRequest = { id: string; summary: string; fields: string[]; createdAt: string };
type ConsentPage = {
  listPending(userId: string): Promise<ConsentRequest[]>;
  listGrants(userId: string): Promise<Grant[]>;
  approve(requestId: string, userId: string, o?: { standing?: boolean }): Promise<unknown>;
  decline(requestId: string, userId: string): Promise<void>;
  revoke(grantId: string, userId: string): Promise<void>;
  updateMemorySettings(userId: string, patch: Record<string, unknown>): Promise<unknown>;
};
const consentPage = (c: Container): ConsentPage | null => {
  const x = c.consent as unknown as Partial<ConsentPage>;
  return typeof x.listPending === "function" && typeof x.updateMemorySettings === "function"
    ? (x as ConsentPage)
    : null;
};
type MemoryDeletion = { deleteUserMemory(userId: string): Promise<unknown> };
const memoryDeletion = (c: Container): MemoryDeletion | null => {
  const x = c.memoryStore as unknown as Partial<MemoryDeletion>;
  return typeof x.deleteUserMemory === "function" ? (x as MemoryDeletion) : null;
};

export async function registerWebRoutes(app: FastifyInstance, c: Container): Promise<void> {
  await registerDevSimulator(app, c);
  const origin = c.config.APP_ORIGIN ? new URL(c.config.APP_ORIGIN).origin : null;
  const secure = origin?.startsWith("https://") ?? false;

  const send = (reply: FastifyReply, nonce: string, body: string, status = 200) =>
    reply
      .code(status)
      .header("content-type", "text/html; charset=utf-8")
      .header("content-security-policy", csp(nonce))
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "no-store")
      .send(body);

  const cookie = (name: string, value: string, opts: { maxAgeS: number; path?: string }) =>
    `${name}=${value}; Path=${opts.path ?? "/"}; Max-Age=${opts.maxAgeS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

  /** JSON POSTs must come from our own pages (CSRF). */
  const sameOrigin = (req: FastifyRequest) => {
    const o = req.headers.origin;
    return !!o && (origin ? o === origin : true);
  };

  const session = async (req: FastifyRequest): Promise<WebSession | null> => {
    const fd = frontDoor(c);
    return fd ? fd.sessions.resolve(readCookie(req, SESSION_COOKIE)) : null;
  };

  const off = (reply: FastifyReply) => {
    const nonce = newNonce();
    return send(
      reply,
      nonce,
      page({
        title: "Sign-up is off",
        nonce,
        body: html`<h1>Sign-up is not enabled</h1>
          <p class="muted">
            This server runs with test identities (USE_REAL_IDENTITY=false), so there is nothing to sign in
            to.
          </p>`,
      }),
      503,
    );
  };

  /** Pages under /me: signed-in users only. */
  const signedIn = async (req: FastifyRequest, reply: FastifyReply): Promise<WebSession | null> => {
    if (!frontDoor(c)) {
      await off(reply);
      return null;
    }
    const s = await session(req);
    if (!s) {
      // Come back to this page after signing in (relative paths only: no open redirect).
      const next =
        req.url.startsWith("/") && !req.url.startsWith("//") ? `&next=${encodeURIComponent(req.url)}` : "";
      await reply.redirect(`/onboard?mode=login${next}`, 303);
      return null;
    }
    return s;
  };

  const jsonError = (reply: FastifyReply, err: unknown) => {
    const code = (err as HarnessError)?.code;
    const status =
      code === "invalid_phone" || code === "invalid_grant"
        ? 400
        : code === "verification_rate_limited"
          ? 429
          : code === "verification_not_found" ||
              code === "grant_not_found" ||
              code === "consent_request_not_found"
            ? 404
            : 500;
    if (status === 500) c.logger.error("web request failed", { err });
    return reply
      .code(status)
      .send({ error: status === 500 ? "Something went wrong. Try again." : (err as Error).message });
  };

  // ---------------------------------------------------------------------------------------------
  app.get("/", async (req, reply) => reply.redirect((await session(req)) ? "/me" : "/onboard", 303));
  app.get("/login", async (_req, reply) => reply.redirect("/onboard?mode=login", 303));

  app.get<{ Querystring: { t?: string; mode?: string } }>("/onboard", async (req, reply) => {
    if (!frontDoor(c)) return off(reply);
    const nonce = newNonce();
    const login = req.query.mode === "login";
    const token =
      typeof req.query.t === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(req.query.t) ? req.query.t : "";
    const agent = c.config.AGENT_DISPLAY_NAME;
    const body = html` <h1>${login ? `Sign in to ${agent}` : `Set up ${agent}`}</h1>
      <p class="muted">
        ${agent} is an AI assistant that lives in iMessage. To prove this is your number, you'll text a short
        code to the assistant from the phone you use for iMessage.
      </p>
      <div class="card" id="step1">
        <form id="start">
          ${login ? raw("") : html`<label for="name">First name</label><input id="name" name="name" type="text" maxlength="40" autocomplete="given-name" required />`}
          <label for="address">Your iMessage phone number</label>
          <input
            id="address"
            name="address"
            type="tel"
            autocomplete="tel"
            placeholder="+1 555 123 4567"
            required
          />
          <p class="small muted">Use the number (or Apple ID email) your iMessages come from.</p>
          <input type="hidden" id="t" value="${token}" />
          <button type="submit">Get my code</button>
          <p class="small status-bad" id="err" role="alert"></p>
        </form>
      </div>
      <div class="card" id="step2" hidden>
        <p>Text this code to <strong id="to"></strong> from <strong id="from"></strong>:</p>
        <div class="code" id="code"></div>
        <a class="button" id="sms" href="#">Open Messages</a>
        <p class="small muted" id="wait">
          Waiting for your text… this page updates by itself. The code expires in 10 minutes.
        </p>
      </div>
      ${login ? raw("") : html`<p class="small muted">By continuing you agree that ${agent} stores what you tell it in 1:1 chats and what's said in group chats it's in, to help you and your groups. You can see, change or delete this later in your settings.</p>`}`;
    const script = `
const $ = (id) => document.getElementById(id);
let timer = null;
$("start").addEventListener("submit", async (e) => {
  e.preventDefault(); $("err").textContent = "";
  const res = await fetch("/onboard/start", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: $("address").value, name: $("name") ? $("name").value : null, t: $("t").value || null }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $("err").textContent = data.error || "Something went wrong."; return; }
  $("code").textContent = data.code; $("to").textContent = data.sendTo; $("from").textContent = data.address;
  $("sms").href = data.smsLink; $("step1").hidden = true; $("step2").hidden = false;
  timer = setInterval(poll, 2000);
});
async function poll() {
  const res = await fetch("/onboard/status", { headers: { accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (data.status === "approved") {
    clearInterval(timer);
    const back = new URLSearchParams(location.search).get("next");
    location.href = back && back.startsWith("/") && !back.startsWith("//") && !back.startsWith("/\\") ? back : (data.next || "/me");
  }
  else if (data.status === "expired" || data.status === "failed" || res.status === 404) {
    clearInterval(timer); $("wait").textContent = "That code expired. Reload the page to get a new one.";
    $("wait").className = "small status-bad";
  }
}`;
    return send(reply, nonce, page({ title: login ? "Sign in" : "Set up", nonce, body, script }));
  });

  app.post<{ Body: { address?: unknown; name?: unknown; t?: unknown } }>(
    "/onboard/start",
    async (req, reply) => {
      const fd = frontDoor(c);
      if (!fd) return reply.code(503).send({ error: "sign-up is off" });
      if (!sameOrigin(req)) return reply.code(403).send({ error: "bad origin" });
      const b = req.body ?? {};
      try {
        const r = await fd.verification.start({
          address: typeof b.address === "string" ? b.address : "",
          displayName: typeof b.name === "string" ? b.name : null,
          challengeToken: typeof b.t === "string" ? b.t : null,
        });
        reply.header(
          "set-cookie",
          cookie(VERIFY_COOKIE, `${r.verificationId}.${r.browserToken}`, {
            maxAgeS: 15 * 60,
            path: "/onboard",
          }),
        );
        return {
          code: r.code,
          sendTo: r.sendTo,
          address: r.address,
          smsLink: r.smsLink,
          expiresAt: r.expiresAt,
        };
      } catch (err) {
        return jsonError(reply, err);
      }
    },
  );

  app.get("/onboard/status", async (req, reply) => {
    const fd = frontDoor(c);
    if (!fd) return reply.code(503).send({ error: "sign-up is off" });
    const [id, token] = (readCookie(req, VERIFY_COOKIE) ?? "").split(".");
    if (!id || !token) return reply.code(404).send({ status: "failed" });
    try {
      const r = await fd.verification.poll(id, token);
      if (r.status !== "approved") return { status: r.status };
      const cookies = [cookie(VERIFY_COOKIE, "", { maxAgeS: 0, path: "/onboard" })];
      if (r.session)
        cookies.push(
          cookie(SESSION_COOKIE, r.session.token, {
            maxAgeS: Math.floor((r.session.expiresAt.getTime() - Date.now()) / 1000),
          }),
        );
      reply.header("set-cookie", cookies);
      return { status: "approved", next: "/me" };
    } catch (err) {
      return jsonError(reply, err);
    }
  });

  app.post("/logout", async (req, reply) => {
    const fd = frontDoor(c);
    if (!sameOrigin(req)) return reply.code(403).send({ error: "bad origin" });
    const t = readCookie(req, SESSION_COOKIE);
    if (fd && t) await fd.sessions.revoke(t);
    reply.header("set-cookie", cookie(SESSION_COOKIE, "", { maxAgeS: 0 }));
    return { ok: true, next: "/onboard?mode=login" };
  });

  // ---- account ----------------------------------------------------------------------------------
  app.get("/me", async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const fd = frontDoor(c)!;
    const ids = (await fd.identity.listForUser(s.userId)).filter((i) => i.status === "verified");
    const groups = await fd.membership.groupsForUser(s.userId);
    const nonce = newNonce();
    const body = html` <h1>Hi${s.displayName ? `, ${s.displayName}` : ""}</h1>
      <p class="muted">
        You're verified. Text ${c.config.BLUEBUBBLES_BOT_ADDRESS ?? "the assistant"} anytime, or mention
        "${c.config.AGENT_DISPLAY_NAME}" in a group chat it's in.
      </p>
      <div class="card">
        <h2>Verified iMessage addresses</h2>
        <ul>
          ${ids.map((i) => html`<li><code>${i.externalId}</code></li>`)}
        </ul>
      </div>
      <div class="card">
        <h2>Group chats</h2>
        ${groups.length ? html`<p>You're in ${groups.length} group chat${groups.length === 1 ? "" : "s"} with the assistant.</p>` : html`<p class="muted">None yet. Add the assistant to a group chat and mention it.</p>`}
      </div>
      <div class="card">
        <h2>Ordering food</h2>
        <p class="small muted">
          Orders are placed on your own Grubhub account. To connect it, the admin signs it in with your user
          id: <code>${s.userId}</code>
        </p>
      </div>
      <div class="card">
        <h2>Sign out or revoke</h2>
        <button class="secondary" id="logout">Sign out</button>
        <p class="small muted">
          Revoking stops the assistant from acting for you or using your memory from now on. It can't undo
          anything it already shared or did.
        </p>
        <label
          ><input type="checkbox" id="del" /> Also delete everything the assistant remembers about me</label
        >
        <button class="danger" id="revoke">Revoke my verification</button>
      </div>`;
    const script = `
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then(r => r.json());
document.getElementById("logout").onclick = async () => { const d = await post("/logout"); location.href = d.next; };
document.getElementById("revoke").onclick = async () => {
  if (!confirm("Revoke your verification? The assistant will stop working for you until you verify again.")) return;
  const d = await post("/me/revoke", { deleteMemory: document.getElementById("del").checked }); location.href = d.next || "/onboard";
};`;
    return send(reply, nonce, page({ title: "Your account", nonce, body, script, nav: true }));
  });

  app.post<{ Body: { deleteMemory?: unknown } }>("/me/revoke", async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send({ error: "bad origin" });
    const s = await session(req);
    if (!s) return reply.code(401).send({ error: "sign in first" });
    const fd = frontDoor(c)!;
    try {
      for (const conn of await c.connections.listConnections(s.userId))
        if (conn.status !== "revoked")
          await c.connections.disconnect(s.userId, conn.server).catch(() => undefined);
      let memoryDeleted = false;
      const del = memoryDeletion(c);
      if (req.body?.deleteMemory === true && del) {
        await del.deleteUserMemory(s.userId);
        memoryDeleted = true;
      }
      await fd.identity.revokeUser(s.userId);
      await fd.sessions.revokeAllForUser(s.userId, "revoke");
      reply.header("set-cookie", cookie(SESSION_COOKIE, "", { maxAgeS: 0 }));
      return { ok: true, memoryDeleted, next: "/onboard" };
    } catch (err) {
      return jsonError(reply, err);
    }
  });

  // ---- memory: proof of what was learnt and how it was used -------------------------------------
  app.get("/me/memory", async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const fd = frontDoor(c)!;
    const nonce = newNonce();
    let personal: MemoryProfile | null = null;
    let personalError = false;
    try {
      personal = await c.memoryStore.profile({ kind: "user", userId: s.userId }, {});
    } catch (err) {
      personalError = true;
      c.logger.warn("memory page: profile failed", { err });
    }
    const groups = await fd.membership.groupsForUser(s.userId);
    const groupSections: Html[] = [];
    for (const [i, g] of groups.entries()) {
      try {
        const items = await c.memoryStore.search(
          { kind: "group", conversationId: g.conversationId },
          { query: "*", limit: 10 },
        );
        groupSections.push(
          html`<div class="card">
            <h2>Group chat ${i + 1}</h2>
            ${
              items.length
                ? html`<ul>
                    ${items.map((m) => html`<li>${m.content}</li>`)}
                  </ul>`
                : html`<p class="muted">Nothing remembered yet.</p>`
            }
          </div>`,
        );
      } catch {
        groupSections.push(
          html`<div class="card">
            <h2>Group chat ${i + 1}</h2>
            <p class="muted">Couldn't load right now.</p>
          </div>`,
        );
      }
    }
    const events = (await c.audit.query({ actorUserId: s.userId, limit: 300 }))
      .filter((e) => /^(memory|context|consent)\./.test(e.action))
      .slice(-25)
      .reverse();
    const lines = (p: MemoryProfile) => [
      ...p.static.map((t) => ({ t, k: "about you" })),
      ...p.dynamic.map((t) => ({ t, k: "recent" })),
      ...Object.entries(p.buckets).flatMap(([b, ts]) => ts.map((t) => ({ t, k: b.replace(/_/g, " ") }))),
    ];
    const personalHtml = personalError
      ? html`<p class="muted">Couldn't load your memory right now.</p>`
      : personal && lines(personal).length
        ? html`<table>
            <tr>
              <th>What it knows</th>
              <th>Topic</th>
            </tr>
            ${lines(personal).map(
              (l) =>
                html`<tr>
                  <td>${l.t}</td>
                  <td>${l.k}</td>
                </tr>`,
            )}
          </table>`
        : html`<p class="muted">
            Nothing yet. Tell the assistant something in a 1:1 chat ("I'm vegetarian", "my budget for dinner
            is $20"). New memories take about a minute to appear.
          </p>`;
    const body = html` <h1>What the assistant remembers</h1>
      <p class="muted">
        Only you and your own assistant can see your personal memory. Groups only ever get yes/no-style
        answers from it, never the facts themselves.
      </p>
      <div class="card">
        <h2>About you</h2>
        ${personalHtml}
      </div>
      ${groupSections}
      <div class="card">
        <h2>Recent memory activity</h2>
        ${
          events.length
            ? html`<table>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Result</th>
                </tr>
                ${events.map(
                  (e) =>
                    html`<tr>
                      <td>${e.createdAt ? new Date(e.createdAt).toLocaleString() : ""}</td>
                      <td><code>${e.action}</code></td>
                      <td>${e.policyResult ?? ""}</td>
                    </tr>`,
                )}
              </table>`
            : html`<p class="muted">No activity yet.</p>`
        }
      </div>`;
    return send(reply, nonce, page({ title: "Memory", nonce, body, nav: true }));
  });

  // ---- connections (P4's ConnectionService) -----------------------------------------------------
  app.get("/me/connections", async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const nonce = newNonce();
    const conns = await c.connections.listConnections(s.userId).catch(() => []);
    const body = html` <h1>Connected accounts</h1>
      <p class="muted">
        Tools the assistant can use for you. It only ever uses your own connections, and asks before anything
        that changes or buys something.
      </p>
      ${c.wiring.tools === "fake" ? html`<p class="pill status-warn">Test tools: these are built-in demo tools, not real accounts.</p>` : raw("")}
      <div class="card">
        ${
          conns.length
            ? html`<table>
                <tr>
                  <th>Service</th>
                  <th>Status</th>
                  <th></th>
                </tr>
                ${conns.map(
                  (x) =>
                    html`<tr>
                      <td>${x.server}</td>
                      <td>${x.status}</td>
                      <td>
                        ${x.status === "connected" ? html`<button class="secondary" data-disconnect="${x.server}">Disconnect</button>` : html`<button data-connect="${x.server}">Connect</button>`}
                      </td>
                    </tr>`,
                )}
              </table>`
            : html`<p class="muted">No connections yet.</p>`
        }
      </div>`;
    const script = `
document.querySelectorAll("[data-connect],[data-disconnect]").forEach((b) => b.onclick = async () => {
  const slug = b.dataset.connect || b.dataset.disconnect; const action = b.dataset.connect ? "connect" : "disconnect";
  const r = await fetch("/me/connections/" + encodeURIComponent(slug) + "/" + action, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const d = await r.json().catch(() => ({})); if (d.url) location.href = d.url; else location.reload();
});`;
    return send(reply, nonce, page({ title: "Connections", nonce, body, script, nav: true }));
  });

  app.post<{ Params: { slug: string; action: string } }>(
    "/me/connections/:slug/:action",
    async (req, reply) => {
      if (!sameOrigin(req)) return reply.code(403).send({ error: "bad origin" });
      const s = await session(req);
      if (!s) return reply.code(401).send({ error: "sign in first" });
      const slug = req.params.slug;
      if (!/^[a-z0-9_-]{1,64}$/.test(slug)) return reply.code(400).send({ error: "bad service" });
      try {
        if (req.params.action === "connect") return await c.connections.startConnection(s.userId, slug);
        if (req.params.action === "disconnect") {
          await c.connections.disconnect(s.userId, slug);
          return { ok: true };
        }
        return reply.code(404).send({ error: "unknown action" });
      } catch (err) {
        return jsonError(reply, err);
      }
    },
  );

  // ---- settings: memory + consent (P3) -----------------------------------------------------------
  app.get("/me/settings", async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const nonce = newNonce();
    const settings = await c.consent.getMemorySettings(s.userId);
    const cp = consentPage(c);
    const [grants, pending] = cp
      ? await Promise.all([cp.listGrants(s.userId), cp.listPending(s.userId)])
      : [[] as Grant[], [] as ConsentRequest[]];
    const live = grants.filter(
      (g) => !g.revokedAt && (!g.expiresAt || new Date(g.expiresAt) > c.clock.now()),
    );
    const audience = (g: Grant) =>
      g.audienceId === personalAgentId(s.userId)
        ? "your own assistant"
        : g.audienceId === "group:*"
          ? "any group you're in"
          : g.audienceKind === "group"
            ? "one group chat"
            : g.audienceId;
    const body = html` <h1>Settings</h1>
      <div class="card">
        <h2>Memory</h2>
        <label
          ><input
            type="checkbox"
            id="remember"
            ${settings.rememberEnabled ? "checked" : ""}
            ${cp ? "" : "disabled"}
          />
          Let the assistant remember things I tell it</label
        >
        <label for="retention">Forget memories after (days, empty = keep)</label>
        <input
          id="retention"
          type="number"
          min="1"
          value="${settings.retentionDays ?? ""}"
          ${cp ? "" : "disabled"}
        />
        <button id="save" ${cp ? "" : "disabled"}>Save</button>
        ${cp ? raw("") : html`<p class="small muted">Memory settings are read-only while the memory module is in test mode.</p>`}
      </div>
      <div class="card">
        <h2>Waiting for your OK</h2>
        ${
          pending.length
            ? html`<ul>
                ${pending.map((p) => html`<li>${p.summary} <button data-approve="${p.id}">Allow</button> <button class="secondary" data-decline="${p.id}">Don't allow</button></li>`)}
              </ul>`
            : html`<p class="muted">Nothing waiting.</p>`
        }
      </div>
      <div class="card">
        <h2>What you've allowed</h2>
        ${
          live.length
            ? html`<table>
                <tr>
                  <th>Shared</th>
                  <th>With</th>
                  <th>For</th>
                  <th></th>
                </tr>
                ${live.map(
                  (g) =>
                    html`<tr>
                      <td>${g.allowedFields.join(", ")}</td>
                      <td>${audience(g)}</td>
                      <td>${g.purpose.replace(/_/g, " ")}</td>
                      <td><button class="secondary" data-revoke="${g.id}">Stop</button></td>
                    </tr>`,
                )}
              </table>`
            : html`<p class="muted">Nothing shared beyond your own assistant.</p>`
        }
      </div>`;
    const script = `
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
const save = document.getElementById("save");
if (save) save.onclick = async () => {
  const v = document.getElementById("retention").value;
  await post("/me/settings/memory", { rememberEnabled: document.getElementById("remember").checked, retentionDays: v ? Number(v) : null });
  location.reload();
};
document.querySelectorAll("[data-approve]").forEach((b) => b.onclick = async () => { await post("/me/settings/requests/" + b.dataset.approve + "/approve"); location.reload(); });
document.querySelectorAll("[data-decline]").forEach((b) => b.onclick = async () => { await post("/me/settings/requests/" + b.dataset.decline + "/decline"); location.reload(); });
document.querySelectorAll("[data-revoke]").forEach((b) => b.onclick = async () => { await post("/me/settings/grants/" + b.dataset.revoke + "/revoke"); location.reload(); });`;
    return send(reply, nonce, page({ title: "Settings", nonce, body, script, nav: true }));
  });

  app.post<{ Body: { rememberEnabled?: unknown; retentionDays?: unknown } }>(
    "/me/settings/memory",
    async (req, reply) => {
      if (!sameOrigin(req)) return reply.code(403).send({ error: "bad origin" });
      const s = await session(req);
      if (!s) return reply.code(401).send({ error: "sign in first" });
      const cp = consentPage(c);
      if (!cp) return reply.code(409).send({ error: "memory settings are read-only in test mode" });
      const patch: Record<string, unknown> = {};
      if (typeof req.body?.rememberEnabled === "boolean") patch.rememberEnabled = req.body.rememberEnabled;
      const r = req.body?.retentionDays;
      if (r === null) patch.retentionDays = null;
      else if (typeof r === "number" && Number.isInteger(r) && r > 0 && r <= 3650) patch.retentionDays = r;
      try {
        await cp.updateMemorySettings(s.userId, patch);
        return { ok: true };
      } catch (err) {
        return jsonError(reply, err);
      }
    },
  );

  app.post<{ Params: { kind: string; id: string; action: string } }>(
    "/me/settings/:kind/:id/:action",
    async (req, reply) => {
      if (!sameOrigin(req)) return reply.code(403).send({ error: "bad origin" });
      const s = await session(req);
      if (!s) return reply.code(401).send({ error: "sign in first" });
      const cp = consentPage(c);
      if (!cp) return reply.code(409).send({ error: "consent is read-only in test mode" });
      const { kind, id, action } = req.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: "bad id" });
      try {
        if (kind === "grants" && action === "revoke") await cp.revoke(id, s.userId);
        else if (kind === "requests" && action === "approve")
          await cp.approve(id, s.userId, { standing: true });
        else if (kind === "requests" && action === "decline") await cp.decline(id, s.userId);
        else return reply.code(404).send({ error: "unknown action" });
        return { ok: true };
      } catch (err) {
        return jsonError(reply, err);
      }
    },
  );

  // ---- approval page (spec 18.2: UI + session by P2; approval logic is P4's, fake until stage 2) ------
  // The payer, signed in, sees exactly what will be ordered and the exact provider total, and places
  // it with one tap. The gateway then runs exactly the approved submit_order (it refuses if the
  // provider's total changed).
  app.get<{ Params: { id: string } }>("/approve/:id", async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const nonce = newNonce();
    const id = /^[0-9a-f-]{36}$/i.test(req.params.id) ? req.params.id : "";
    const task = id ? await c.orders.findByApproval(id) : null;
    const order = task?.state.order;
    if (!task || !order?.quote) {
      const body = html`<h1>Approve a payment</h1>
        <div class="card">
          <p class="muted">
            There's nothing waiting for your approval here. It may have expired or already been placed.
            Nothing has been charged.
          </p>
        </div>`;
      return send(reply, nonce, page({ title: "Approve", nonce, body, nav: true }));
    }
    if (order.payerUserId !== s.userId) {
      const body = html`<h1>Approve a payment</h1>
        <div class="card"><p>Only the person paying can approve this order.</p></div>`;
      return send(reply, nonce, page({ title: "Approve", nonce, body, nav: true }), 403);
    }
    const money = (m: number | null) => (m === null ? "—" : `$${(m / 100).toFixed(2)}`);
    const q = order.quote;
    const personal = task.type === "personal_meal";
    const provider = q.provider === "grubhub" ? "Grubhub" : q.provider;
    const you = (await c.identity.getUser(s.userId))?.displayName;
    const body = html` <h1>${personal ? "Place your order" : "Place the group order"}</h1>
      <div class="card">
        <h2>${order.restaurant} <span class="pill">${provider}</span></h2>
        <table>
          ${order.lines.map(
            (l) =>
              html`<tr>
                <td>${l.name ?? "Someone"}</td>
                <td>
                  ${l.items.map((i) => `${i.quantity > 1 ? `${i.quantity}x ` : ""}${i.name}`).join(", ")}
                </td>
                <td>${money(l.subtotalMinor)}</td>
              </tr>`,
          )}
          <tr>
            <td colspan="2">Tax</td>
            <td>${money(q.taxMinor)}</td>
          </tr>
          <tr>
            <td colspan="2">Fees</td>
            <td>${money(q.feesMinor)}</td>
          </tr>
          ${
            q.tipMinor
              ? html`<tr>
                  <td colspan="2">Tip</td>
                  <td>${money(q.tipMinor)}</td>
                </tr>`
              : raw("")
          }
          <tr>
            <th colspan="2">Total charged</th>
            <th>${money(q.totalMinor)}</th>
          </tr>
        </table>
        <p class="small muted">
          Paid with the card saved on your own ${provider} account${you ? ` (${you})` : ""}. The order is only
          placed if the restaurant's total is still exactly ${money(q.totalMinor)}.
        </p>
        ${order.splits.length ? html`<p class="small">Split after: ${order.splits.map((x) => `${x.name ?? "someone"} owes you ${money(x.owesMinor)}`).join(", ")}.</p>` : raw("")}
        <button id="place">Place order · ${money(q.totalMinor)}</button>
        <p class="small" id="result" role="status"></p>
      </div>`;
    const script = `
const b = document.getElementById("place");
b.onclick = async () => {
  b.disabled = true; b.textContent = "Placing…";
  const r = await fetch(location.pathname + "/place", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const d = await r.json().catch(() => ({}));
  document.getElementById("result").textContent = d.message || (r.ok ? "Done." : "Something went wrong.");
  document.getElementById("result").className = "small " + (d.status === "placed" ? "status-ok" : "status-bad");
  b.textContent = d.status === "placed" ? "Placed" : "Place order";
  b.disabled = d.status === "placed";
};`;
    return send(reply, nonce, page({ title: "Place order", nonce, body, script, nav: true }));
  });

  app.post<{ Params: { id: string } }>("/approve/:id/place", async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send({ error: "bad origin" });
    const s = await session(req);
    if (!s) return reply.code(401).send({ status: "forbidden", message: "Sign in first." });
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ status: "not_found" });
    try {
      const r = await c.orders.approveAndPlace(req.params.id, s.userId);
      const code =
        r.status === "placed" ? 200 : r.status === "not_found" ? 404 : r.status === "forbidden" ? 403 : 409;
      return reply.code(code).send(r);
    } catch (err) {
      return jsonError(reply, err);
    }
  });
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export { esc };
