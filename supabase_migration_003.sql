-- Migration 003: is_critical flag on device_registry + mobile device type
-- Run once against your Supabase project:
--   psql $DATABASE_URL -f supabase_migration_003.sql

-- Mark specific devices as critical so offline alerts fire regardless of type
ALTER TABLE device_registry
    ADD COLUMN IF NOT EXISTS is_critical BOOLEAN NOT NULL DEFAULT false;

-- Add 'mobile' device type (phones, tablets, wearables)
-- IF NOT EXISTS is supported in PostgreSQL 9.3+
ALTER TYPE device_type_enum ADD VALUE IF NOT EXISTS 'mobile';
