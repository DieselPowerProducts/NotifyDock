import {normalizeAvailabilityDate, isOrderAfterBackorderCutoff, minimumInitialBackorderCutoff} from "./backorder-automation.js";

export function isFollowupWithinCutoff({shop, order, records, config}) {
  if (!isOrderAfterBackorderCutoff(order, config.startAt)) return false;
  const minimum = minimumInitialBackorderCutoff(shop);
  const initialCutoff = new Date(Math.max(
    config.initialStartAt?.getTime() || config.startAt.getTime(), minimum?.getTime() || 0,
  ));
  if (isOrderAfterBackorderCutoff(order, initialCutoff)) return true;
  // Older orders may only finish tracking that already existed before rollout.
  // New records from manual sends or a lingering old deployment cannot qualify.
  return Boolean(records?.length) && records.every((record) =>
    record.shop === shop && record.orderId === order.id &&
    ["pending", "batched"].includes(record.status) &&
    Number.isFinite(record.createdAt?.getTime()) &&
    record.createdAt >= config.startAt && record.createdAt < initialCutoff);
}

export function isFollowupRunHour(now = new Date()) {
  return Number.isFinite(now.getTime()) && new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23",
  }).format(now) === "16";
}

export function nextFollowupCheck(now, testAt = "") {
  const test = new Date(testAt);
  if (test > now) return test;
  // Find the next 16:00 in Pacific time, including daylight-saving transitions.
  const candidate = new Date(now);
  candidate.setUTCMinutes(0, 0, 0);
  for (let hour = 0; hour < 27; hour += 1) {
    if (candidate > now && new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23",
    }).format(candidate) === "16") return candidate;
    candidate.setUTCHours(candidate.getUTCHours() + 1);
  }
  throw new Error("Unable to calculate the next follow-up check.");
}

export function genericFollowupCandidates({order, products, emailType, globalShipDate}) {
  if (emailType !== "dynamic_shipping_delay" || globalShipDate || !order || order.cancelledAt) return [];
  const isGeneric = (p) =>
    ["", "no_confirmed_date"].includes(p.delayState || "") && !p.delayDate && !p.delayMessage &&
    !p.delayRangeStart && !p.delayRangeEnd;
  const skuFor = (item) => `${item.sku || item.variant?.sku || ""}`.trim();
  return order.lineItems.flatMap((item) => {
    const variant = item.variant;
    const availability = `${variant?.availability?.value || ""}`.trim().toLowerCase();
    const sku = skuFor(item);
    const included = products.some((p) => {
      if (!isGeneric(p) || `${p.sku || ""}`.trim() !== sku) return false;
      if (p.variantId || p.lineItemIds) return p.variantId === variant?.id && p.lineItemIds?.includes(item.id);
      // Older/manual composer payloads have only SKUs. Enroll only when that SKU
      // unambiguously identifies one variant and every emailed entry is generic.
      return new Set(order.lineItems.filter((line) => skuFor(line) === sku).map((line) => line.variant?.id)).size === 1 &&
        products.filter((other) => `${other.sku || ""}`.trim() === sku).every(isGeneric);
    });
    if (!sku || !included || !item.id || !variant?.id || item.unfulfilledQuantity <= 0 ||
      item.currentQuantity <= 0 ||
      !["backorder", "build to order", "built to order"].includes(availability)) return [];
    return [{lineItemId: item.id, variantId: variant.id, sku,
      kind: availability === "backorder" ? "backorder" : "built_to_order"}];
  });
}

export function resolveFollowupItem(record, {order, today, timeZone}) {
  // Backorder tag removal does not cancel a follow-up that was already enrolled.
  // Product availability and outstanding line quantities remain authoritative.
  const item = order?.lineItems.find((line) => line.id === record.lineItemId && line.variant?.id === record.variantId);
  if (!order || order.cancelledAt || !item || item.unfulfilledQuantity <= 0 || item.currentQuantity <= 0) return {status: "skipped", reason: "Item cancelled, removed, fulfilled, or no longer eligible."};
  const availability = `${item.variant.availability?.value || ""}`.trim().toLowerCase();
  if (!(record.kind === "backorder" ? availability === "backorder" : ["build to order", "built to order"].includes(availability))) {
    return {status: "skipped", reason: "Availability type changed; review manually."};
  }
  let date = "";
  let message = "";
  if (record.kind === "backorder") {
    date = normalizeAvailabilityDate(item.variant.availabilityDate, timeZone);
    if (!date || date <= today) return {status: "pending", reason: "No confirmed date after today."};
  } else {
    const field = item.variant.buildToOrderMessage;
    message = `${field?.value || ""}`.trim();
    if (!message || (field.type && !["single_line_text_field", "multi_line_text_field"].includes(field.type))) {
      return {status: "pending", reason: "No Built to Order message."};
    }
  }
  return {status: "ready", product: {lineItemId: record.lineItemId, variantId: record.variantId,
    sku: record.sku, productTitle: item.title,
    productVariantTitle: item.variantTitle || "", productImageUrl: item.variant.image?.url || item.image?.url || "",
    productImageAlt: item.variant.image?.altText || item.image?.altText || item.title,
    delayState: date ? "specific_date" : "build_to_order_message", delayDate: date, delayMessage: message,
    delayRangeStart: "", delayRangeEnd: ""}};
}

export function followupMatchesPayload(records, loaded, payload) {
  const current = records.map((record) => resolveFollowupItem(record, loaded));
  const remaining = [...payload.products];
  return records.length > 0 && current.length === remaining.length && current.every((item) => {
    if (item.status !== "ready") return false;
    const index = remaining.findIndex((product) =>
      // Legacy batches lack IDs; consume matches one-to-one even for those.
      (!product.lineItemId || product.lineItemId === item.product.lineItemId) &&
      (!product.variantId || product.variantId === item.product.variantId) &&
      product.sku === item.product.sku && product.delayDate === item.product.delayDate &&
      product.delayMessage === item.product.delayMessage);
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}
