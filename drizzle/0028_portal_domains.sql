CREATE TABLE "portal_domain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"host" text NOT NULL,
	"token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_domain" ADD CONSTRAINT "portal_domain_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_domain_project_host_idx" ON "portal_domain" USING btree ("project_id","host");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_domain_verified_host_idx" ON "portal_domain" USING btree ("host") WHERE "portal_domain"."verified_at" is not null;