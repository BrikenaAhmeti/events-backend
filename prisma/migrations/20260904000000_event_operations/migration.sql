ALTER TYPE "EventStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "Event"
ADD COLUMN "venueAddress" TEXT,
ADD COLUMN "venueDetails" TEXT,
ADD COLUMN "restroomInformation" TEXT,
ADD COLUMN "accessibilityInformation" TEXT,
ADD COLUMN "parkingInformation" TEXT,
ADD COLUMN "wifiInformation" TEXT;

CREATE INDEX "Event_createdByUserId_startAt_idx" ON "Event"("createdByUserId", "startAt");

INSERT INTO "ClientMembershipPermission" ("id", "membershipId", "permission")
SELECT gen_random_uuid(), existing."membershipId", 'EVENT_DELETE'
FROM "ClientMembershipPermission" existing
WHERE existing."permission" = 'EVENT_EDIT'
AND NOT EXISTS (
  SELECT 1
  FROM "ClientMembershipPermission" current_permission
  WHERE current_permission."membershipId" = existing."membershipId"
  AND current_permission."permission" = 'EVENT_DELETE'
);
