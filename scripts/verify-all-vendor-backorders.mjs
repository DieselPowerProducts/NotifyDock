/* global globalThis */
import assert from "node:assert/strict";
import {test, after} from "node:test";
import {build} from "esbuild";
import {selectBackorderNotice, initialPayloadMatchesSelection, formatStoreDate} from "../app/backorder-automation.js";
import {genericFollowupCandidates, resolveFollowupItem, followupMatchesPayload} from "../app/backorder-followup.js";

const shop = "pilot.myshopify.com";
const originalCutoff = "2026-09-24T21:40:39Z";
const rollout = "2026-09-30T23:20:00Z";
const day = (n) => new Date(`2026-10-${String(n).padStart(2, "0")}T23:00:00Z`);
const line = (id, vendor, availability = "Backorder") => ({id, sku: id, title: id,
  currentQuantity: 1, unfulfilledQuantity: 1, variant: {id: `v-${id}`, product: {vendor},
    availability: {value: availability}, availabilityDate: null, buildToOrderMessage: null}});
const freshOrder = () => ({id: "gid://shopify/Order/123", name: "#123", createdAt: rollout,
  tags: ["Backorder"], email: "original@example.com", lineItems: [
    line("A", "Industrial Injection"), line("B", "BD Diesel", "Built to Order"),
    line("C", "Red-Head Steering Gears Inc."), line("D", "", "In Stock"),
  ]});

test("mixed vendors use the same initial rules and only generic emailed items enroll", () => {
  const order = freshOrder();
  order.lineItems[2].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  const input = {order, config: {startAt: new Date(rollout)}, today: "2026-09-30", timeZone: "America/Los_Angeles"};
  const selected = selectBackorderNotice(input);
  assert.equal(selected.status, "ready");
  assert.deepEqual(selected.payload.products.map((p) => p.sku), ["A", "B", "C"]);
  assert.deepEqual(genericFollowupCandidates({order, ...selected.payload}).map((p) => p.sku), ["A", "B"]);
  // Vendor labels, including empty ones, do not participate in eligibility.
  order.lineItems[0].variant.product = null;
  assert.equal(selectBackorderNotice(input).status, "ready");
  order.tags = [];
  assert.equal(selectBackorderNotice(input).status, "skipped");
});

test("non-Red-Head follow-ups keep date validation and stop on status, identity or fulfillment changes", () => {
  const order = freshOrder(), record = {lineItemId: "A", variantId: "v-A", sku: "A", kind: "backorder"};
  const loaded = {order, today: "2026-10-01", timeZone: "America/Los_Angeles"};
  for (const value of ["", "bad", "2026-02-30", "2026-09-30", "2026-10-01"]) {
    order.lineItems[0].variant.availabilityDate = {type: "date", value};
    assert.equal(resolveFollowupItem(record, loaded).status, "pending");
  }
  order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  assert.equal(resolveFollowupItem(record, loaded).status, "ready");
  for (const availability of ["In Stock", "Discontinued", "Built to Order", ""]) {
    order.lineItems[0].variant.availability.value = availability;
    assert.equal(resolveFollowupItem(record, loaded).status, "skipped");
  }
  order.lineItems[0].variant.availability.value = "Backorder";
  order.lineItems[0].unfulfilledQuantity = 0;
  assert.equal(resolveFollowupItem(record, loaded).status, "skipped");
});

