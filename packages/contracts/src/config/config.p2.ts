import { z } from "zod";
import { type ConfigSection, flag, int, missingIf, optionalString } from "./shared";

// P2 (front door) configuration. Owned by P2; extend here.
// iMessage transport: BlueBubbles (a BlueBubbles Server on a Mac signed into the bot's Apple ID).
const schema = z.object({
  USE_REAL_MESSAGING: flag(),
  USE_REAL_IDENTITY: flag(),
  /** BlueBubbles Server URL, e.g. https://xyz.ngrok.app (the server's own tunnel). */
  BLUEBUBBLES_URL: optionalString(),
  /** BlueBubbles Server password (sent as the `password` query parameter; never logged). */
  BLUEBUBBLES_PASSWORD: optionalString(),
  /**
   * BlueBubbles webhooks carry no signature, so the URL registered in BlueBubbles includes this
   * secret: <API origin>/webhooks/bluebubbles?token=<secret>. Requests without it are rejected.
   */
  BLUEBUBBLES_WEBHOOK_SECRET: optionalString(),
  /** The bot's iMessage address people text (phone in E.164, or its Apple ID email). Shown on sign-up. */
  BLUEBUBBLES_BOT_ADDRESS: optionalString(),
  /** apple-script works everywhere; private-api needs the BlueBubbles Private API helper (enables replies). */
  BLUEBUBBLES_SEND_METHOD: z.enum(["apple-script", "private-api"]).default("apple-script"),
  /** Reply in-thread to the triggering message (needs BLUEBUBBLES_SEND_METHOD=private-api). */
  BLUEBUBBLES_INLINE_REPLIES: flag(),
  BLUEBUBBLES_MAX_SENDS_PER_SECOND: int(2),
  /** Public origin of the onboarding/settings pages (served by the API process under /onboard, /me). */
  APP_ORIGIN: optionalString(),
  NUDGE_INTERVAL_HOURS: int(6),
  /**
   * Dev only: a web chat simulator at /dev/chat plus a fake BlueBubbles server at /dev/bluebubbles,
   * so the whole front door runs without a Mac (point BLUEBUBBLES_URL at <API>/dev/bluebubbles).
   * Refused in production.
   */
  DEV_SIMULATOR: flag(),
  /**
   * Interim dining connector (team decision; P4 may absorb it): "grubhub" backs the dining__* tools
   * with real Grubhub restaurants/menus/orders via the unofficial grubhub-mcp server. "fake" = test data.
   */
  DINING_PROVIDER: z.enum(["fake", "grubhub"]).default("fake"),
  /** Where food is delivered (search + menus are location-specific). */
  DELIVERY_LATITUDE: z.coerce.number().min(-90).max(90).optional(),
  DELIVERY_LONGITUDE: z.coerce.number().min(-180).max(180).optional(),
  /** Delivery address + the contact the courier uses (Grubhub requires them on every cart). */
  DELIVERY_STREET: optionalString(),
  DELIVERY_UNIT: optionalString(),
  DELIVERY_CITY: optionalString(),
  DELIVERY_STATE: optionalString(),
  DELIVERY_POSTAL_CODE: optionalString(),
  DELIVERY_INSTRUCTIONS: optionalString(),
  DELIVERY_PHONE: optionalString(),
  DELIVERY_EMAIL: optionalString(),
  /** Grubhub login session (contains credentials; gitignored). */
  GRUBHUB_SESSION_DIR: z.string().default("./.data/grubhub"),
  /** Hard cap per real order, in cents. */
  GRUBHUB_MAX_ORDER_MINOR: int(8000),
  /**
   * Actually place Grubhub orders (attach the payer's saved card, then check out). Off until those
   * calls are verified against a real grubhub.com checkout; until then submit_order fails closed.
   */
  GRUBHUB_CHECKOUT_ENABLED: flag(),
});

export const configSectionP2: ConfigSection<typeof schema> = {
  owner: "P2",
  schema,
  required: (cfg, all) => [
    ...missingIf(cfg.USE_REAL_MESSAGING, cfg, [
      "BLUEBUBBLES_URL",
      "BLUEBUBBLES_PASSWORD",
      "BLUEBUBBLES_WEBHOOK_SECRET",
    ]),
    ...missingIf(cfg.USE_REAL_IDENTITY, cfg, ["APP_ORIGIN", "BLUEBUBBLES_BOT_ADDRESS"]),
    // Sign-up codes are texted to the bot and matched on the real inbound webhook.
    ...(cfg.USE_REAL_IDENTITY && !cfg.USE_REAL_MESSAGING ? ["USE_REAL_MESSAGING=true (sign-up codes)"] : []),
    ...(cfg.DEV_SIMULATOR && all.NODE_ENV === "production"
      ? ["DEV_SIMULATOR=false (not allowed in production)"]
      : []),
    ...missingIf(cfg.DINING_PROVIDER === "grubhub", cfg, [
      "DELIVERY_LATITUDE",
      "DELIVERY_LONGITUDE",
      "DELIVERY_STREET",
      "DELIVERY_CITY",
      "DELIVERY_STATE",
      "DELIVERY_POSTAL_CODE",
      "DELIVERY_PHONE",
      "DELIVERY_EMAIL",
    ]),
    ...missingIf(cfg.USE_REAL_IDENTITY, all, ["DATABASE_URL"]),
    ...(cfg.USE_REAL_IDENTITY && all.RUNTIME_STORE !== "postgres" ? ["RUNTIME_STORE=postgres"] : []),
  ],
  secrets: ["BLUEBUBBLES_PASSWORD", "BLUEBUBBLES_WEBHOOK_SECRET"],
};
