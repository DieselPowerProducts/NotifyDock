# Polaris production rollout — 2026-09-30

Promotes the UI migration tested in NotifyDock-Dev commit `35e6e4700f8add65cdda8b6ceb1d3b4f9c4be643` onto production baseline `4a170ecb9deb37dd70b21f8f36e6d70627d17d56`.

## Changes

Both Admin UI extensions use API `2026-07`, Preact, and Polaris web components. The shared adapter translates button/input events, selected dates/ranges, action slots, image labels, and layout dimensions. The composer retains its existing state rules and send payloads. The dependency lock matches the tested dev release.

Production backend code, Shopify app configuration, webhook subscriptions, database definitions/migrations, Vercel configuration, and the daily follow-up workflow are unchanged. Dev environment variables and the isolated dev schema are not part of this promotion. The exact Red Head vendor restriction remains in place.

## Verification

- `npm run typecheck:extensions`
- `npm run test:regression` — existing 23 backend tests, including the actual production scheduler definition.
- `npm run test:composer` — mocked Preact/DOM tests for all five email types, dates/ranges, preview freshness, validation, error recovery, history/resend, and order-page launching.
- `npm run build` — local build without production database credentials.
- `shopify app build --client-id c920a666bf14b16b8513c20330af7e3d`

Mocks do not prove actual provider delivery. After release, check the composer on a production order and monitor the next eligible automatic Red Head event in NotifyDock/Klaviyo history.

## Deployment targets and rollback references

- GitHub: `DieselPowerProducts/NotifyDock`, `main`.
- Vercel: `notify-dock`, `https://notify-dock.vercel.app`.
- Shopify: `NotifyDock`, client ID `c920a666bf14b16b8513c20330af7e3d`.
- Verified installed production store: Diesel Power Products, primary domain `dieselpowerproducts.com`, canonical domain `fbgure-nn.myshopify.com`.
- Previous Shopify release: `red-head-webhooks-4a170ec` (`1143326343169`).
- Previous Vercel deployment: `dpl_28qVACWF8uMqK3h7FGyqX561xarZ`.

The production Shopify release is separate from Vercel's Git-triggered backend deployment. Retain both previous versions for rollback. No schema/data rollback is needed for this UI migration.
