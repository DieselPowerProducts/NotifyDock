-- Revised by Mike: September 30, 2026 at 4:20 p.m. America/Los_Angeles.
-- Forward migration: never rewrite the already-applied 3:30 p.m. migration.
-- Preserve the original cutoff and every existing email/tracking record.
BEGIN;
LOCK TABLE "NotifyDockAutomationPolicy" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "NotifyDockAutomationPolicy"
    WHERE "shop" = 'fbgure-nn.myshopify.com'
      AND "startAt" <= TIMESTAMP '2026-09-30 23:20:00'
      AND "initialStartAt" <= TIMESTAMP '2026-09-30 23:20:00'
  ) THEN
    RAISE EXCEPTION 'Expected rollout policy is missing or already has a later cutoff; refusing to widen eligibility.';
  END IF;
END;
$$;
DROP TRIGGER notify_dock_immutable_cutoff ON "NotifyDockAutomationPolicy";
UPDATE "NotifyDockAutomationPolicy"
SET "initialStartAt" = TIMESTAMP '2026-09-30 23:20:00'
WHERE "shop" = 'fbgure-nn.myshopify.com';
CREATE TRIGGER notify_dock_immutable_cutoff
BEFORE UPDATE OR DELETE ON "NotifyDockAutomationPolicy"
FOR EACH ROW EXECUTE FUNCTION notify_dock_protect_cutoff();
COMMIT;
