/* global globalThis */
import assert from "node:assert/strict";
import {test, after} from "node:test";
import {build} from "esbuild";
import {isOrderAfterBackorderCutoff, selectBackorderNotice} from "../app/backorder-automation.js";

const shop = "pilot.myshopify.com";
const orderId = "gid://shopify/Order/123";
const cutoff = "2026-09-24T21:40:39Z";
const state = {sends: [], policy: null, order: null};
globalThis.cutoffGate = state;
state.db = {notifyDockAutomationPolicy: {findUnique: async () => {
  if (state.databaseFailure) throw new Error("Database unavailable");
  return state.policy;
}}};
const bundle = await build({entryPoints: ["app/backorder-automatic-send.server.js"], bundle: true,
  platform: "node", format: "esm", write: false, plugins: [{name: "mock-external-services", setup(b) {
    b.onResolve({filter: /\/(db|shopify|klaviyo)\.server$|\/backorder-automation-shopify\.js$/}, (a) => ({path: a.path, namespace: "mock"}));
    b.onLoad({filter: /.*/, namespace: "mock"}, (a) => ({contents:
      a.path.includes("db.server") ? "export default globalThis.cutoffGate.db;"
        : a.path.includes("shopify.server") ? "export const unauthenticated={admin:async()=>({admin:{}})};"
          : a.path.includes("klaviyo") ? "export const sendNotifyDockEvent=async(payload)=>{globalThis.cutoffGate.sends.push(payload);return {metricName:'test'};};"
            : "export const loadBackorderOrder=async()=>{throw new Error('Unexpected second Shopify read');};"}));
  }}]});
const {sendAutomaticBackorderEvent} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
after(() => { delete globalThis.cutoffGate; });

async function isolated(run) {
  const saved = {...process.env};
  const values = {NOTIFY_DOCK_AUTOMATION_MODE: "off", NOTIFY_DOCK_AUTOMATION_SHOPS: shop,
    NOTIFY_DOCK_AUTOMATION_START_AT: cutoff, NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT: cutoff, NOTIFY_DOCK_FOLLOWUP_ENABLED: "true", NOTIFY_DOCK_FOLLOWUP_SHOPS: shop};
  Object.assign(process.env, values);
  Object.assign(state, {sends: [], policy: {startAt: new Date(cutoff), initialStartAt: new Date(cutoff)},
    order: {id: orderId, name: "#123", email: "test@example.com", tags: ["Backorder"], createdAt: "2026-09-24T21:53:00Z",
      lineItems: [{id: "line-1", sku: "SKU", title: "Part", currentQuantity: 1, unfulfilledQuantity: 1,
        variant: {id: "variant-1", availability: {value: "Backorder"}}}]}, databaseFailure: false});
  try { await run(); }
  finally { for (const key of Object.keys(values)) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }}
}
const send = (kind = "followup", payload) => sendAutomaticBackorderEvent({shop, orderId,
  payload: payload || selectBackorderNotice({order: state.order, config: {startAt: new Date(cutoff)},
    today: "2026-09-24", timeZone: "America/Los_Angeles"}).payload || {orderId}, kind,
  loaded: {order: state.order, today: "2026-09-24", timeZone: "America/Los_Angeles"},
  followupRecords: [{shop, orderId, status: "pending", createdAt: new Date("2026-09-24T22:00:00Z")} ]});

test("final provider gate rejects missing/changed settings, absent policy and database failures in both modes", async () => isolated(async () => {
  for (const mode of ["off", "live"]) {
    process.env.NOTIFY_DOCK_AUTOMATION_MODE = mode;
    for (const value of ["", "invalid", "2026-09-24T19:00:00Z", "2026-09-24T23:00:00Z"]) {
      process.env.NOTIFY_DOCK_AUTOMATION_START_AT = value;
      await assert.rejects(send()); await assert.rejects(send("initial"));
    }
  }
  process.env.NOTIFY_DOCK_AUTOMATION_START_AT = cutoff;
  state.policy = null;
  await assert.rejects(send());
  state.databaseFailure = true;
  await assert.rejects(send());
  assert.equal(state.sends.length, 0);
}));

