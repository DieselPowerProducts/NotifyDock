-- Distinguish a batch blocked before contacting the provider from an uncertain
-- send. Legacy batches have unknown attempt history and must remain conservative.
-- The default also protects inserts by an older deployment during rollout. Only
-- the new worker explicitly writes NULL when it can prove no attempt was made.
BEGIN;
ALTER TABLE "NotifyDockFollowupBatch" ADD COLUMN "attemptedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "NotifyDockFollowupBatch" SET "attemptedAt" = "createdAt";
COMMIT;
