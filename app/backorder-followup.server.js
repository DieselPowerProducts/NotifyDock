import {createHash, randomUUID, timingSafeEqual} from "node:crypto";
import prisma from "./db.server";
import {unauthenticated} from "./shopify.server";
import {METRIC_NAMES} from "./klaviyo.server";
import {sendAutomaticBackorderEvent} from "./backorder-automatic-send.server";
import {requireBackorderPolicy, requireInitialBackorderPolicy, followupEnabled} from "./backorder-policy.server";
import {buildDynamicShippingDelayDetailsHtml} from "./notify-dock-email-template.server";
import {loadBackorderOrder} from "./backorder-automation-shopify.js";
import {genericFollowupCandidates, nextFollowupCheck, resolveFollowupItem, followupMatchesPayload, isFollowupWithinCutoff} from "./backorder-followup.js";
import {hasBackorderTag, isOrderAfterBackorderCutoff} from "./backorder-automation.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function authorizeFollowupCron(request) {
  const secret = process.env.NOTIFY_DOCK_FOLLOWUP_SECRET;
  if (!secret) return false;
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function prepareFollowupTracking({admin, shop, orderId, products, emailType, globalShipDate}) {
  const none = {order: null, candidates: []};
  if (!followupEnabled(shop) || emailType !== "dynamic_shipping_delay" || globalShipDate ||
    !products.some((p) => ["", "no_confirmed_date"].includes(p.delayState || ""))) return none;
  let config;
  try { config = await requireInitialBackorderPolicy(shop); }
  catch (_error) { return none; } // Manual sending remains available; no automatic enrollment.
  const {order} = await loadBackorderOrder(admin, orderId);
  if (order?.id !== orderId || !isOrderAfterBackorderCutoff(order, config.startAt) || !hasBackorderTag(order.tags)) return none;
  return {order, candidates: genericFollowupCandidates({order, products, emailType, globalShipDate})};
}

export async function saveFollowupTracking(history, {order, candidates}, now = new Date(), db = prisma) {
  if (!candidates.length || !followupEnabled(history.shop) || !history.requestEventUniqueId || !["app", "backorder_automation"].includes(history.source)) return;
  const config = await requireInitialBackorderPolicy(history.shop, db);
  // New enrollment always obeys the new cutoff, including manual initial sends.
  // Use the original attempt snapshot; no additional Shopify read is needed.
  if (order?.id !== history.orderId || !isOrderAfterBackorderCutoff(order, config.startAt)) return;
  // Called only AFTER Klaviyo accepts the initial email and its history row is saved.
  // No backfill and no order/catalog scan can create these records.
  await db.notifyDockFollowupItem.createMany({data: candidates.map((item) => ({
    ...item, id: hash(`${history.shop}:${history.orderId}:${item.lineItemId}`),
    shop: history.shop, orderId: history.orderId, initialHistoryId: history.id,
    nextCheckAt: nextFollowupCheck(now, process.env.NOTIFY_DOCK_FOLLOWUP_TEST_AT),
  })), skipDuplicates: true});
}

async function reconcileChangedBatch(batch, records, loaded, now) {
  await prisma.$transaction(async (tx) => {
    if (batch.attemptedAt) {
      // A provider request may already have succeeded. Never create a new event
      // for those items; preserve the evidence and hold the batch for review.
      await tx.notifyDockFollowupBatch.update({where: {id: batch.id}, data: {
        status: "held", reason: "Items or ETA changed after a possible send; review provider activity before resending.",
      }});
      for (const record of records) {
        const resolution = resolveFollowupItem(record, loaded);
        await tx.notifyDockFollowupItem.update({where: {id: record.id}, data: {
          status: resolution.status === "skipped" ? "skipped" : "held",
          reason: resolution.status === "skipped" ? resolution.reason : "Possible prior send; review held batch.",
        }});
      }
      return;
    }
    // Nothing was sent. Retire this payload and keep each eligible companion
    // available for a fresh batch, without re-enrolling completed items.
    await tx.notifyDockFollowupBatch.update({where: {id: batch.id}, data: {
      status: "superseded", reason: "Items changed before any provider attempt; eligible items remain tracked.",
    }});
    for (const record of records) {
      const resolution = resolveFollowupItem(record, loaded);
      await tx.notifyDockFollowupItem.update({where: {id: record.id}, data: {
        batchId: null, status: resolution.status === "skipped" ? "skipped" : "pending",
        reason: resolution.reason || "Estimate changed before sending; ready to regroup.",
        nextCheckAt: resolution.status === "ready" ? now : nextFollowupCheck(now),
      }});
    }
  });
}

