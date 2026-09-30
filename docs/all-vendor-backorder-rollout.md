# All-vendor backorder automation

Automatic initial notices now include every vendor. Orders still need the Backorder tag, eligible unfulfilled variants, a usable recipient and valid availability data. Existing recorded backorder/shipping-delay emails suppress another initial notice. Shopify order-created/updated webhooks process only that order; there is no historical scan or queue-wide drain.

The tag does not need to be present at checkout or order creation. Adding it later, even on a later day, processes that order through the same eligibility and duplicate checks. This also applies to an actual Shopify order created by completing a draft. Uncompleted DraftOrder objects do not trigger customer backorder notices.

New initial notices require orders created on or after September 30, 2026 at 4:20 p.m. Pacific (`2026-09-30T23:20:00Z`). The new database `initialStartAt` and production `NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT` setting must match. The existing `startAt`/`NOTIFY_DOCK_AUTOMATION_START_AT` remains unchanged for already-enrolled follow-ups and manual prefill. Missing or mismatched policy fails closed before a new automatic initial send, including retries. A separate production code minimum also rejects matching stale settings earlier than 4:20 p.m. New manual-email follow-up enrollment uses the same initial cutoff; older manual emails cannot create new automatic tracking.

The initial email includes eligible Backorder and Built to Order items with known and unknown estimates. Backorder dates on or before the sending day use the generic message and enroll just like a missing date; only future dates are shown. The sending day uses the Shopify store timezone, not the order creation date. Only included generic items without a usable future Backorder ETA or Built to Order message are enrolled. At the existing daily 4 p.m. Pacific check, newly dated Backorder items or Built to Order items with a new message are emailed together when they belong to the same initial email. Each item completes after one accepted follow-up. Other undated items keep waiting and can receive their own update on later days. Cancelled, fulfilled, removed or reclassified items stop tracking without an email. There is no order-wide stop while other eligible items remain pending.

Mike/Cade clarification, September 30: the Backorder order tag is required for the initial automatic email, as observed in the initial attempt’s Shopify snapshot. Removing that tag AFTER enrollment does not stop follow-ups. Product availability and outstanding line quantities remain authoritative. A fully fulfilled order cannot receive a follow-up; partial fulfillment stops only the fulfilled items. If all initial products already have estimates, no follow-up records are created.

Follow-ups retain their original recipient, frozen payload and stable event ID across uncertain provider retries. Each processing attempt reads Shopify once per order and builds the email from that snapshot. Retries and subsequent daily checks fetch a fresh snapshot; persisted retry payloads must still match that attempt’s tracked items/estimates. There is no second lookup immediately before sending. If a saved batch changes between attempts BEFORE any provider call, it is retired and each item is resolved separately: ineligible items stop, undated items wait, and still-ready items regroup during the daily run. Once a provider attempt is possible, a changed batch is held for review instead of generating another event. Accepted items never reopen.

Automatic products carry exact variant and order-line identities. Matching cannot enroll an already-dated variant merely because a different variant shares its SKU. Variant-SKU fallback and whitespace normalization are consistent. Legacy/manual payloads that only have SKUs enroll only unambiguous variants; ambiguous SKUs are not guessed. Initial retries check recorded email history even when their payload was already saved, and check again immediately before contacting the provider.

Daily pagination selects complete initial-email groups, preventing the 100-item page boundary from splitting a normal order into multiple same-day emails. Customer product order follows the Shopify order's line order.

The earlier initial-cutoff migration introduced `initialStartAt` without changing email history or tracking records and was previously exercised in the isolated notifydock_dev schema. The two newer local migrations described below have been reviewed but have not been executed against a database during this audit.

Validation covers five vendors receiving dates on five different days, grouping same-day updates, excluding previously dated items, changes to In Stock, no restart after completion, retries, the exact UTC/Pacific cutoff boundary, and preservation of pre-rollout Red Head follow-ups. All provider calls in automated tests are mocked.

## Local audit fixes awaiting release

Preserve order **#969960**, item **RH-2879U**. The September 30 read-only audit confirmed an already-delivered generic initial notice, one pending follow-up, an unfulfilled Backorder item and no ETA. Mike explicitly confirmed that this existing tracking must continue. Keep its current tracking/history records and the original follow-up cutoff unchanged. Older orders additionally need durable pending/batched tracking created before the 4:20 p.m. rollout; this approved record qualifies. No order-specific runtime exception or re-enrollment is needed. The regression suite seeds this existing pending record, verifies daily waiting across the new cutoff, then verifies one ETA update and no further checks afterward. Normal fulfillment, cancellation and availability stop rules still apply.

The follow-up attempt-evidence migration (`20260930233000_followup_attempt_evidence`) is additive and has not been applied as part of this local work. Legacy batches, including inserts from an older deployment during rollout, are conservatively treated as possibly attempted. The new worker explicitly creates unsent batches with `attemptedAt: null` and must persist an attempt timestamp after final eligibility checks but before contacting Klaviyo. A failed timestamp write blocks sending.