const state = {};
globalThis.allVendorTest = state;
const matches = (r, where) => Object.entries(where).every(([k, v]) => {
  if (k === "OR") return v.some((condition) => matches(r, condition));
  if (v === null) return r[k] == null;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if (v.in) return v.in.includes(r[k]);
    if (Object.hasOwn(v, "not")) return r[k] !== v.not;
    if (v.lte) return r[k] <= v.lte;
    if (v.lt) return r[k] < v.lt;
  }
  return r[k] === v;
});
const model = (key) => ({
  findUnique: async ({where}) => structuredClone(state[key].find((r) => matches(r, where)) || null),
  findFirst: async ({where}) => structuredClone(state[key].find((r) => matches(r, where)) || null),
  findMany: async ({where, take, orderBy}) => {
    const rows = state[key].filter((r) => matches(r, where));
    const ordering = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
    rows.sort((a, b) => {
      for (const part of ordering) for (const [field, direction] of Object.entries(part)) {
        if (a[field] < b[field]) return direction === "asc" ? -1 : 1;
        if (a[field] > b[field]) return direction === "asc" ? 1 : -1;
      }
      return 0;
    });
    return structuredClone(rows.slice(0, take));
  },
  count: async ({where}) => state[key].filter((r) => matches(r, where)).length,
  create: async ({data}) => {
    assert.ok(!state[key].some((r) => r.id === data.id), "Unique identity must be preserved");
    const r = {...structuredClone(data), status: "pending", attemptedAt: null, createdAt: state.now}; state[key].push(r); return structuredClone(r);
  },
  createMany: async ({data}) => {for (const r of data) if (!state[key].some((x) => x.id === r.id)) {
    state[key].push({...structuredClone(r), status: key === "jobs" ? "queued" : "pending", createdAt: state.now,
      initialHistory: structuredClone(state.histories.find((history) => history.id === r.initialHistoryId) || state.history)});
  }},
  update: async ({where, data}) => {
    if (key === "batches" && data.attemptedAt && state.failAttemptWrite) throw new Error("Attempt write failed");
    return Object.assign(state[key].find((r) => matches(r, where)), structuredClone(data));
  },
  updateMany: async ({where, data}) => {
    const rows = state[key].filter((r) => matches(r, where)); rows.forEach((r) => Object.assign(r, structuredClone(data))); return {count: rows.length};
  },
  upsert: async ({create}) => {
    const old = state[key].find((r) => r.sourceEventId === create.sourceEventId);
    if (old) return old;
    const row = {id: `history-${state[key].length}`, ...structuredClone(create)};
    state[key].push(row); return row;
  },
});
state.db = {
  notifyDockAutomationPolicy: {findUnique: async () => ({startAt: new Date(originalCutoff), initialStartAt: new Date(rollout)})},
  notifyDockBackorderJob: model("jobs"),
  notifyDockFollowupItem: model("rows"), notifyDockFollowupBatch: model("batches"), notifyDockEmailHistory: model("histories"),
  notifyDockFollowupLease: {
    upsert: async () => {},
    updateMany: async ({where, data}) => {
      if (where.OR && state.leased) return {count: 0};
      if (where.token && where.token !== state.leaseToken) return {count: 0};
      state.leased = !!data.token; state.leaseToken = data.token; return {count: 1};
    },
    update: async () => {},
  },
  $transaction: async (arg) => typeof arg === "function" ? arg(state.db) : Promise.all(arg),
};
state.load = async (_admin, orderId) => {
  state.loads++;
  state.beforeLoad?.(state.loads);
  const order = structuredClone(state.extraOrders.get(orderId) || state.order);
  state.afterLoad?.(state.loads);
  return {order, today: state.now.toISOString().slice(0, 10), timeZone: "America/Los_Angeles"};
};
state.send = async (payload) => {
  if (payload.followupCandidates) {
    assert.ok(state.jobs.find((job) => job.id === payload.requestEventUniqueId)?.attemptedAt,
      "The initial attempt must be persisted before contacting the provider");
  } else {
    assert.ok(state.batches.find((batch) => batch.id === payload.requestEventUniqueId)?.attemptedAt,
      "The durable attempt marker must exist before contacting the provider");
  }
  state.sends.push(structuredClone(payload));
  if (state.failSend) throw new Error("Uncertain provider response");
  return {metricName: "test"};
};
const bundle = await build({stdin: {contents: 'export * from "./app/backorder-followup.server.js"; export * from "./app/backorder-automation.server.js";',
  resolveDir: process.cwd()}, bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{name: "offline-all-vendor", setup(b) {
    b.onResolve({filter: /\/(db|shopify|klaviyo)\.server$|\/backorder-automation-shopify\.js$/}, (a) => ({path: a.path, namespace: "mock"}));
    b.onLoad({filter: /.*/, namespace: "mock"}, (a) => ({contents:
      a.path.includes("db.server") ? "export default globalThis.allVendorTest.db;"
        : a.path.includes("shopify.server") ? "export const unauthenticated={admin:async()=>({admin:{}})};"
          : a.path.includes("klaviyo") ? "export const METRIC_NAMES={dynamic_shipping_delay:'test'};export const sendNotifyDockEvent=globalThis.allVendorTest.send;"
            : "export const loadBackorderOrder=globalThis.allVendorTest.load;"}));
  }}]});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
after(() => {delete globalThis.allVendorTest;});
async function fixture(run) {
  const values = {NOTIFY_DOCK_AUTOMATION_MODE: "live", NOTIFY_DOCK_AUTOMATION_SHOPS: shop,
    NOTIFY_DOCK_AUTOMATION_START_AT: originalCutoff, NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT: rollout,
    NOTIFY_DOCK_FOLLOWUP_ENABLED: "true", NOTIFY_DOCK_FOLLOWUP_SHOPS: shop, NOTIFY_DOCK_FOLLOWUP_TEST_AT: ""};
  const saved = {...process.env}; Object.assign(process.env, values);
  Object.assign(state, {order: freshOrder(), now: day(1), rows: [], jobs: [], batches: [], histories: [], sends: [],
    loads: 0, leased: false, leaseToken: null, failSend: false, beforeLoad: null, afterLoad: null, extraOrders: new Map(), failAttemptWrite: false});
  state.history = {id: "initial", shop, orderId: state.order.id, orderNumber: state.order.name,
    source: "backorder_automation", requestEventUniqueId: "initial-accepted", emailType: "dynamic_shipping_delay", customerEmail: "original@example.com"};
  const enroll = async () => {
    const selected = selectBackorderNotice({order: state.order, config: {startAt: new Date(originalCutoff)},
      today: "2026-09-30", timeZone: "America/Los_Angeles"});
    assert.equal(selected.status, "ready");
    await api.saveFollowupTracking(state.history, {order: state.order, candidates: genericFollowupCandidates({order: state.order, ...selected.payload})}, new Date(rollout));
  };
  const runDay = async (n) => {state.now = day(n); return api.runBackorderFollowups(state.now);};
  try {await run({enroll, runDay});}
  finally {for (const k of Object.keys(values)) {if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];}}
}

