CREATE TABLE "ai_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"model" text NOT NULL,
	"timeout_seconds" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"daily_token_budget" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_profile" ADD CONSTRAINT "ai_profile_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_profile" ADD CONSTRAINT "ai_profile_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_profile_project_task_unique" ON "ai_profile" USING btree ("project_id","task");