These audit fixes are local only; no push or deployment is authorized yet. Mike revised the fixed cutoff to September 30 at 4:20 p.m. Pacific. The forward migration `20260930234000_initial_cutoff_1620_pacific` advances only the production shop's initial cutoff, atomically restores its immutable trigger, and refuses to move a later cutoff backward. The already-applied 3:30 p.m. migration is unchanged. At the authorized release, the environment must match: `NOTIFY_DOCK_AUTOMATION_INITIAL_START_AT=2026-09-30T23:20:00Z`. Do not change the original cutoff or existing follow-up records. Neither migration nor any production environment change was applied by this local work.

A future ETA present in the initial snapshot goes in the initial email and does not enroll that item. An ETA added after a generic initial snapshot is handled by the next scheduled 4 p.m. Pacific follow-up check. A change after a daily check is picked up the next day. Fulfillment and availability are evaluated from the same snapshot as the email; changes after that snapshot do not change the current email. Reading a large order may require line-item pagination, but there is no additional verification lookup.


## Final local audit — September 30, 2026

Three independent reviews covered initial eligibility/delivery, follow-up scheduling/state, and tests/schema/rollout. No new blocking defect was found. This pass changed only test coverage and clarified migration documentation; application behavior was unchanged.

All 50 regression tests pass. The added combined test exercises the actual webhook service, initial completion transaction calls, saved history/tracking, and daily follow-up worker with mocked external services. It proves failed initial requests do not enroll items, successful retries retain their event identity, only generic emailed items enroll, and one dated follow-up completes tracking even after tag removal. The composer suite verified 39 previews and intercepted 15 sends locally. Extension type checks, modified-file lint, Prisma schema validation, and the application build also pass.

These are local checks, not a production delivery test. Database mocks do not prove PostgreSQL rollback, constraints, or migration execution. The two new migrations remain unapplied; the production initial cutoff setting must match the 4:20 p.m. migration during the authorized release.

Existing limits retained by this change:

- An initial email waits if required data is invalid (for example, an invalid date, missing SKU, or missing email). An order update rechecks it. Updating only product metadata does not itself trigger an order webhook.
- Manual Send/Resend does not acquire the automatic job lease. An exactly concurrent manual and automatic request can overlap before either records history. Recorded prior notices and automatic-only retries remain protected.
- If a provider request may have succeeded and its recipient/items/estimate later changes, the saved job or batch requires review rather than creating a new event. Held follow-up batches have database reasons but no dedicated review UI.
- Each attempt uses one Shopify snapshot as requested; changes after the read do not alter that email. The daily workflow targets 4 p.m. Pacific, but the scheduler may start late.

The retry identity matches Klaviyo’s documented `(profile, metric, unique_id)` deduplication rule ([Events API overview](https://developers.klaviyo.com/en/reference/events_api_overview)). The daily workflow uses GitHub’s documented timezone-aware schedule syntax ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule)).

No push, deployment, database migration, production configuration change, or real customer email occurred during this audit.

September 30 ETA clarification: today and earlier are generic in initial notices and composer autofill. Daily Backorder follow-ups remain pending for missing, today, or expired dates; only a strictly future date sends the one-time update. Existing fulfillment/stock/cutoff rules and Built to Order text messages are unchanged. An uncertain retry whose saved future date has since elapsed is held rather than sending the stale date or creating another initial event.


## Cutoff-focused audit and fixes — September 30, 2026

This additional audit found and closed two paths: matching stale production settings could still admit the 3:30–4:20 interval, and manually sending a generic email could newly enroll an older order under the original follow-up cutoff.

Production now has an independent 4:20 p.m. code minimum as well as the locked database/environment checks. Both preparation and saving of new tracking require the initial cutoff and the order identity/creation date from the same Shopify snapshot. Manual Send/Resend itself remains a deliberate staff action; sending manually to an old order no longer starts new automatic follow-ups.

The daily worker and final automatic provider gate also enforce the exception boundary: an older order must satisfy the original cutoff and have matching, pending/batched tracking created before the new rollout cutoff. Missing dates, late-created records (including writes from an older app version), wrong identities, and already-completed records cannot qualify. The existing September 28 tracking for #969960 remains eligible. There is no historical-order scan or backfill.

Regression coverage now includes jointly stale production settings, direct final-gate denial without pre-rollout tracking, manual preparation plus durable-save rejection, late legacy records, saved follow-up retries, and preserved #969960. All 59 regression tests pass with mocked providers/database; independent reviewers rechecked the updated runtime callsites and cutoff boundaries. No extra Shopify lookup was added.

Release boundary: these local guards cannot change code still serving on an older deployment or recall email requests already accepted by Klaviyo. The previously deployed Red Head revision uses the original cutoff for its initial sends; advancing only initialStartAt does not protect its in-flight requests. At an authorized release, retire the old sender, account for in-flight work, apply the reviewed migrations/matching configuration, and verify the active new revision before declaring the new cutoff live. No release actions were performed during this audit.
