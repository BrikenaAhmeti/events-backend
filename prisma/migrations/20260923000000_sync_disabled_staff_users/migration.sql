-- Keep application-level authentication status aligned with team access.
-- Platform administrators stay active even when they have no client membership.
UPDATE "User" AS users
SET "status" = 'DISABLED', "updatedAt" = CURRENT_TIMESTAMP
WHERE users."platformRole" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "ClientMembership" AS memberships
    WHERE memberships."userId" = users."id"
      AND memberships."status" = 'ACTIVE'
  );

UPDATE "User" AS users
SET "status" = 'ACTIVE', "updatedAt" = CURRENT_TIMESTAMP
WHERE users."platformRole" IS NOT NULL
   OR EXISTS (
    SELECT 1
    FROM "ClientMembership" AS memberships
    WHERE memberships."userId" = users."id"
      AND memberships."status" = 'ACTIVE'
  );
