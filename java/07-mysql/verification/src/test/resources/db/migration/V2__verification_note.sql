-- Verification fixture for the incremental path, not a published course migration.
ALTER TABLE product ADD COLUMN migration_note VARCHAR(30) NULL, ALGORITHM=INSTANT;
