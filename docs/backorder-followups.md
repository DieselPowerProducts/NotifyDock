# One-time follow-ups after manual generic notices

Initial email sending remains manual. Only successful new `/api/backorder-email` sends can enroll items, after the initial Klaviyo event is accepted and its `NotifyDockEmailHistory` row is saved. Existing history is never backfilled and no order/catalog search is performed by the scheduler.

Enrollment requires a Shipping Delay email with no global date, an included product using the generic message, and an outstanding order line with an exact Red-Head Steering Gears Inc. vendor and Backorder / Build to Order / Built to Order availability. Each record identifies the shop, order, line item, variant, original availability type and initial email history. An item is enrolled only once per order. The recipient comes from the original manual email, including an address typed into To.

Backorder records wait for a valid non-past `custom.product_availability_date`. Built to Order records wait for nonblank plain text in `custom.build_to_order_message`. Missing information remains pending. Cancelled, fulfilled, removed or reclassified items stop without sending. Ready items from the same initial email are grouped into one follow-up. Other waiting items can receive their own one-time follow-up later.

The Vercel scheduler wakes every five minutes but only reads Shopify for database items whose `nextCheckAt` is due. The normal next check is 17:00 America/Los_Angeles (DST-aware). `NOTIFY_DOCK_FOLLOWUP_TEST_AT` can schedule the first check at one explicit future timestamp. It has no effect once that timestamp passes. Retries after processing failures are separate from daily product checks.

`NOTIFY_DOCK_FOLLOWUP_ENABLED=true`, `NOTIFY_DOCK_FOLLOWUP_SHOPS` (exact shop allowlist) and `CRON_SECRET` are required. The current production pilot is fbgure-nn.myshopify.com. No scheduler is enabled in previews by default. Set enabled=false and redeploy to stop enrollment and processing.

Before contacting Klaviyo, the database stores a batch with its exact payload, recipient, metric and stable event ID. Retries reuse that ID so an uncertain network response cannot create another event. Changes to queued items hold the batch for review. A shop lease prevents concurrent workers. Accepted batches and items remain completed and are never sent again. Klaviyo acceptance is not proof of inbox delivery; delivery tracking remains in email history.

Verification: `node --test scripts/verify-backorder-followups.mjs`, `node --test scripts/verify-backorder-prefill.mjs`, `node scripts/verify-composer-dates.mjs`, `npm run build`.
