ALTER TYPE "ConversationType" ADD VALUE 'EVENT_SETUP';

CREATE TYPE "ConversationState" AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');

ALTER TABLE "Conversation"
  ALTER COLUMN "eventId" DROP NOT NULL,
  ADD COLUMN "state" "ConversationState" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "draft" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "completedAt" TIMESTAMPTZ(3);

ALTER TABLE "Document"
  ALTER COLUMN "eventId" DROP NOT NULL,
  ADD COLUMN "setupConversationId" UUID;

CREATE UNIQUE INDEX "Document_setupConversationId_checksum_key"
  ON "Document"("setupConversationId", "checksum");
CREATE INDEX "Document_setupConversationId_idx"
  ON "Document"("setupConversationId");
CREATE INDEX "Conversation_userId_clientId_type_state_updatedAt_idx"
  ON "Conversation"("userId", "clientId", "type", "state", "updatedAt");

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_setupConversationId_fkey"
  FOREIGN KEY ("setupConversationId") REFERENCES "Conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
