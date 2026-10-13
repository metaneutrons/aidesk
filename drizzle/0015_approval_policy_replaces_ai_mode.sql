-- The approval policy replaces the separate AI mode: a project that let the AI
-- answer on its own now has the direct policy, and the AI mode setting is removed.
UPDATE "project" SET "settings" = ("settings" - 'aiMode') || '{"approvalPolicy": "direct"}'::jsonb WHERE "settings"->>'aiMode' = 'autonomous';--> statement-breakpoint
UPDATE "project" SET "settings" = "settings" - 'aiMode' WHERE "settings" ? 'aiMode';
