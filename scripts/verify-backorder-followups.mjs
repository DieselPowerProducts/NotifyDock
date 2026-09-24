/* global globalThis */
import assert from "node:assert/strict";
import {test} from "node:test";
import {build} from "esbuild";
import {genericFollowupCandidates, nextFollowupCheck, resolveFollowupItem} from "../app/backorder-followup.js";
const now = new Date("2026-09-24T20:55:00Z");
const line = (id, kind = "Backorder") => ({id, sku: id, title: id, currentQuantity: 1, unfulfilledQuantity: 1,
  variant: {id: `v-${id}`, product: {vendor: "Red-Head Steering Gears Inc."}, availability: {value: kind},
    availabilityDate: {type: "date", value: "2026-10-15"}, buildToOrderMessage: {type: "single_line_text_field", value: "Ships in 2 weeks"}}});
const order = {id: "order-1", name: "#1", lineItems: [line("A"), line("B", "Built to Order"), line("UNTRACKED")]};
test("daily checks use 5pm Pacific through daylight saving, with one future test time", () => {
  assert.equal(nextFollowupCheck(now).toISOString(), "2026-09-25T00:00:00.000Z");
  assert.equal(nextFollowupCheck(new Date("2026-12-01T20:00:00Z")).toISOString(), "2026-12-02T01:00:00.000Z");
  assert.equal(nextFollowupCheck(new Date("2026-09-24T20:50:00Z"), now.toISOString()).toISOString(), now.toISOString());
  assert.equal(nextFollowupCheck(now, now.toISOString()).toISOString(), "2026-09-25T00:00:00.000Z");
});
test("only generic items actually included in the manual email can be tracked", () => {
  const input = {order, emailType: "dynamic_shipping_delay", products: [{sku: "A", delayState: "no_confirmed_date"}, {sku: "B", delayState: "build_to_order_message", delayMessage: "Ships soon"}]};
  assert.deepEqual(genericFollowupCandidates(input).map((r) => r.sku), ["A"]);
  assert.deepEqual(genericFollowupCandidates({...input, globalShipDate: "2026-10-15"}), []);
  assert.deepEqual(genericFollowupCandidates({...input, emailType: "awaiting_stock"}), []);
  assert.deepEqual(genericFollowupCandidates({...input, order: {...order, cancelledAt: now}}), []);
});
test("resolution checks exact item/variant, fulfillment and the original field type", () => {
  const record = {lineItemId: "A", variantId: "v-A", sku: "A", kind: "backorder"};
  const loaded = {order, today: "2026-09-24", timeZone: "America/Los_Angeles"};
  assert.equal(resolveFollowupItem(record, loaded).status, "ready");
  assert.equal(resolveFollowupItem({...record, variantId: "other"}, loaded).status, "skipped");
  assert.equal(resolveFollowupItem(record, {...loaded, order: {...order, cancelledAt: now}}).status, "skipped");
  const pending = structuredClone(order); pending.lineItems[0].variant.availabilityDate = null;
  assert.equal(resolveFollowupItem(record, {...loaded, order: pending}).status, "pending");
  pending.lineItems[0].unfulfilledQuantity = 0;
  assert.equal(resolveFollowupItem(record, {...loaded, order: pending}).status, "skipped");
});

