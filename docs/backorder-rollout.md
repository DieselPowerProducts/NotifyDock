# Red Head backorder rollout

Production initial automation remains **off** pending Mike's next instruction.

Production configuration saved September 24, 2026:

- `NOTIFY_DOCK_AUTOMATION_MODE=off`
- `NOTIFY_DOCK_AUTOMATION_SHOPS=fbgure-nn.myshopify.com`
- `NOTIFY_DOCK_AUTOMATION_START_AT=2026-09-24T21:40:39Z` (2:40:39 p.m. Pacific)
- Follow-up checks: 4 p.m. America/Los_Angeles, including daylight saving changes.

The explicit cutoff applies to follow-ups even while initial automation is off.
An older order cannot enroll through a manual email, and old pending items and
queued follow-up batches cannot send. Manual email sending remains available.

Initial automation is implemented but its cron returns immediately in off mode.
When authorized to enable, retain the saved cutoff unless Mike explicitly changes
it. Initial selection and enqueue both verify Shopify's order creation timestamp;
adding a Backorder tag to an older order does not make it eligible. The first scan
persists the cutoff and rejects a later environment change that disagrees with it.
Order webhooks have not been activated; the five-minute cron can discover eligible
new orders when enabled.

Only exact-vendor `Red-Head Steering Gears Inc.` items with Backorder or Built to
Order availability qualify. Initial sends save email history and enroll only items
that actually received generic messaging. Confirmed items are excluded from that
follow-up. In Stock/fulfilled/cancelled items stop without a follow-up email.
