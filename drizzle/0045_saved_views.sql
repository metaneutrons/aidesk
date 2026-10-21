CREATE TABLE "saved_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"list" text NOT NULL,
	"projects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tag" text,
	"priority" text,
	"category" text,
	"is_start" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_view_name_idx" ON "saved_view" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "saved_view_start_idx" ON "saved_view" USING btree ("user_id") WHERE "saved_view"."is_start";