test("staggered vendor estimates send once per item, grouped by day, until tracking is finished", async () => fixture(async ({enroll, runDay}) => {
  await enroll(); assert.equal(state.rows.length, 3);
  await runDay(1); assert.equal(state.sends.length, 0);
  const loadsAfterFirst = state.loads;
  await runDay(1); assert.equal(state.loads, loadsAfterFirst, "No repeat checks on the same day");
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  await runDay(2); assert.equal(state.sends.length, 1);
  assert.deepEqual(state.sends[0].products.map((p) => p.sku), ["A"]);
  assert.equal(state.rows.find((r) => r.sku === "A").status, "accepted");
  assert.ok(state.rows.filter((r) => r.sku !== "A").every((r) => r.status === "pending"));
  // Tomorrow only B's new message is emailed; A changing its date does not restart A.
  state.order.lineItems[0].variant.availabilityDate.value = "2026-10-30";
  state.order.lineItems[1].variant.buildToOrderMessage = {type: "single_line_text_field", value: "Ships in 2 weeks"};
  await runDay(3); assert.equal(state.sends.length, 2);
  assert.deepEqual(state.sends[1].products.map((p) => p.sku), ["B"]);
  state.order.lineItems[2].variant.availabilityDate = {type: "date", value: "2026-10-20"};
  await runDay(4); assert.equal(state.sends.length, 3);
  assert.deepEqual(state.sends[2].products.map((p) => p.sku), ["C"]);
  assert.ok(state.rows.every((r) => r.status === "accepted"));
  const completedLoads = state.loads;
  await runDay(5); assert.equal(state.sends.length, 3); assert.equal(state.loads, completedLoads);
  assert.equal(new Set(state.sends.map((p) => p.requestEventUniqueId)).size, 3);
}));

test("in-stock items terminate without sending and never restart if backordered again", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]]; await enroll();
  state.order.lineItems[0].variant.availability.value = "In Stock";
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  await runDay(1); assert.equal(state.sends.length, 0); assert.equal(state.rows[0].status, "skipped");
  const loads = state.loads;
  state.order.lineItems[0].variant.availability.value = "Backorder";
  await runDay(2); assert.equal(state.loads, loads); assert.equal(state.sends.length, 0);
}));

test("existing Red Head tracking survives the new cutoff, and other vendors use their original field types", async () => fixture(async ({enroll, runDay}) => {
  await enroll();
  state.order.createdAt = "2026-09-25T12:00:00Z";
  // Model already-existing tracking, not newly enrolling an old order.
  state.rows.forEach((record) => {record.createdAt = new Date("2026-09-25T13:00:00Z");});
  state.order.lineItems[1].variant.buildToOrderMessage = {type: "single_line_text_field", value: "Ships in 2 weeks"};
  state.order.lineItems[2].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  await runDay(1); assert.equal(state.sends.length, 1);
  assert.deepEqual(state.sends[0].products.map((p) => p.sku), ["B", "C"]);
}));

test("existing order #969960 keeps its pending RH-2879U follow-up across the 4:20pm rollout", async () => fixture(async ({runDay}) => {
  const item = line("gid://shopify/LineItem/50738626494829", "Red-Head Steering Gears Inc.");
  item.sku = "RH-2879U";
  item.variant.id = "gid://shopify/ProductVariant/52077141590381";
  Object.assign(state.order, {id: "gid://shopify/Order/18912023183725", name: "#969960",
    createdAt: "2026-09-28T03:26:33Z", lineItems: [item]});
  Object.assign(state.history, {orderId: state.order.id, orderNumber: state.order.name,
    sentAt: new Date("2026-09-28T03:26:43.920Z")});
  // Seed the already-enrolled record: the rollout must neither re-enroll it nor
  // send another initial email to this pre-rollout order.
  state.rows.push({id: "existing-red-head-followup", shop, orderId: state.order.id,
    lineItemId: item.id, variantId: item.variant.id, sku: item.sku, kind: "backorder",
    status: "pending", batchId: null, nextCheckAt: new Date("2026-09-30T23:00:00Z"),
    initialHistoryId: state.history.id, initialHistory: structuredClone(state.history),
    createdAt: new Date("2026-09-28T03:26:45.681Z")});
  assert.equal(selectBackorderNotice({order: state.order, config: {startAt: new Date(rollout)},
    today: "2026-10-01", timeZone: "America/Los_Angeles"}).status, "skipped");
  await runDay(1); await runDay(2);
  assert.equal(state.rows.length, 1); assert.equal(state.rows[0].status, "pending");
  assert.equal(state.sends.length, 0, "Missing ETA keeps waiting without another generic email");
  state.order.tags = [];
  item.variant.availabilityDate = {type: "date", value: "2026-10-20"};
  await runDay(3);
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].orderNumber, "#969960");
  assert.deepEqual(state.sends[0].products.map((product) => [product.sku, product.delayDate]), [["RH-2879U", "2026-10-20"]]);
  assert.equal(state.rows[0].status, "accepted");
  const completedLoads = state.loads;
  item.variant.availabilityDate.value = "2026-10-25";
  await runDay(4);
  assert.equal(state.loads, completedLoads); assert.equal(state.sends.length, 1);
}));

