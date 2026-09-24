# Red Head backorder rollout

Production initial automation remains **off** pending Mike's next instruction.

Production configuration saved September 24, 2026:

- `NOTIFY_DOCK_AUTOMATION_MODE=off`
- `NOTIFY_DOCK_AUTOMATION_SHOPS=fbgure-nn.myshopify.com`
- `NOTIFY_DOCK_AUTOMATION_START_AT=2026-09-24T21:40:39Z` (2:40:39 p.m. Pacific)
- Follow-up checks: 4 p.m. America/Los_Angeles, including daylight saving changes.

The explicit cutoff applies to manual composer autofill and follow-ups even while initial automation is off.
Older orders open with no automatic SKU selection; staff can still enter SKUs and dates manually.
Missing or invalid cutoff configuration cannot autofill historical orders.
An older order cannot enroll through a manual email, and old pending items and
queued follow-up batches cannot send. Manual email sending remains available.

Initial automation is implemented but its cron returns immediately in off mode.
When authorized to enable, retain the saved cutoff. Initial selection and enqueue
both verify Shopify's order creation timestamp; adding a Backorder tag to an older
order does not make it eligible.
Order webhooks have not been activated; the five-minute cron can discover eligible
new orders when enabled.

Migration `20260924222000_lock_backorder_cutoff` provisions the production cutoff
in `NotifyDockAutomationPolicy`. The app has no creation or update path for this
policy, and a database trigger rejects updates/deletes. Missing configuration,
missing policy, an environment/database mismatch or a database read failure stops
automatic processing. Both initial processing and follow-ups require this policy,
even when initial automation is off. Restoring a deleted policy requires an explicit
migration, not a runtime setting.

All automatic provider calls go through `sendAutomaticBackorderEvent`, which checks
the policy again, verifies the appropriate enable flag and payload order ID, reloads
the actual order from Shopify, and rejects old, missing, invalid-date or cancelled
orders. Queued and retry payloads cannot bypass this gate. Manual Send/Resend retain
their existing authenticated routes. If the policy is unavailable, manual sending
does not enroll follow-ups and composer autofill stays blank.

Only exact-vendor `Red-Head Steering Gears Inc.` items with Backorder or Built to
Order availability qualify. Initial sends save email history and enroll only items
that actually received generic messaging. Confirmed items are excluded from that
follow-up. In Stock/fulfilled/cancelled items stop without a follow-up email.
