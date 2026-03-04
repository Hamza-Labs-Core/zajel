-- Issue tracking table for deduplication and GitHub issue management
CREATE TABLE issue_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  error_signature TEXT NOT NULL UNIQUE,
  github_issue_number INTEGER,
  github_issue_url TEXT,
  severity TEXT NOT NULL,
  component TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  ai_analysis TEXT,
  first_detected INTEGER NOT NULL,
  last_detected INTEGER NOT NULL,
  total_occurrences INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_issue_tracking_signature ON issue_tracking(error_signature);
CREATE INDEX idx_issue_tracking_status ON issue_tracking(status);