test("uncertain follow-up retries preserve one event and the original recipient", async () => fixture(async ({enroll, runDay}) => {
  await enroll(); state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  state.failSend = true; await runDay(1); assert.equal(state.sends.length, 1);
  state.failSend = false; state.order.email = "changed@example.com";
  await runDay(2); assert.equal(state.sends.length, 2); assert.deepEqual(state.sends[0], state.sends[1]);
  assert.equal(state.batches.length, 1);
  await runDay(3); assert.equal(state.sends.length, 2);
}));

test("the single daily snapshot stops tracking an In Stock item", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]]; await enroll();
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-15"};
  state.beforeLoad = (count) => {if (count === 1) state.order.lineItems[0].variant.availability.value = "In Stock";};
  await runDay(1); assert.equal(state.sends.length, 0);
  await runDay(2); assert.equal(state.sends.length, 0); assert.equal(state.batches.length, 0);
  assert.equal(state.loads, 1);
  assert.ok(state.rows.every((r) => r.status === "skipped"));
}));

test("five products receive five staggered updates on five different days", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = Array.from({length: 5}, (_, n) => line(`SKU-${n}`, `Vendor ${n}`));
  await enroll();
  for (let n = 0; n < 5; n++) {
    state.order.lineItems[n].variant.availabilityDate = {type: "date", value: "2026-10-20"};
    await runDay(n + 1);
    assert.equal(state.sends.length, n + 1);
    assert.deepEqual(state.sends[n].products.map((p) => p.sku), [`SKU-${n}`]);
  }
  const loads = state.loads;
  await runDay(6); assert.equal(state.loads, loads); assert.equal(state.sends.length, 5);
}));

test("removing the order tag keeps daily tracking and sends only the one-time newly dated item", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]];
  await enroll(); state.order.tags = [];
  await runDay(1); await runDay(2);
  assert.equal(state.sends.length, 0); assert.equal(state.rows[0].status, "pending");
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-20"};
  await runDay(3);
  assert.equal(state.sends.length, 1); assert.deepEqual(state.sends[0].products.map((p) => p.sku), ["A"]);
  const loads = state.loads;
  await runDay(4); assert.equal(state.loads, loads); assert.equal(state.sends.length, 1);
}));

test("all estimates known initially creates no tracking or later product checks", async () => fixture(async ({enroll, runDay}) => {
  for (const item of state.order.lineItems) {
    item.variant.availabilityDate = {type: "date", value: "2026-10-20"};
    item.variant.buildToOrderMessage = {type: "single_line_text_field", value: "Ships October 20"};
  }
  await enroll(); assert.equal(state.rows.length, 0);
  await runDay(1); assert.equal(state.loads, 0); assert.equal(state.sends.length, 0);
}));

test("fully fulfilled and cancelled orders terminate all tracking even without the tag", async () => {
  for (const stop of [
    (order) => {order.lineItems.forEach((item) => {item.unfulfilledQuantity = 0;});},
    (order) => {order.cancelledAt = day(1).toISOString();},
  ]) await fixture(async ({enroll, runDay}) => {
    await enroll(); state.order.tags = []; stop(state.order);
    await runDay(1);
    assert.equal(state.sends.length, 0); assert.ok(state.rows.every((row) => row.status === "skipped"));
    const loads = state.loads; await runDay(2); assert.equal(state.loads, loads);
  });
});

test("partial fulfillment stops only fulfilled items and same-day estimates share one email", async () => fixture(async ({enroll, runDay}) => {
  await enroll(); state.order.tags = [];
  state.order.lineItems[0].unfulfilledQuantity = 0;
  state.order.lineItems[1].variant.buildToOrderMessage = {type: "single_line_text_field", value: "Ships October 20"};
  state.order.lineItems[2].variant.availabilityDate = {type: "date", value: "2026-10-20"};
  await runDay(1);
  assert.equal(state.sends.length, 1); assert.deepEqual(state.sends[0].products.map((p) => p.sku), ["B", "C"]);
  assert.equal(state.rows.find((row) => row.sku === "A").status, "skipped");
  const loads = state.loads; await runDay(2); assert.equal(state.loads, loads);
}));

