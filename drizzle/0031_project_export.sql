CREATE TABLE "project_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"digest" text NOT NULL,
	"bytes" integer NOT NULL,
	"counts" jsonb NOT NULL,
	"object_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "project_export_project_idx" ON "project_export" USING btree ("project_id","created_at");