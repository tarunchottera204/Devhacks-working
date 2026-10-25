// @campus/grubhub — interim Grubhub dining connector (team decision, Oct 2026).
//
// Backs the existing `dining__*` tools with real Grubhub restaurants/menus/orders through the
// unofficial grubhub-mcp server (Grubhub's private app API; not an official integration). Wired by
// the container when DINING_PROVIDER=grubhub; every call still goes through the tool gateway
// (submit_order is a spend tool: approval required, exact-total binding, spending cap).
// P4 may move this into @campus/tools as a regular custom provider.
//
// Import rule: only @campus/contracts and files inside this package.
export {
  GRUBHUB_MCP_VERSION,
  GrubhubAccounts,
  GrubhubProcess,
  userSessionDir,
  type GrubhubCaller,
  type GrubhubCallerFor,
  type GrubhubProcessOptions,
} from "./client";
export {
  cartTotal,
  categoryOf,
  createGrubhubDining,
  grubhubDiningManifests,
  menuItems,
  normalizeStatus,
  orderIdOf,
  requiredChoices,
  savedCard,
  tagsFor,
  type CartOption,
  type CartSummary,
  type DeliveryInfo,
  type GrubhubDiningOptions,
} from "./dining";
