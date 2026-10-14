-- Reading files for agents is its own action. People who manage a project keep
-- every action, so they get it too; nobody else gains it.
UPDATE "membership" SET "actions" = "actions" || '["ticket.read_files"]'::jsonb WHERE "actions" ? 'project.manage' AND NOT ("actions" ? 'ticket.read_files');