test("worker only sends tracked items to the initial recipient and deduplicates uncertain retries", async () => {
  const shop = "pilot.myshopify.com";
  const savedEnv = {...process.env};
  process.env.NOTIFY_DOCK_FOLLOWUP_ENABLED = "true";
  process.env.NOTIFY_DOCK_FOLLOWUP_SHOPS = shop;
  const history = {id: "history-1", shop, orderId: order.id, orderNumber: order.name,
    source: "app", requestEventUniqueId: "initial-accepted", emailType: "dynamic_shipping_delay", customerEmail: "work@example.com"};
  const rows = [];
  const batches = [];
  const sends = [];
  const histories = [];
  const lease = {};
  let failComplete = false;
  const matches = (row, where) => Object.entries(where).every(([key, value]) =>
    value && typeof value === "object" && !(value instanceof Date)
      ? value.in ? value.in.includes(row[key]) : value.lte ? row[key] <= value.lte : true
      : row[key] === value);
  const db = {
    notifyDockFollowupLease: {
      upsert: async () => lease,
      updateMany: async ({where, data}) => {
        if ((where.token && lease.token !== where.token) || (where.OR && lease.leaseUntil > now)) return {count: 0};
        Object.assign(lease, data); return {count: 1};
      },
      update: async ({data}) => Object.assign(lease, data),
    },
    notifyDockFollowupItem: {
      createMany: async ({data}) => { for (const row of data) if (!rows.some((r) => r.id === row.id)) rows.push({...row, status: "pending", initialHistory: history}); },
      findMany: async ({where}) => rows.filter((r) => matches(r, where)).map((r) => structuredClone(r)),
      update: async ({where, data}) => Object.assign(rows.find((r) => matches(r, where)), data),
      updateMany: async ({where, data}) => { rows.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, data)); },
    },
    notifyDockFollowupBatch: {
      findMany: async ({where}) => batches.filter((r) => matches(r, where)).map((r) => structuredClone(r)),
      create: async ({data}) => { const row = {...data, status: "pending"}; batches.push(row); return row; },
      update: async ({where, data}) => Object.assign(batches.find((r) => matches(r, where)), data),
    },
    notifyDockEmailHistory: {upsert: async ({create}) => { histories.push(create); return create; }},
    $transaction: async (arg) => {
      if (typeof arg === "function") return arg(db);
      if (failComplete) { batches[0].status = "pending"; rows.forEach((r) => {r.status = "batched";}); throw new Error("Database failure after provider acceptance"); }
      return Promise.all(arg);
    },
  };
  globalThis.followupTest = {db, load: async () => ({order, today: "2026-09-24", timeZone: "America/Los_Angeles"}),
    send: async (payload) => {assert.ok(batches.some((b) => b.id === payload.requestEventUniqueId)); sends.push(structuredClone(payload)); return {metricName: "test"};}};
  try {
    const bundle = await build({entryPoints: ["app/backorder-followup.server.js"], bundle: true, platform: "node", format: "esm", write: false,
      plugins: [{name: "mock-services", setup(b) {
        b.onResolve({filter: /\/(db|shopify|klaviyo)\.server$|\/backorder-automation-shopify\.js$/}, (a) => ({path: a.path, namespace: "mock"}));
        b.onLoad({filter: /.*/, namespace: "mock"}, (a) => ({contents:
          a.path.includes("db.server") ? "export default globalThis.followupTest.db;"
            : a.path.includes("shopify.server") ? "export const unauthenticated={admin:async()=>({admin:{}})};"
              : a.path.includes("klaviyo") ? "export const METRIC_NAMES={dynamic_shipping_delay:'test'}; export const sendNotifyDockEvent=globalThis.followupTest.send;"
                : "export const loadBackorderOrder=globalThis.followupTest.load;"}));
      }}]});
    const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
    await api.runBackorderFollowups(now);
    assert.equal(sends.length, 0, "No enrollment means no automatic email, even with eligible orders");
    await api.saveFollowupTracking(history, [{lineItemId: "A", variantId: "v-A", sku: "A", kind: "backorder"},
      {lineItemId: "B", variantId: "v-B", sku: "B", kind: "built_to_order"}], new Date("2026-09-23T20:00:00Z"));
    assert.equal(rows.length, 2);
    failComplete = true;
    await api.runBackorderFollowups(now);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].customerEmail, "work@example.com");
    assert.deepEqual(sends[0].products.map((p) => p.sku), ["A", "B"]);
    assert.doesNotMatch(sends[0].message, /UNTRACKED/);
    failComplete = false;
    await api.runBackorderFollowups(new Date(now.getTime() + 16 * 60 * 1000));
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[0], sends[1], "Uncertain retry must use the same event ID and frozen payload");
    await api.runBackorderFollowups(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    assert.equal(sends.length, 2, "Accepted items never send again");
    assert.ok(rows.every((r) => r.status === "accepted"));
  } finally {
    delete globalThis.followupTest;
    for (const key of ["NOTIFY_DOCK_FOLLOWUP_ENABLED", "NOTIFY_DOCK_FOLLOWUP_SHOPS"]) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  }
});