test("an unsent batch retry stops an In Stock or fulfilled companion without losing another update", async () => {
  for (const stop of [
    (item) => {item.variant.availability.value = "In Stock";},
    (item) => {item.unfulfilledQuantity = 0;},
  ]) await fixture(async ({enroll, runDay}) => {
    state.order.lineItems = [state.order.lineItems[0], state.order.lineItems[2]];
    await enroll();
    state.order.lineItems.forEach((item) => {item.variant.availabilityDate = {type: "date", value: "2026-10-20"};});
    state.failAttemptWrite = true; await runDay(1);
    state.failAttemptWrite = false; stop(state.order.lineItems[0]);
    assert.equal((await runDay(2)).hasMore, true);
    assert.equal(state.sends.length, 0); assert.equal(state.batches[0].attemptedAt, null);
    assert.equal(state.rows.find((row) => row.sku === "A").status, "skipped");
    assert.equal(state.rows.find((row) => row.sku === "C").status, "pending");
    assert.equal((await runDay(2)).hasMore, false);
    assert.equal(state.sends.length, 1); assert.deepEqual(state.sends[0].products.map((p) => p.sku), ["C"]);
    const loads = state.loads; await runDay(3); assert.equal(state.loads, loads);
  });
});

test("an estimate changing before any provider attempt can be regrouped with its new value", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]]; await enroll();
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-20"};
  state.failAttemptWrite = true; await runDay(1);
  state.failAttemptWrite = false; state.order.lineItems[0].variant.availabilityDate.value = "2026-10-25";
  assert.equal((await runDay(2)).hasMore, true); assert.equal(state.sends.length, 0);
  await runDay(2);
  assert.equal(state.sends.length, 1); assert.equal(state.sends[0].products[0].delayDate, "2026-10-25");
  assert.equal(state.batches[0].status, "superseded"); assert.equal(state.batches[1].status, "accepted");
  assert.notEqual(state.batches[0].id, state.batches[1].id);
}));

test("uncertain sends are never regrouped into a new event after items change", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0], state.order.lineItems[2]]; await enroll();
  state.order.lineItems.forEach((item) => {item.variant.availabilityDate = {type: "date", value: "2026-10-20"};});
  state.failSend = true; await runDay(1);
  assert.equal(state.sends.length, 1); assert.ok(state.batches[0].attemptedAt);
  state.failSend = false; state.order.lineItems[0].variant.availability.value = "In Stock";
  await runDay(2); await runDay(3);
  assert.equal(state.sends.length, 1); assert.equal(state.batches.length, 1); assert.equal(state.batches[0].status, "held");
  assert.equal(state.rows.find((row) => row.sku === "A").status, "skipped");
  assert.equal(state.rows.find((row) => row.sku === "C").status, "held");
}));

test("failure to persist provider attempt prevents email and leaves safe regrouping possible", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0], state.order.lineItems[2]]; await enroll();
  state.order.lineItems.forEach((item) => {item.variant.availabilityDate = {type: "date", value: "2026-10-20"};});
  state.failAttemptWrite = true; await runDay(1);
  assert.equal(state.sends.length, 0); assert.equal(state.batches[0].attemptedAt, null);
  state.failAttemptWrite = false; state.order.lineItems[0].unfulfilledQuantity = 0;
  await runDay(2); await runDay(2);
  assert.equal(state.sends.length, 1); assert.deepEqual(state.sends[0].products.map((p) => p.sku), ["C"]);
}));

test("automatic enrollment uses exact identities for duplicate SKUs and normalized variant SKU fallback", () => {
  const order = freshOrder(); order.lineItems = [line("X", "Vendor X"), line("Y", "Vendor Y")];
  order.lineItems.forEach((item) => {item.sku = "SAME";});
  order.lineItems[1].variant.availabilityDate = {type: "date", value: "2026-10-20"};
  const select = () => selectBackorderNotice({order, config: {startAt: new Date(rollout)}, today: "2026-09-30", timeZone: "America/Los_Angeles"});
  let selected = select();
  assert.deepEqual(genericFollowupCandidates({order, ...selected.payload}).map((row) => row.lineItemId), ["X"]);
  order.lineItems[1].variant.availabilityDate = null;
  selected = select(); assert.equal(selected.payload.products.length, 2, "Different variants must not collapse because their SKUs match");
  assert.deepEqual(genericFollowupCandidates({order, ...selected.payload}).map((row) => row.lineItemId), ["X", "Y"]);
  assert.deepEqual(genericFollowupCandidates({order, emailType: "dynamic_shipping_delay", products: [{sku: "SAME", delayState: "no_confirmed_date"}]}), [], "Ambiguous legacy/manual SKUs must not guess");
  order.lineItems = [order.lineItems[0]]; order.lineItems[0].sku = ""; order.lineItems[0].variant.sku = "  FALLBACK  ";
  selected = select();
  assert.equal(selected.payload.products[0].sku, "FALLBACK");
  assert.equal(genericFollowupCandidates({order, ...selected.payload})[0].sku, "FALLBACK");
});

