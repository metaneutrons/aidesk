CREATE TABLE "sso_provider_provisioning" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled_by" text NOT NULL
);
