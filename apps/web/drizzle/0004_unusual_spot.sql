-- Hand-edited after `db:generate`, and it has to stay that way if it is
-- regenerated. Drizzle emits a bare `SET DATA TYPE timestamp with time zone`,
-- which converts the existing rows by reading their wall clock in the server's
-- TimeZone — the exact offset this migration exists to remove. Every value in
-- these columns was written by drizzle as UTC wall clock, so the conversion is
-- pinned with `AT TIME ZONE 'UTC'` rather than left to the session.
--
-- The default is dropped and re-set around the type change so the old
-- `now()::timestamp` expression is not carried across and re-cast.
ALTER TABLE "recording_share" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "recording_share" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "recording_share" ALTER COLUMN "revoked_at" SET DATA TYPE timestamp with time zone USING "revoked_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "recording_share" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "recording_share" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
CREATE INDEX "recording_share_user_idx" ON "recording_share" USING btree ("user_id");