test("final follow-up matching binds dates to identities and consumes legacy matches one-to-one", () => {
  const order = freshOrder(); order.lineItems = [line("X", "Vendor X"), line("Y", "Vendor Y")];
  const records = order.lineItems.map((item) => ({lineItemId: item.id, variantId: item.variant.id, sku: "SAME", kind: "backorder"}));
  order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-20"};
  order.lineItems[1].variant.availabilityDate = {type: "date", value: "2026-10-25"};
  const loaded = {order, today: "2026-10-01", timeZone: "America/Los_Angeles"};
  const products = records.map((row) => resolveFollowupItem(row, loaded).product);
  assert.equal(followupMatchesPayload(records, loaded, {products}), true);
  order.lineItems[0].variant.availabilityDate.value = "2026-10-25";
  order.lineItems[1].variant.availabilityDate.value = "2026-10-20";
  assert.equal(followupMatchesPayload(records, loaded, {products}), false, "Swapping dates between same-SKU variants must fail");
  order.lineItems[0].variant.availabilityDate.value = "2026-10-20";
  const legacy = products.map(({lineItemId: _line, variantId: _variant, ...product}) => product);
  assert.equal(followupMatchesPayload(records, loaded, {products: legacy}), false, "Two identical current dates cannot both match the same legacy entry");
});

test("a five-product order crossing the 100-item page boundary gets one same-day email", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = Array.from({length: 5}, (_, index) => line(`TARGET-${index}`, `Vendor ${index}`));
  await enroll();
  state.order.lineItems.forEach((item) => {item.variant.availabilityDate = {type: "date", value: "2026-10-20"};});
  const otherId = "gid://shopify/Order/999";
  state.extraOrders.set(otherId, {...freshOrder(), id: otherId, cancelledAt: day(1).toISOString()});
  state.rows.unshift(...Array.from({length: 99}, (_, index) => ({id: `earlier-${index}`, shop, orderId: otherId,
    lineItemId: `old-${index}`, variantId: `old-v-${index}`, sku: `OLD-${index}`, kind: "backorder", status: "pending",
    nextCheckAt: new Date("2026-09-30T20:00:00Z"), initialHistoryId: "earlier-history",
    initialHistory: {...state.history, id: "earlier-history", orderId: otherId}})));
  let result;
  for (let page = 0; page < 10; page++) {result = await runDay(1); if (!result.hasMore) break;}
  assert.equal(result.hasMore, false); assert.equal(state.sends.length, 1);
  assert.deepEqual(state.sends[0].products.map((product) => product.sku), ["TARGET-0", "TARGET-1", "TARGET-2", "TARGET-3", "TARGET-4"]);
  assert.ok(state.rows.filter((row) => row.orderId === state.order.id).every((row) => row.status === "accepted"));
}));

test("tag removal before the daily snapshot still allows the eligible dated product", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]]; await enroll();
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-20"};
  state.beforeLoad = (count) => {if (count === 1) state.order.tags = [];};
  await runDay(1); assert.equal(state.sends.length, 1); assert.equal(state.rows[0].status, "accepted");
}));

test("initial validation rejects a generic item's changed availability type or line identity", () => {
  const order = freshOrder(); order.lineItems = [order.lineItems[0]];
  const select = () => selectBackorderNotice({order, config: {startAt: new Date(rollout)}, today: "2026-09-30", timeZone: "America/Los_Angeles"});
  const payload = structuredClone(select().payload);
  assert.equal(initialPayloadMatchesSelection(payload, select()), true);
  order.lineItems[0].variant.availability.value = "Built to Order";
  assert.equal(initialPayloadMatchesSelection(payload, select()), false, "The generic text cannot hide a change in the metafield being watched");
  order.lineItems[0].variant.availability.value = "Backorder";
  order.lineItems[0].id = "replacement-line-same-variant";
  assert.equal(initialPayloadMatchesSelection(payload, select()), false);
});


test("a follow-up uses its one snapshot even when the date changes after the read", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]]; await enroll();
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-20"};
  state.afterLoad = () => {state.order.lineItems[0].variant.availabilityDate.value = "2026-10-25";};
  await runDay(1);
  assert.equal(state.loads, 1); assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].products[0].delayDate, "2026-10-20");
  assert.equal(state.rows[0].status, "accepted");
  await runDay(2); assert.equal(state.loads, 1); assert.equal(state.sends.length, 1);
}));

