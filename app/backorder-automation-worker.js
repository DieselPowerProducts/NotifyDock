import {selectBackorderNotice, initialPayloadMatchesSelection} from "./backorder-automation.js";
import {genericFollowupCandidates} from "./backorder-followup.js";

// Dependencies are injected so failure/retry behavior can be tested without sending email.
export async function processBackorderJob({job, config, repository, loadOrder, send, buildMessage, now = new Date()}) {
  const update = (data) => repository.update(job.id, data);
  const retryAt = new Date(now.getTime() + 15 * 60 * 1000);
  try {
    const loaded = await loadOrder(job.orderId);
    const {order, shopName, today, timeZone} = loaded;
    const selection = selectBackorderNotice({order, config, today, timeZone});
    if (selection.status !== "ready") {
      await update({status: selection.status, reason: selection.reason, nextAttemptAt: retryAt});
      return selection.status;
    }
    // Staff may have sent a notice since an earlier automatic attempt failed.
    if (await repository.hasPreviousNotice(job)) {
      await update({status: "previously_notified", reason: "A backorder or shipping-delay email is already recorded for this order."});
      return "previously_notified";
    }
    if (job.sendPayload && !initialPayloadMatchesSelection(job.sendPayload, selection)) {
      await update({
        status: "waiting",
        reason: "Recipient, eligible items, dates, or messages changed after a send attempt. Review Klaviyo activity before sending manually; the earlier request may already have been accepted.",
        nextAttemptAt: retryAt,
      });
      return "waiting";
    }
    // Once a send has been attempted, preserve its recipient, metric, payload and ID.
    // Klaviyo deduplicates retries using (profile, metric, unique_id).
    const payload = job.sendPayload || {
      ...selection.payload,
      followupCandidates: genericFollowupCandidates({order, ...selection.payload}),
      shop: shopName || job.shop,
      message: buildMessage(selection.payload),
      requestEventUniqueId: job.id,
      metricName: config.metricName,
      requestTimeoutMs: 15000,
    };
    if (config.mode !== "live") {
      await update({status: "ready", reason: "Dry run: ready to send; no email was requested.", previewPayload: payload, nextAttemptAt: retryAt});
      return "ready";
    }
    // This durable write MUST succeed before contacting Klaviyo.
    const attemptedAt = job.attemptedAt || now;
    await update({sendPayload: payload, previewPayload: payload, attemptedAt, attempts: {increment: 1}});
    const result = await send(payload, loaded);
    await repository.complete(job, payload, result, attemptedAt, order);
    return "accepted";
  } catch (error) {
    await update({
      status: "retry",
      reason: `Processing failed; will retry. ${error instanceof Error ? error.message : "Unknown error"}`.slice(0, 1500),
      nextAttemptAt: retryAt,
    });
    return "retry";
  }
}
