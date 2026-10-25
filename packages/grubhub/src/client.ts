import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, type Logger } from "@campus/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

// Talks to the unofficial `grubhub-mcp` server (https://github.com/aserper/grubhub-mcp, pinned) over
// stdio. That server calls Grubhub's PRIVATE app API with the Android app's client key — not an
// official integration (team decision, see packages/grubhub/README.md). It is run unmodified as a
// separate process (the repo has no license, so its code is never copied here).
//
// The Grubhub login session lives in GRUBHUB_SESSION_DIR (server-side, gitignored, never logged):
// the shared session (search, menus) at its root, and each person's own account (their cart, saved
// card, orders) in users/<userId>/.

export const GRUBHUB_MCP_VERSION = "1.1.7";

const WRAPPER_PATH = fileURLToPath(new URL("../py/campus_grubhub.py", import.meta.url));

/** Calls one grubhub-mcp tool and returns its parsed JSON. Injected in tests. */
export type GrubhubCaller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export type GrubhubProcessOptions = {
  sessionDir: string;
  /** Command that starts the server; default: uvx with the pinned package. */
  command?: string;
  args?: string[];
  logger?: Logger;
  timeoutMs?: number;
};

export class GrubhubProcess {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly opts: GrubhubProcessOptions) {}

  readonly call: GrubhubCaller = async (tool, args) => {
    const client = await this.connect();
    let res;
    try {
      res = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: this.opts.timeoutMs ?? 45_000,
      });
    } catch (err) {
      // The process may have died; reconnect on the next call.
      this.client = null;
      throw new HarnessError("provider_error", `grubhub ${tool} failed`, { cause: err, details: { tool } });
    }
    const text = Array.isArray(res.content)
      ? res.content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("")
      : "";
    if (res.isError)
      throw new HarnessError(
        "provider_error",
        `grubhub ${tool} returned an error: ${text.replace(/\s+/g, " ").slice(0, 300)}`,
        {
          details: { tool },
        },
      );
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HarnessError("provider_error", `grubhub ${tool} returned non-JSON`, { details: { tool } });
    }
    if (json && typeof json === "object" && "error" in json && Object.keys(json).length <= 2) {
      // grubhub-mcp reports e.g. {"error": "Must be logged in to place an order"}; our cart tools
      // add Grubhub's HTTP status ({"error", "status"}), which tells a refusal from an unknown outcome.
      const status = (json as { status?: unknown }).status;
      throw new HarnessError(
        "provider_error",
        `grubhub ${tool}: ${String((json as { error: unknown }).error).slice(0, 200)}`,
        {
          details: { tool, ...(typeof status === "number" ? { status } : {}) },
        },
      );
    }
    return json;
  };

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => undefined);
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.opts.command ?? "uv",
        // Our wrapper (py/campus_grubhub.py): the unmodified grubhub-mcp server plus working cart tools.
        args: this.opts.args ?? [
          "run",
          "--quiet",
          "--no-project",
          "--with",
          `grubhub-mcp==${GRUBHUB_MCP_VERSION}`,
          "python",
          WRAPPER_PATH,
        ],
        // UTF-8 stdio: on Windows Python otherwise writes the legacy code page, and a menu with "™"
        // breaks the JSON-RPC reply (the call then hangs until timeout).
        env: {
          ...getDefaultEnvironment(),
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          GRUBHUB_SESSION_DIR: this.opts.sessionDir,
        },
        stderr: process.env.GRUBHUB_DEBUG ? "inherit" : "ignore",
      });
      const client = new Client({ name: "campus-agent", version: "0.0.0" });
      await client.connect(transport);
      transport.onclose = () => {
        if (this.client === client) this.client = null;
      };
      this.client = client;
      this.opts.logger?.info("grubhub connector started", { version: GRUBHUB_MCP_VERSION });
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
}

/** grubhub-mcp's session file inside a session dir; present once someone has signed in. */
const SESSION_FILE = "session.json";

/** Where one person's own Grubhub session lives: <sessionDir>/users/<userId>. */
export function userSessionDir(sessionDir: string, userId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new HarnessError("tool_args_invalid", "bad user id");
  return join(sessionDir, "users", userId);
}

/** Resolves a person's own Grubhub account; null = they haven't signed in. */
export type GrubhubCallerFor = (userId: string) => GrubhubCaller | null;

/**
 * Each person's own Grubhub account: one grubhub-mcp process per person who has signed in (with
 * `pnpm --filter @campus/grubhub login -- --user <userId>`), started on first use.
 */
export class GrubhubAccounts {
  private readonly processes = new Map<string, GrubhubProcess>();

  /** `sessionDir`: the GRUBHUB_SESSION_DIR root (each person's session is under users/<userId>). */
  constructor(private readonly opts: GrubhubProcessOptions) {}

  readonly forUser: GrubhubCallerFor = (userId) => {
    const dir = userSessionDir(this.opts.sessionDir, userId);
    if (!existsSync(join(dir, SESSION_FILE))) return null;
    let p = this.processes.get(userId);
    if (!p) {
      p = new GrubhubProcess({ ...this.opts, sessionDir: dir });
      this.processes.set(userId, p);
    }
    return p.call;
  };

  async close(): Promise<void> {
    const all = [...this.processes.values()];
    this.processes.clear();
    await Promise.all(all.map((p) => p.close()));
  }
}
