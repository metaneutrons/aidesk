CREATE TABLE "sso_provider_state" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_by" text NOT NULL,
	"verified_before" boolean DEFAULT false NOT NULL
);