test("final provider gate rejects old or unverifiable order snapshots even with an already prepared payload", async () => isolated(async () => {
  process.env.NOTIFY_DOCK_AUTOMATION_MODE = "live";
  for (const createdAt of ["2026-09-24T21:40:38.999Z", "2026-09-24T14:40:38.999-07:00",
    "2025-01-01T00:00:00Z", "2026-09-24T21:53:00", "2026-02-30T23:00:00Z", "invalid", "", null, undefined]) {
    state.order = {id: orderId, createdAt};
    await assert.rejects(send()); await assert.rejects(send("initial"));
  }
  state.order = null;
  await assert.rejects(send());
  await assert.rejects(sendAutomaticBackorderEvent({shop, orderId, payload: {orderId}, kind: "followup"}), /missing/);
  assert.equal(state.sends.length, 0);
}));

test("final provider gate binds the queued payload to the actual order and observes enable flags", async () => isolated(async () => {
  await assert.rejects(send("initial"), /disabled/);
  await assert.rejects(send("unknown"), /disabled/);
  await assert.rejects(send("followup", {orderId: "gid://shopify/Order/999"}), /identity/);
  state.order.id = "gid://shopify/Order/999";
  await assert.rejects(send());
  state.order.id = orderId; state.order.cancelledAt = cutoff;
  await assert.rejects(send());
  delete state.order.cancelledAt;
  process.env.NOTIFY_DOCK_FOLLOWUP_ENABLED = "false";
  await assert.rejects(send(), /disabled/);
  process.env.NOTIFY_DOCK_FOLLOWUP_ENABLED = "true";
  process.env.NOTIFY_DOCK_AUTOMATION_SHOPS = "other.myshopify.com";
  await assert.rejects(send());
  assert.equal(state.sends.length, 0);
}));

test("valid new orders pass the final provider gate, with UTC and Pacific boundaries equivalent", async () => isolated(async () => {
  for (const createdAt of [cutoff, "2026-09-24T14:40:39-07:00", "2026-09-24T21:53:00Z"]) {
    state.order.createdAt = createdAt;
    await send();
  }
  process.env.NOTIFY_DOCK_AUTOMATION_MODE = "live";
  await send("initial");
  assert.equal(state.sends.length, 4);
}));

test("creation cutoff remains the first eligibility decision and invalid cutoff never selects products", () => {
  const old = {createdAt: "2026-09-24T21:40:38.999Z"};
  for (const key of ["tags", "lineItems", "email"]) Object.defineProperty(old, key, {get() {throw new Error(`Reached ${key} on an older order`);}});
  assert.equal(selectBackorderNotice({order: old, config: {startAt: new Date(cutoff)}}).status, "skipped");
  assert.equal(isOrderAfterBackorderCutoff({createdAt: cutoff}, new Date("invalid")), false);
});

test("4:20pm rollout gates new initial emails while preserving previously enrolled follow-ups", async () => isolated(async () => {
  const rollout = "2026-09-30T23:20:00Z";
  process.env.NOTIFY_DOCK_AUTOMATION_MODE = "live";
  process.env.NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT = rollout;
  state.policy.initialStartAt = new Date(rollout);
  for (const createdAt of ["2026-09-25T12:00:00Z", "2026-09-30T22:30:00Z", "2026-09-30T23:00:00Z",
    "2026-09-30T23:19:59.999Z", "2026-09-30T16:19:59.999-07:00"]) {
    state.order.createdAt = createdAt;
    await assert.rejects(send("initial"), /cutoff/);
    await send("followup");
  }
  for (const createdAt of [rollout, "2026-09-30T16:20:00-07:00", "2026-09-30T23:20:00.001Z"]) {
    state.order.createdAt = createdAt;
    await send("initial");
  }
  assert.equal(state.sends.length, 8);
}));

