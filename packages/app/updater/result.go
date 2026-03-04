package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Status constants for update-result.json.
const (
	StatusPendingVerification = "pending_verification"
	StatusVerified            = "verified"
	StatusRolledBack          = "rolled_back"
	StatusFailed              = "failed"
	StatusRollbackFailed      = "rollback_failed"
)

// UpdateResult represents the content of update-result.json,
// which communicates the outcome of the update to the Flutter app.
type UpdateResult struct {
	Status            string `json:"status"`
	ExitCode          int    `json:"exit_code"`
	AppVersionCurrent string `json:"app_version_current"`
	AppVersionTarget  string `json:"app_version_target"`
	Timestamp         string `json:"timestamp"`
	ErrorMessage      string `json:"error_message,omitempty"`
}

// WriteResult writes the UpdateResult as JSON to the given path.
// It writes to a temporary file first and renames for atomicity.
func WriteResult(path string, result *UpdateResult) error {
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling update result: %w", err)
	}

	// Ensure parent directory exists.
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating result dir: %w", err)
	}

	// Write to a temp file in the same directory, then rename for atomicity.
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return fmt.Errorf("writing temp result file: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		// If rename fails (e.g., cross-device), fall back to direct write.
		_ = os.Remove(tmpPath)
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return fmt.Errorf("writing result file: %w", err)
		}
	}

	return nil
}

// ReadResult reads and parses an update-result.json file.
func ReadResult(path string) (*UpdateResult, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading result file: %w", err)
	}

	var result UpdateResult
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("parsing result JSON: %w", err)
	}

	return &result, nil
}
