ALTER TABLE "ingress" DROP CONSTRAINT "ingress_external_key_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "ingress_project_key_idx" ON "ingress" USING btree ("project_id","external_key");