test("new initial policy fails closed if missing or changed without disabling existing follow-ups", async () => isolated(async () => {
  process.env.NOTIFY_DOCK_AUTOMATION_MODE = "live";
  state.order.createdAt = "2026-10-01T00:00:00Z";
  state.policy.initialStartAt = new Date("2026-09-30T23:20:00Z");
  for (const value of ["", "invalid", "2026-09-30T23:19:00Z", "2026-09-30T23:21:00Z"]) {
    process.env.NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT = value;
    await assert.rejects(send("initial"));
    await send("followup");
  }
  process.env.NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT = "2026-09-30T23:20:00Z";
  state.policy.initialStartAt = null;
  await assert.rejects(send("initial"));
  state.policy.initialStartAt = new Date("2026-09-01T00:00:00Z");
  process.env.NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT = "2026-09-01T00:00:00Z";
  await assert.rejects(send("initial"));
  assert.equal(state.sends.length, 4);
}));


test("production rejects matching stale initial settings independently of migration completion", async () => isolated(async () => {
  const productionShop = "fbgure-nn.myshopify.com";
  process.env.NOTIFY_DOCK_AUTOMATION_MODE = "live";
  process.env.NOTIFY_DOCK_AUTOMATION_SHOPS = productionShop;
  const loaded = {order: state.order, today: "2026-09-30", timeZone: "America/Los_Angeles"};
  for (const stale of [cutoff, "2026-09-30T22:30:00Z", "2026-09-30T23:19:59.999Z"]) {
    state.policy.initialStartAt = new Date(stale);
    process.env.NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT = stale;
    for (const createdAt of ["2026-09-30T23:00:00Z", "2026-10-01T00:00:00Z"]) {
      state.order.createdAt = createdAt;
      const payload = selectBackorderNotice({...loaded, config: {startAt: new Date(stale)}}).payload;
      await assert.rejects(sendAutomaticBackorderEvent({shop: productionShop, orderId,
        payload: payload || {orderId}, kind: "initial", loaded}), /cutoff/);
    }
  }
  assert.equal(state.sends.length, 0);
  const rollout = "2026-09-30T23:20:00Z";
  state.policy.initialStartAt = new Date(rollout);
  process.env.NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT = rollout;
  state.order.createdAt = rollout;
  const payload = selectBackorderNotice({...loaded, config: {startAt: new Date(rollout)}}).payload;
  await sendAutomaticBackorderEvent({shop: productionShop, orderId, payload, kind: "initial", loaded});
  assert.equal(state.sends.length, 1);
}));

test("old-order follow-up provider gate requires durable pre-rollout enrollment", async () => isolated(async () => {
  const productionShop = "fbgure-nn.myshopify.com";
  process.env.NOTIFY_DOCK_AUTOMATION_SHOPS = productionShop;
  process.env.NOTIFY_DOCK_FOLLOWUP_SHOPS = productionShop;
  // Even a lingering stale initial policy cannot admit newly enrolled old orders.
  state.policy.initialStartAt = new Date("2026-09-30T22:30:00Z");
  state.order.createdAt = "2026-09-28T03:26:33Z";
  const loaded = {order: state.order, today: "2026-10-01", timeZone: "America/Los_Angeles"};
  const attempt = (followupRecords) => sendAutomaticBackorderEvent({shop: productionShop, orderId,
    payload: {orderId}, kind: "followup", loaded, followupRecords});
  const existing = {shop: productionShop, orderId, status: "batched", createdAt: new Date("2026-09-28T03:26:45Z")};
  for (const records of [undefined, [], [{...existing, createdAt: undefined}],
    [{...existing, createdAt: new Date("invalid")}], [{...existing, status: "accepted"}],
    [{...existing, shop: "other.myshopify.com"}], [{...existing, orderId: "gid://shopify/Order/999"}],
    [{...existing, createdAt: new Date("2026-09-30T23:20:00Z")}],
    [{...existing, createdAt: new Date("2026-10-01T00:00:00Z")}],
  ]) await assert.rejects(attempt(records), /pre-cutoff/);
  assert.equal(state.sends.length, 0);
  await attempt([existing]);
  assert.equal(state.sends.length, 1, "Already enrolled follow-ups retain the approved exception");
}));
