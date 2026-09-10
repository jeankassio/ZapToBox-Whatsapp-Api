-- Existing name values mixed address-book and profile names. Retain them as
-- legacy display fallbacks until a contact event supplies authoritative names.
ALTER TABLE "Contact" ADD COLUMN "nameMetadata" JSONB;