test("a date added after an undated daily snapshot is picked up the next day", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]]; await enroll();
  state.afterLoad = () => {state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-20"};};
  await runDay(1); assert.equal(state.loads, 1); assert.equal(state.sends.length, 0);
  await runDay(1); assert.equal(state.loads, 1);
  await runDay(2); assert.equal(state.loads, 2); assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].products[0].delayDate, "2026-10-20");
}));


test("accepted initial webhook persists generic tracking and completes one dated follow-up", async () => fixture(async ({runDay}) => {
  // Use the actual webhook service, its completion transaction, and daily worker.
  state.order.lineItems = [state.order.lineItems[0], state.order.lineItems[1], state.order.lineItems[3]];
  state.order.lineItems[1].variant.buildToOrderMessage = {type: "single_line_text_field", value: "Ships in two weeks"};
  const event = {shop, payload: {admin_graphql_api_id: state.order.id, name: state.order.name,
    created_at: state.order.createdAt, tags: "Backorder"}};
  state.failSend = true;
  assert.equal(await api.processBackorderWebhook(event), "retry");
  assert.equal(state.histories.length, 0); assert.equal(state.rows.length, 0,
    "A failed initial request must not enroll follow-up items");
  state.failSend = false;
  assert.equal(await api.processBackorderWebhook(event), "accepted");
  assert.deepEqual(state.sends[0], state.sends[1], "Initial retries reuse the saved event and payload");
  assert.deepEqual(state.sends[1].products.map((product) => product.sku), ["A", "B"]);
  assert.equal(state.jobs[0].status, "accepted"); assert.equal(state.histories.length, 1);
  assert.equal(state.rows.length, 1); assert.equal(state.rows[0].sku, "A");
  assert.equal(state.rows[0].initialHistoryId, state.histories[0].id);
  assert.equal(state.rows[0].initialHistory.requestEventUniqueId, state.jobs[0].id);
  assert.equal(await api.processBackorderWebhook(event), "complete");
  assert.equal(state.sends.length, 2);

  // Use the actual scheduled date saved by the completion transaction.
  state.now = new Date(state.rows[0].nextCheckAt);
  state.order.tags = [];
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2099-10-20"};
  await api.runBackorderFollowups(state.now);
  assert.equal(state.sends.length, 3);
  assert.deepEqual(state.sends[2].products.map((product) => product.sku), ["A"]);
  assert.equal(state.sends[2].products[0].delayDate, "2099-10-20");
  assert.equal(state.rows[0].status, "accepted"); assert.equal(state.histories.length, 2);
  const loads = state.loads;
  await runDay(30);
  assert.equal(state.sends.length, 3); assert.equal(state.loads, loads);
}));


test("today and expired initial ETAs enroll and wait until a future ETA before one follow-up", async () => {
  for (const value of ["2026-10-01", "2026-09-30", "2026-08-01"]) await fixture(async ({runDay}) => {
    state.order.lineItems = [state.order.lineItems[0]];
    state.order.lineItems[0].variant.availabilityDate = {type: "date", value};
    const event = {shop, payload: {admin_graphql_api_id: state.order.id, name: state.order.name,
      created_at: state.order.createdAt, tags: "Backorder"}};
    // The order was created September 30, but the initial email is checked October 1.
    assert.equal(await api.processBackorderWebhook(event), "accepted");
    assert.equal(state.sends.length, 1);
    assert.equal(state.sends[0].products[0].delayState, "no_confirmed_date");
    assert.equal(state.sends[0].products[0].delayDate, "");
    assert.match(state.sends[0].message, /there is not yet a confirmed ship date/);
    assert.equal(state.rows.length, 1); assert.equal(state.rows[0].status, "pending");
    state.rows[0].nextCheckAt = day(1);
    await runDay(1); await runDay(2);
    assert.equal(state.sends.length, 1, "Expired dates must never trigger a follow-up");
    assert.equal(state.rows[0].status, "pending");
    state.order.lineItems[0].variant.availabilityDate.value = "2026-10-03";
    await runDay(3);
    assert.equal(state.sends.length, 1, "Today's ETA still waits");
    state.order.lineItems[0].variant.availabilityDate.value = "2026-10-20";
    await runDay(4);
    assert.equal(state.sends.length, 2);
    assert.equal(state.sends[1].products[0].delayDate, "2026-10-20");
    assert.equal(state.rows[0].status, "accepted");
    const loads = state.loads; await runDay(5);
    assert.equal(state.loads, loads); assert.equal(state.sends.length, 2);
  });
});

