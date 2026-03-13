-- Add retry_count column to issue_tracking for GitHub retry queue
ALTER TABLE issue_tracking ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
