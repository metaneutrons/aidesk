CREATE TABLE "config_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"status" text NOT NULL,
	"proposed_by" text NOT NULL,
	"proposer_kind" text NOT NULL,
	"idempotency_key" uuid,
	"payload" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	"applied_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "config_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "config_change" ADD CONSTRAINT "config_change_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_change_project_idx" ON "config_change" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "config_change_key_idx" ON "config_change" USING btree ("project_id","idempotency_key");--> statement-breakpoint
-- Operators who manage a project also hold the new configuration actions.
UPDATE "membership" SET "actions" = "actions" || '["config.read","config.write","config.approve"]'::jsonb WHERE "actions" ? 'project.manage' AND NOT ("actions" ? 'config.read');
