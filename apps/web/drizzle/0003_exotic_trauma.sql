ALTER TABLE "recording_share" ADD COLUMN "ciphertext" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_share" ADD COLUMN "size_bytes" integer NOT NULL;