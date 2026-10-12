CREATE TABLE "sync_cursor" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"mailbox" text NOT NULL,
	"uid_validity" text NOT NULL,
	"last_uid" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_cursor" ADD CONSTRAINT "sync_cursor_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;