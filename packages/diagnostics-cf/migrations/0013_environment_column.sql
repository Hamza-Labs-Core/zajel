ALTER TABLE error_aggregates ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';

-- Drop old unique constraint and create new one including environment.
-- SQLite does not support DROP CONSTRAINT, so we create a new unique index
-- and drop the old one. The original UNIQUE constraint was created as part of
-- the CREATE TABLE, so it exists as an auto-generated index.
-- We create the new unique index first, then drop the old one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_error_agg_env
  ON error_aggregates(time_bucket, error_signature, app_version, platform, environment);

DROP INDEX IF EXISTS sqlite_autoindex_error_aggregates_1;
