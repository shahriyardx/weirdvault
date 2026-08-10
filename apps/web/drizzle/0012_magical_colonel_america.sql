ALTER TABLE "agent" ADD COLUMN "machine_ref" text;--> statement-breakpoint
CREATE INDEX "agent_machine_idx" ON "agent" USING btree ("user_id","machine_ref");