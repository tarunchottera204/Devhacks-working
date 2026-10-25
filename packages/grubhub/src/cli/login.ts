// Sign a Grubhub account in once (one-time code by email; no password is ever typed here).
//   pnpm --filter @campus/grubhub login                      the shared session (search, menus)
//   pnpm --filter @campus/grubhub login -- --user <userId>   one person's own account (their orders)
// Sessions are stored in GRUBHUB_SESSION_DIR (default ./.data/grubhub, gitignored); a person's own in
// users/<userId>/. They contain credentials: never commit or share them.
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { GrubhubProcess, userSessionDir } from "../client";

const root = resolve(process.env.GRUBHUB_SESSION_DIR ?? "../../.data/grubhub");
const userFlag = process.argv.indexOf("--user");
const userId = userFlag >= 0 ? process.argv[userFlag + 1] : undefined;
if (userFlag >= 0 && !userId) {
  process.stderr.write("Usage: login -- --user <userId>\n");
  process.exit(1);
}
const sessionDir = userId ? userSessionDir(root, userId) : root;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const gh = new GrubhubProcess({ sessionDir });
const say = (line: string) =>
  process.stdout.write(`${line}
`);

try {
  if (userId)
    say(`Signing in the Grubhub account of user ${userId}. Their orders are paid with its saved card.`);
  const email = (await rl.question("Grubhub account email: ")).trim();
  await gh.call("send_login_otp", { email });
  const code = (await rl.question("Code from the email: ")).trim();
  await gh.call("verify_login_otp", { email, code });
  const addresses = (await gh.call("get_addresses", {})) as unknown;
  const payments = (await gh.call("get_payment_methods", {})) as unknown;
  const count = (v: unknown) =>
    Array.isArray(v)
      ? v.length
      : Array.isArray((v as { addresses?: unknown[] })?.addresses)
        ? (v as { addresses: unknown[] }).addresses.length
        : "?";
  say(`Signed in. Session saved in ${sessionDir}`);
  say(`Saved addresses: ${count(addresses)}. Saved payment methods: ${count(payments)}.`);
  say(
    "Make sure the account has the delivery address and a plain credit/debit card saved in the Grubhub app (Apple Pay can't be used).",
  );
} catch (err) {
  process.stderr.write(`Login failed: ${err instanceof Error ? err.message : String(err)}
`);
  process.exitCode = 1;
} finally {
  rl.close();
  await gh.close();
}
