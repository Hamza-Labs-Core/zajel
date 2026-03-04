-- Processing run history for monitoring and debugging
CREATE TABLE processing_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_start INTEGER NOT NULL,
  run_end INTEGER NOT NULL,
  errors_processed INTEGER NOT NULL,
  issues_created INTEGER NOT NULL,
  issues_updated INTEGER NOT NULL,
  ai_calls_made INTEGER NOT NULL,
  ai_tokens_used INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX idx_processing_runs_start ON processing_runs(run_start);
