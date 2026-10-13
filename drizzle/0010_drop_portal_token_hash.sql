ALTER TABLE "participant" DROP CONSTRAINT "participant_portal_token_hash_unique";--> statement-breakpoint
ALTER TABLE "participant" DROP COLUMN "portal_token_hash";