export async function runBackorderFollowups(now = new Date()) {
  const shops = (process.env.NOTIFY_DOCK_FOLLOWUP_SHOPS || "").split(",").map((s) => s.trim()).filter(followupEnabled);
  const summary = [];
  const deadline = Date.now() + 45000;
  for (const shop of shops) {
    const config = await requireBackorderPolicy(shop);
    const outsideCutoff = (order, records) => !isFollowupWithinCutoff({shop, order, records, config});
    const token = randomUUID();
    await prisma.notifyDockFollowupLease.upsert({where: {shop}, create: {shop}, update: {}});
    const lock = await prisma.notifyDockFollowupLease.updateMany({where: {shop, OR: [{leaseUntil: null}, {leaseUntil: {lt: now}}]},
      data: {token, leaseUntil: new Date(now.getTime() + 10 * 60 * 1000)}});
    if (!lock.count) continue;
    try {
      const dueWhere = {shop, status: "pending", nextCheckAt: {lte: now}};
      const seeds = await prisma.notifyDockFollowupItem.findMany({where: dueWhere,
        select: {initialHistoryId: true}, orderBy: [{nextCheckAt: "asc"}, {id: "asc"}], take: 100});
      const historyIds = [...new Set(seeds.map((row) => row.initialHistoryId))].slice(0, 20);
      // Page complete initial-email groups, never individual items within them.
      const due = historyIds.length ? await prisma.notifyDockFollowupItem.findMany({
        where: {...dueWhere, initialHistoryId: {in: historyIds}}, include: {initialHistory: true},
        orderBy: [{nextCheckAt: "asc"}, {id: "asc"}],
      }) : [];
      const batches = await prisma.notifyDockFollowupBatch.findMany({where: {shop, status: "pending", nextAttemptAt: {lte: now}}, take: 20});
      if (!due.length && !batches.length) { summary.push({shop, checked: 0}); continue; }
      const {admin} = await unauthenticated.admin(shop);
      const orders = new Map();
      const load = async (id) => {
        if (!orders.has(id)) orders.set(id, await loadBackorderOrder(admin, id, now));
        return orders.get(id);
      };
      const groups = Map.groupBy(due, (row) => row.initialHistoryId);
      for (const records of groups.values()) {
        if (Date.now() >= deadline) break;
        const history = records[0].initialHistory;
        if (history.shop !== shop || !["app", "backorder_automation"].includes(history.source) || !history.requestEventUniqueId ||
          history.emailType !== "dynamic_shipping_delay" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(history.customerEmail)) {
          await prisma.notifyDockFollowupItem.updateMany({where: {id: {in: records.map((r) => r.id)}}, data: {status: "skipped", reason: "Initial send record is not eligible."}});
          continue;
        }
        const loaded = await load(history.orderId);
        if (outsideCutoff(loaded.order, records)) {
          await prisma.notifyDockFollowupItem.updateMany({where: {id: {in: records.map((r) => r.id)}}, data: {status: "skipped", reason: "Order is outside the cutoff and lacks eligible pre-rollout tracking."}});
          continue;
        }
        const positions = new Map(loaded.order.lineItems.map((item, index) => [item.id, index]));
        records.sort((a, b) => (positions.get(a.lineItemId) ?? Infinity) - (positions.get(b.lineItemId) ?? Infinity));
        const ready = [];
        for (const record of records) {
          const resolution = resolveFollowupItem(record, loaded);
          if (resolution.status === "ready") ready.push({record, product: resolution.product});
          else await prisma.notifyDockFollowupItem.update({where: {id: record.id}, data: {
            status: resolution.status, reason: resolution.reason, nextCheckAt: nextFollowupCheck(now),
          }});
        }
        if (!ready.length) continue;
        // Persist once, then reuse on every retry. A retired, never-sent batch can
        // be regrouped without colliding with its old record-set identity.
        const id = `nd-followup-${randomUUID()}`;
        const products = ready.map((r) => r.product);
        const payload = {customerEmail: history.customerEmail, firstName: history.firstName || "",
          emailType: "dynamic_shipping_delay", fromAddress: history.fromAddress || "orders@dieselpowerproducts.com",
          orderId: history.orderId, orderNumber: history.orderNumber, shop: loaded.shopName || shop,
          products, sku: products.map((p) => p.sku).join(", "), globalShipDate: "", shipDate: "", sentByEmail: "",
          subject: `Updated shipping estimate for order ${history.orderNumber}`,
          message: "<p>We have updated shipping information for the following item(s) in your order.</p>" + buildDynamicShippingDelayDetailsHtml({products}),
          requestEventUniqueId: id, metricName: METRIC_NAMES.dynamic_shipping_delay, requestTimeoutMs: 15000};
        const batch = await prisma.$transaction(async (tx) => {
          const created = await tx.notifyDockFollowupBatch.create({data: {
            id, shop, orderId: history.orderId, payload, nextAttemptAt: now, attemptedAt: null,
          }});
          await tx.notifyDockFollowupItem.updateMany({where: {id: {in: ready.map((r) => r.record.id)}}, data: {status: "batched", batchId: id}});
          return created;
        });
        batches.push(batch);
      }
      for (const batch of batches) {
        if (Date.now() >= deadline) break;
        const records = await prisma.notifyDockFollowupItem.findMany({where: {batchId: batch.id, shop}});
        const loaded = await load(batch.orderId);
        if (outsideCutoff(loaded.order, records)) {
          await prisma.notifyDockFollowupBatch.update({where: {id: batch.id}, data: {status: "held", reason: "Order is outside the cutoff and lacks eligible pre-rollout tracking."}});
          continue;
        }
        if (!followupMatchesPayload(records, loaded, batch.payload)) {
          await reconcileChangedBatch(batch, records, loaded, now);
          continue;
        }
        try {
          const result = await sendAutomaticBackorderEvent({shop, orderId: batch.orderId, payload: batch.payload, kind: "followup", loaded, followupRecords: records,
            beforeSend: async () => {
              if (!batch.attemptedAt) {
                const marked = await prisma.notifyDockFollowupBatch.update({where: {id: batch.id}, data: {attemptedAt: new Date()}});
                batch.attemptedAt = marked.attemptedAt;
              }
            }});
          const payload = batch.payload;
          await prisma.$transaction([
            prisma.notifyDockEmailHistory.upsert({where: {sourceEventId: batch.id}, update: {}, create: {
              shop, orderId: payload.orderId, orderNumber: payload.orderNumber, customerEmail: payload.customerEmail,
              firstName: payload.firstName, fromAddress: payload.fromAddress, emailType: payload.emailType,
              subject: payload.subject, message: payload.message, sku: payload.sku, metricName: result.metricName,
              source: "backorder_followup", sourceEventId: batch.id, requestEventUniqueId: batch.id, sentAt: now,
            }}),
            prisma.notifyDockFollowupBatch.update({where: {id: batch.id}, data: {status: "accepted", acceptedAt: now, reason: null}}),
            prisma.notifyDockFollowupItem.updateMany({where: {batchId: batch.id}, data: {status: "accepted", reason: "One-time follow-up accepted by Klaviyo."}}),
          ]);
        } catch (error) {
          await prisma.notifyDockFollowupBatch.update({where: {id: batch.id}, data: {
            nextAttemptAt: nextFollowupCheck(now), reason: `${error.message}`.slice(0, 1000),
          }});
        }
      }
      summary.push({shop, checked: due.length, batches: batches.length});
      await prisma.notifyDockFollowupLease.update({where: {shop}, data: {lastError: null}});
    } catch (error) {
      await prisma.notifyDockFollowupLease.update({where: {shop}, data: {lastError: `${error.message}`.slice(0, 1000)}});
      throw error;
    } finally {
      await prisma.notifyDockFollowupLease.updateMany({where: {shop, token}, data: {token: null, leaseUntil: null, lastRunAt: now}});
    }
  }
  // Drain additional pages during this one daily run, without another timer.
  let remaining = 0;
  for (const shop of shops) {
    remaining += await prisma.notifyDockFollowupItem.count({where: {shop, status: "pending", nextCheckAt: {lte: now}}});
    remaining += await prisma.notifyDockFollowupBatch.count({where: {shop, status: "pending", nextAttemptAt: {lte: now}}});
  }
  return {shops: summary, hasMore: remaining > 0};
}
