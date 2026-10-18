CREATE TABLE "operator_group_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_group_member" ADD CONSTRAINT "operator_group_member_group_id_operator_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."operator_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_group_member" ADD CONSTRAINT "operator_group_member_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_group" ADD CONSTRAINT "operator_group_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_group_member_idx" ON "operator_group_member" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "operator_group_member_user_idx" ON "operator_group_member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_group_name_idx" ON "operator_group" USING btree ("project_id","name");