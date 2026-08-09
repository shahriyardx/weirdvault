CREATE TABLE "agent" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"hostname" text,
	"os" text,
	"arch" text,
	"agent_version" text,
	"revoked_at" timestamp,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_enrollment" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"agent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_enrollment" ADD CONSTRAINT "agent_enrollment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_enrollment" ADD CONSTRAINT "agent_enrollment_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_user_idx" ON "agent" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_public_key_idx" ON "agent" USING btree ("public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_enrollment_token_idx" ON "agent_enrollment" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_enrollment_user_idx" ON "agent_enrollment" USING btree ("user_id");