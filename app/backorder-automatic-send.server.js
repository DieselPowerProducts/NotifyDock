import {requireBackorderPolicy, requireInitialBackorderPolicy, followupEnabled} from "./backorder-policy.server";
import {isOrderAfterBackorderCutoff, selectBackorderNotice, initialPayloadMatchesSelection} from "./backorder-automation.js";
import {sendNotifyDockEvent} from "./klaviyo.server";
import {isFollowupWithinCutoff} from "./backorder-followup.js";

// Every automatic provider request, including retries, must cross this gate.
// Manual Send/Resend deliberately use their existing authenticated routes.
export async function sendAutomaticBackorderEvent({shop, orderId, payload, kind, loaded, followupRecords, beforeSend}) {
  const config = await (kind === "initial" ? requireInitialBackorderPolicy(shop) : requireBackorderPolicy(shop));
  if (!(kind === "initial" ? config.mode === "live" : kind === "followup" && followupEnabled(shop))) {
    throw new Error("This automatic email path is disabled.");
  }
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId || "") || payload.orderId !== orderId) {
    throw new Error("Automatic email order identity does not match its job.");
  }
  // Use the same Shopify snapshot that selected the products and populated the
  // email. Each processing attempt loads it once; this gate never reads again.
  const order = loaded?.order;
  if (order?.id !== orderId || !isOrderAfterBackorderCutoff(order, config.startAt) || order.cancelledAt) {
    throw new Error("Automatic email blocked: order is missing, cancelled, or outside the locked creation cutoff.");
  }
  // Only the initial notice requires the tag. Enrolled follow-ups intentionally
  // continue after tag removal, subject to item availability and fulfillment.
  if (kind === "initial" && !initialPayloadMatchesSelection(payload, selectBackorderNotice({...loaded, config}))) {
    throw new Error("Automatic initial email blocked: payload does not match the eligible order snapshot.");
  }
  if (kind === "followup" && !isFollowupWithinCutoff({shop, order, records: followupRecords, config})) {
    throw new Error("Automatic follow-up blocked: older order lacks eligible pre-cutoff tracking.");
  }
  // Persist attempt evidence only AFTER the final checks, before any provider call.
  if (beforeSend) await beforeSend();
  return sendNotifyDockEvent(payload);
}
