ALTER TABLE error_aggregates ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';

-- Add a new unique index that includes the environment column.
-- The original UNIQUE(time_bucket, error_signature, app_version, platform) from
-- CREATE TABLE remains — it is enforced via a sqlite_autoindex that cannot be
-- dropped. The new index is a superset used by ON CONFLICT in aggregation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_error_agg_env
  ON error_aggregates(time_bucket, error_signature, app_version, platform, environment);
