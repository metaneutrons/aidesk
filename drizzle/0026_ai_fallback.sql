ALTER TABLE "ai_profile" ADD COLUMN "fallback_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_profile" ADD COLUMN "fallback_model" text;--> statement-breakpoint
ALTER TABLE "ai_run" ADD COLUMN "fallback_of" text;--> statement-breakpoint
ALTER TABLE "ai_profile" ADD CONSTRAINT "ai_profile_fallback_connection_id_connection_id_fk" FOREIGN KEY ("fallback_connection_id") REFERENCES "public"."connection"("id") ON DELETE no action ON UPDATE no action;