test("ETA freshness uses the sending day's Pacific calendar boundary and normalizes date_time", () => {
  const order = freshOrder(); order.lineItems = [order.lineItems[0]];
  const record = {lineItemId: "A", variantId: "v-A", sku: "A", kind: "backorder"};
  for (const availabilityDate of [
    {type: "date", value: "2026-10-02"},
    {type: "date_time", value: "2026-10-03T06:59:00Z"}, // October 2 in Pacific
  ]) {
    order.lineItems[0].variant.availabilityDate = availabilityDate;
    for (const [at, expected] of [["2026-10-02T06:59:59Z", "specific_date"], ["2026-10-02T07:00:00Z", "no_confirmed_date"]]) {
      const timeZone = "America/Los_Angeles";
      const loaded = {order, timeZone, today: formatStoreDate(new Date(at), timeZone)};
      const selected = selectBackorderNotice({...loaded, config: {startAt: new Date(rollout)}});
      assert.equal(selected.status, "ready");
      assert.equal(selected.payload.products[0].delayState, expected);
      assert.equal(genericFollowupCandidates({order, ...selected.payload}).length, expected === "no_confirmed_date" ? 1 : 0);
      assert.equal(resolveFollowupItem(record, loaded).status, expected === "specific_date" ? "ready" : "pending");
    }
  }
});

test("an initial retry never submits a saved ETA that has become today or past", async () => fixture(async ({runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]];
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-02"};
  const event = {shop, payload: {admin_graphql_api_id: state.order.id, name: state.order.name,
    created_at: state.order.createdAt, tags: "Backorder"}};
  state.failSend = true;
  assert.equal(await api.processBackorderWebhook(event), "retry");
  assert.equal(state.sends.length, 1);
  state.failSend = false;
  await runDay(2);
  assert.equal(await api.processBackorderWebhook(event), "waiting");
  await runDay(3);
  assert.equal(await api.processBackorderWebhook(event), "waiting");
  assert.equal(state.sends.length, 1, "An uncertain prior send cannot be replaced with a new or expired promise");
}));


test("manual initial emails cannot newly enroll pre-cutoff orders for automatic follow-ups", async () => fixture(async () => {
  state.order.lineItems = [state.order.lineItems[0]];
  state.history.source = "app";
  const products = [{sku: "A", delayState: "no_confirmed_date"}];
  const rawCandidates = [{lineItemId: "A", variantId: "v-A", sku: "A", kind: "backorder"}];
  for (const createdAt of ["2026-09-25T12:00:00Z", "2026-09-30T23:19:59.999Z", "invalid", null]) {
    state.order.createdAt = createdAt;
    const tracking = await api.prepareFollowupTracking({admin: {}, shop, orderId: state.order.id,
      products, emailType: "dynamic_shipping_delay"});
    assert.deepEqual(tracking, {order: null, candidates: []});
    await api.saveFollowupTracking(state.history, tracking);
    // The durable save boundary separately rejects stale/prepared candidates.
    await api.saveFollowupTracking(state.history, {order: state.order, candidates: rawCandidates});
    assert.equal(state.rows.length, 0, "No manual or stale candidate can enroll this historical order");
  }
  state.order.createdAt = rollout;
  const tracking = await api.prepareFollowupTracking({admin: {}, shop, orderId: state.order.id,
    products, emailType: "dynamic_shipping_delay"});
  assert.equal(tracking.candidates.length, 1);
  await api.saveFollowupTracking({...state.history, orderId: "gid://shopify/Order/999"}, tracking);
  assert.equal(state.rows.length, 0, "A different order's snapshot cannot justify enrollment");
  await api.saveFollowupTracking(state.history, tracking);
  assert.equal(state.rows.length, 1, "New-cutoff manual generic emails can still enroll normally");
  assert.equal(state.loads, 5, "Enrollment save never performs a second Shopify read");
}));

test("older orders with tracking created at or after rollout cannot send daily updates", async () => {
  for (const createdAt of [new Date(rollout), new Date("2026-10-01T00:00:00Z"), undefined, new Date("invalid")]) {
    await fixture(async ({enroll, runDay}) => {
      state.order.lineItems = [state.order.lineItems[0]]; await enroll();
      // Simulate a late record written by an older deployment with its old policy.
      state.order.createdAt = "2026-09-28T03:26:33Z";
      state.rows[0].createdAt = createdAt;
      state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-20"};
      await runDay(1); await runDay(2);
      assert.equal(state.sends.length, 0); assert.equal(state.rows[0].status, "skipped");
    });
  }
});

test("a saved follow-up retry cannot use late enrollment to bypass the old-order cutoff", async () => fixture(async ({enroll, runDay}) => {
  state.order.lineItems = [state.order.lineItems[0]]; await enroll();
  state.order.lineItems[0].variant.availabilityDate = {type: "date", value: "2026-10-20"};
  state.failSend = true; await runDay(1);
  assert.equal(state.batches.length, 1); assert.equal(state.sends.length, 1);
  // The next Shopify snapshot proves this queued order is actually historical.
  state.order.createdAt = "2026-09-28T03:26:33Z";
  state.failSend = false;
  await runDay(2); await runDay(3);
  assert.equal(state.sends.length, 1, "The prepared batch never reaches the provider again");
  assert.equal(state.batches[0].status, "held");
}));
