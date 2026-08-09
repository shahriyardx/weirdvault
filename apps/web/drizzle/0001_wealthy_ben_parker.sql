CREATE TABLE "recovery_blob" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"envelopes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "team_key" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "team_key_wrap" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"device_id" text NOT NULL,
	"member_user_id" text NOT NULL,
	"wrapped" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recovery_blob" ADD CONSTRAINT "recovery_blob_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_key" ADD CONSTRAINT "team_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_key" ADD CONSTRAINT "team_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_key_wrap" ADD CONSTRAINT "team_key_wrap_key_id_team_key_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."team_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_key_wrap" ADD CONSTRAINT "team_key_wrap_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_key_wrap" ADD CONSTRAINT "team_key_wrap_member_user_id_user_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_blob_user_idx" ON "recovery_blob" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "team_key_org_idx" ON "team_key" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "team_key_wrap_key_device_idx" ON "team_key_wrap" USING btree ("key_id","device_id");--> statement-breakpoint
CREATE INDEX "team_key_wrap_member_idx" ON "team_key_wrap" USING btree ("member_user_id");