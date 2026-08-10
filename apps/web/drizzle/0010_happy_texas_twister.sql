ALTER TABLE "recording" ALTER COLUMN "ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_share" ALTER COLUMN "ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recording" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "recording_share" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_one_body_idx" CHECK (not ("recording"."ciphertext" is not null and "recording"."storage_key" is not null));--> statement-breakpoint
ALTER TABLE "recording_share" ADD CONSTRAINT "recording_share_one_body_idx" CHECK (not ("recording_share"."ciphertext" is not null and "recording_share"."storage_key" is not null));