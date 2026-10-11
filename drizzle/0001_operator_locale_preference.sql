ALTER TABLE "auth_user" ALTER COLUMN "locale" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "locale" DROP NOT NULL;--> statement-breakpoint
-- Until now every row carried the column default rather than an explicit
-- choice. Clear it so the browser language applies until an operator chooses.
UPDATE "auth_user" SET "locale" = NULL;
