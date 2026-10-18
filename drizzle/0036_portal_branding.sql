CREATE TABLE "portal_branding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"display_name" text,
	"header_text" text,
	"accent_color" text,
	"language" text,
	"logo_key" text,
	"logo_type" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_branding" ADD CONSTRAINT "portal_branding_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_branding_project_idx" ON "portal_branding" USING btree ("project_id");