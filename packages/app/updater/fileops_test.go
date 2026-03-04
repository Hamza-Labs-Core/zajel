package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// setupTestDir creates a temporary directory with a nested file structure
// for testing file operations.
func setupTestDir(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("failed to create test dir: %v", err)
	}
	return dir
}

// populateDir creates a set of files and subdirectories in the given directory.
func populateDir(t *testing.T, dir string) {
	t.Helper()

	// Create files at the root.
	writeTestFile(t, filepath.Join(dir, "app.exe"), "binary content")
	writeTestFile(t, filepath.Join(dir, "config.json"), `{"key": "value"}`)

	// Create a subdirectory with files.
	subDir := filepath.Join(dir, "data")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatalf("failed to create subdir: %v", err)
	}
	writeTestFile(t, filepath.Join(subDir, "assets.dat"), "asset data")
	writeTestFile(t, filepath.Join(subDir, "strings.json"), `{"hello": "world"}`)

	// Create a nested subdirectory.
	nestedDir := filepath.Join(subDir, "nested")
	if err := os.MkdirAll(nestedDir, 0o755); err != nil {
		t.Fatalf("failed to create nested dir: %v", err)
	}
	writeTestFile(t, filepath.Join(nestedDir, "deep.txt"), "deep content")
}

// writeTestFile writes content to a file, creating parent directories as needed.
func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("failed to create parent dir for %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write test file %s: %v", path, err)
	}
}

// readTestFile reads the content of a file as a string.
func readTestFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read test file %s: %v", path, err)
	}
	return string(data)
}

func TestCreateBackup(t *testing.T) {
	installDir := setupTestDir(t, "install")
	backupDir := filepath.Join(t.TempDir(), "backup")

	populateDir(t, installDir)

	err := CreateBackup(installDir, backupDir)
	if err != nil {
		t.Fatalf("CreateBackup failed: %v", err)
	}

	// Verify all files were copied with correct content.
	assertFileContent(t, filepath.Join(backupDir, "app.exe"), "binary content")
	assertFileContent(t, filepath.Join(backupDir, "config.json"), `{"key": "value"}`)
	assertFileContent(t, filepath.Join(backupDir, "data", "assets.dat"), "asset data")
	assertFileContent(t, filepath.Join(backupDir, "data", "strings.json"), `{"hello": "world"}`)
	assertFileContent(t, filepath.Join(backupDir, "data", "nested", "deep.txt"), "deep content")
}

func TestCreateBackup_OverwritesExisting(t *testing.T) {
	installDir := setupTestDir(t, "install")
	backupDir := filepath.Join(t.TempDir(), "backup")

	// Create an initial backup with old content.
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("failed to create backup dir: %v", err)
	}
	writeTestFile(t, filepath.Join(backupDir, "old-file.txt"), "old content")

	// Populate install directory with new content.
	populateDir(t, installDir)

	err := CreateBackup(installDir, backupDir)
	if err != nil {
		t.Fatalf("CreateBackup failed: %v", err)
	}

	// Verify old file is gone.
	if _, err := os.Stat(filepath.Join(backupDir, "old-file.txt")); !os.IsNotExist(err) {
		t.Error("old backup file should have been removed")
	}

	// Verify new content is present.
	assertFileContent(t, filepath.Join(backupDir, "app.exe"), "binary content")
}

func TestReplaceFiles(t *testing.T) {
	installDir := setupTestDir(t, "install")
	stagingDir := setupTestDir(t, "staging")

	// Populate install directory with original content.
	writeTestFile(t, filepath.Join(installDir, "app.exe"), "old binary")
	writeTestFile(t, filepath.Join(installDir, "config.json"), `{"version": "1.0"}`)
	writeTestFile(t, filepath.Join(installDir, "old-only.txt"), "this should be removed")

	// Populate staging directory with new content.
	writeTestFile(t, filepath.Join(stagingDir, "app.exe"), "new binary")
	writeTestFile(t, filepath.Join(stagingDir, "config.json"), `{"version": "2.0"}`)
	writeTestFile(t, filepath.Join(stagingDir, "new-feature.dat"), "new feature data")

	err := ReplaceFiles(stagingDir, installDir)
	if err != nil {
		t.Fatalf("ReplaceFiles failed: %v", err)
	}

	// Verify files were replaced with new content.
	assertFileContent(t, filepath.Join(installDir, "app.exe"), "new binary")
	assertFileContent(t, filepath.Join(installDir, "config.json"), `{"version": "2.0"}`)
	assertFileContent(t, filepath.Join(installDir, "new-feature.dat"), "new feature data")

	// Verify old-only file that wasn't in staging is now gone (Issue 6).
	if _, err := os.Stat(filepath.Join(installDir, "old-only.txt")); !os.IsNotExist(err) {
		t.Error("old-only.txt should have been removed by ReplaceFiles (not in staging)")
	}
}

func TestReplaceFiles_RemovesStaleFiles(t *testing.T) {
	installDir := setupTestDir(t, "install")
	stagingDir := setupTestDir(t, "staging")

	// Install directory has many files and subdirectories.
	writeTestFile(t, filepath.Join(installDir, "app.exe"), "old binary")
	writeTestFile(t, filepath.Join(installDir, "old-plugin.dll"), "old plugin")
	if err := os.MkdirAll(filepath.Join(installDir, "old-dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(installDir, "old-dir", "stale.dat"), "stale data")

	// Staging only has the new binary.
	writeTestFile(t, filepath.Join(stagingDir, "app.exe"), "new binary")

	err := ReplaceFiles(stagingDir, installDir)
	if err != nil {
		t.Fatalf("ReplaceFiles failed: %v", err)
	}

	// Only the new binary should exist.
	assertFileContent(t, filepath.Join(installDir, "app.exe"), "new binary")

	// Old files and directories should be gone.
	if _, err := os.Stat(filepath.Join(installDir, "old-plugin.dll")); !os.IsNotExist(err) {
		t.Error("old-plugin.dll should have been removed")
	}
	if _, err := os.Stat(filepath.Join(installDir, "old-dir")); !os.IsNotExist(err) {
		t.Error("old-dir should have been removed")
	}
}

func TestReplaceFiles_PreservesInstallDirItself(t *testing.T) {
	installDir := setupTestDir(t, "install")
	stagingDir := setupTestDir(t, "staging")

	writeTestFile(t, filepath.Join(installDir, "old.txt"), "old")
	writeTestFile(t, filepath.Join(stagingDir, "new.txt"), "new")

	err := ReplaceFiles(stagingDir, installDir)
	if err != nil {
		t.Fatalf("ReplaceFiles failed: %v", err)
	}

	// Install directory itself should still exist.
	info, err := os.Stat(installDir)
	if err != nil {
		t.Fatalf("install dir should still exist: %v", err)
	}
	if !info.IsDir() {
		t.Error("install dir should still be a directory")
	}

	assertFileContent(t, filepath.Join(installDir, "new.txt"), "new")
}

func TestRollback(t *testing.T) {
	installDir := setupTestDir(t, "install")
	backupDir := setupTestDir(t, "backup")

	// Populate backup directory with original content.
	writeTestFile(t, filepath.Join(backupDir, "app.exe"), "original binary")
	writeTestFile(t, filepath.Join(backupDir, "config.json"), `{"version": "1.0"}`)
	subDir := filepath.Join(backupDir, "data")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatalf("failed to create subdir: %v", err)
	}
	writeTestFile(t, filepath.Join(subDir, "assets.dat"), "original assets")

	// Damage the install directory with different content.
	writeTestFile(t, filepath.Join(installDir, "app.exe"), "corrupted binary")
	writeTestFile(t, filepath.Join(installDir, "config.json"), `{"version": "broken"}`)
	writeTestFile(t, filepath.Join(installDir, "extra-file.txt"), "should be removed")

	err := Rollback(backupDir, installDir)
	if err != nil {
		t.Fatalf("Rollback failed: %v", err)
	}

	// Verify install directory was restored from backup.
	assertFileContent(t, filepath.Join(installDir, "app.exe"), "original binary")
	assertFileContent(t, filepath.Join(installDir, "config.json"), `{"version": "1.0"}`)
	assertFileContent(t, filepath.Join(installDir, "data", "assets.dat"), "original assets")

	// Verify extra file from damaged install was removed.
	if _, err := os.Stat(filepath.Join(installDir, "extra-file.txt")); !os.IsNotExist(err) {
		t.Error("extra file from damaged install should have been removed during rollback")
	}
}

func TestRollback_EmptyBackup(t *testing.T) {
	installDir := setupTestDir(t, "install")
	backupDir := setupTestDir(t, "backup")

	// Leave backup directory empty.
	writeTestFile(t, filepath.Join(installDir, "app.exe"), "some content")

	err := Rollback(backupDir, installDir)
	if err == nil {
		t.Fatal("Rollback should fail with empty backup directory")
	}
}

func TestRollback_MissingBackup(t *testing.T) {
	installDir := setupTestDir(t, "install")
	backupDir := filepath.Join(t.TempDir(), "nonexistent-backup")

	writeTestFile(t, filepath.Join(installDir, "app.exe"), "some content")

	err := Rollback(backupDir, installDir)
	if err == nil {
		t.Fatal("Rollback should fail with missing backup directory")
	}
}

func TestLockFile(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "update-in-progress.lock")

	manifest := &Manifest{
		SchemaVersion:     1,
		AppPID:            12345,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "1.2.0",
		InstallDir:        "/opt/zajel",
		StagingDir:        "/tmp/zajel-staging",
		BackupDir:         "/tmp/zajel-backup",
		AppExecutable:     "zajel",
		Platform:          "linux",
		ChecksumSHA256:    "abc123",
		Timestamp:         "2026-03-03T12:00:00Z",
	}

	// Write lock file.
	err := WriteLockFile(lockPath, manifest)
	if err != nil {
		t.Fatalf("WriteLockFile failed: %v", err)
	}

	// Verify lock file exists and contains valid JSON.
	data, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("failed to read lock file: %v", err)
	}

	var lockData struct {
		Phase    string   `json:"phase"`
		Manifest Manifest `json:"manifest"`
	}
	if err := json.Unmarshal(data, &lockData); err != nil {
		t.Fatalf("failed to parse lock file JSON: %v", err)
	}

	if lockData.Phase != "replacing" {
		t.Errorf("expected phase 'replacing', got %q", lockData.Phase)
	}
	if lockData.Manifest.AppVersionTarget != "1.2.0" {
		t.Errorf("expected target version '1.2.0', got %q", lockData.Manifest.AppVersionTarget)
	}
	if lockData.Manifest.InstallDir != "/opt/zajel" {
		t.Errorf("expected install dir '/opt/zajel', got %q", lockData.Manifest.InstallDir)
	}

	// Remove lock file.
	err = RemoveLockFile(lockPath)
	if err != nil {
		t.Fatalf("RemoveLockFile failed: %v", err)
	}

	// Verify lock file is gone.
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Error("lock file should have been removed")
	}
}

func TestRemoveLockFile_NonExistent(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "nonexistent.lock")

	// Should not error when removing a file that does not exist.
	err := RemoveLockFile(lockPath)
	if err != nil {
		t.Fatalf("RemoveLockFile should not fail for non-existent file: %v", err)
	}
}

func TestWriteResult(t *testing.T) {
	resultPath := filepath.Join(t.TempDir(), "update-result.json")

	result := &UpdateResult{
		Status:            StatusPendingVerification,
		ExitCode:          0,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "1.2.0",
		Timestamp:         "2026-03-03T12:00:00Z",
	}

	err := WriteResult(resultPath, result)
	if err != nil {
		t.Fatalf("WriteResult failed: %v", err)
	}

	// Read it back and verify.
	readBack, err := ReadResult(resultPath)
	if err != nil {
		t.Fatalf("ReadResult failed: %v", err)
	}

	if readBack.Status != StatusPendingVerification {
		t.Errorf("expected status %q, got %q", StatusPendingVerification, readBack.Status)
	}
	if readBack.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", readBack.ExitCode)
	}
	if readBack.AppVersionCurrent != "1.0.0" {
		t.Errorf("expected current version '1.0.0', got %q", readBack.AppVersionCurrent)
	}
	if readBack.AppVersionTarget != "1.2.0" {
		t.Errorf("expected target version '1.2.0', got %q", readBack.AppVersionTarget)
	}
	if readBack.Timestamp != "2026-03-03T12:00:00Z" {
		t.Errorf("expected timestamp '2026-03-03T12:00:00Z', got %q", readBack.Timestamp)
	}
	if readBack.ErrorMessage != "" {
		t.Errorf("expected empty error message, got %q", readBack.ErrorMessage)
	}
}

func TestWriteResult_WithError(t *testing.T) {
	resultPath := filepath.Join(t.TempDir(), "update-result.json")

	result := &UpdateResult{
		Status:            StatusFailed,
		ExitCode:          5,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "1.2.0",
		Timestamp:         "2026-03-03T12:05:00Z",
		ErrorMessage:      "Failed to copy flutter_windows.dll: access denied",
	}

	err := WriteResult(resultPath, result)
	if err != nil {
		t.Fatalf("WriteResult failed: %v", err)
	}

	readBack, err := ReadResult(resultPath)
	if err != nil {
		t.Fatalf("ReadResult failed: %v", err)
	}

	if readBack.Status != StatusFailed {
		t.Errorf("expected status %q, got %q", StatusFailed, readBack.Status)
	}
	if readBack.ExitCode != 5 {
		t.Errorf("expected exit code 5, got %d", readBack.ExitCode)
	}
	if readBack.ErrorMessage != "Failed to copy flutter_windows.dll: access denied" {
		t.Errorf("unexpected error message: %q", readBack.ErrorMessage)
	}
}

func TestWriteResult_RollbackStatus(t *testing.T) {
	resultPath := filepath.Join(t.TempDir(), "update-result.json")

	result := &UpdateResult{
		Status:            StatusRolledBack,
		ExitCode:          6,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "1.2.0",
		Timestamp:         "2026-03-03T12:05:00Z",
		ErrorMessage:      "copy failed; rolled back successfully",
	}

	err := WriteResult(resultPath, result)
	if err != nil {
		t.Fatalf("WriteResult failed: %v", err)
	}

	readBack, err := ReadResult(resultPath)
	if err != nil {
		t.Fatalf("ReadResult failed: %v", err)
	}

	if readBack.Status != StatusRolledBack {
		t.Errorf("expected status %q, got %q", StatusRolledBack, readBack.Status)
	}
	if readBack.ExitCode != 6 {
		t.Errorf("expected exit code 6, got %d", readBack.ExitCode)
	}
}

func TestCleanupStaging(t *testing.T) {
	stagingDir := setupTestDir(t, "staging")
	writeTestFile(t, filepath.Join(stagingDir, "file.txt"), "content")

	err := CleanupStaging(stagingDir)
	if err != nil {
		t.Fatalf("CleanupStaging failed: %v", err)
	}

	if _, err := os.Stat(stagingDir); !os.IsNotExist(err) {
		t.Error("staging directory should have been removed")
	}
}

func TestCopyDir_SymlinkWithinTree(t *testing.T) {
	srcDir := setupTestDir(t, "src")
	dstDir := setupTestDir(t, "dst")

	// Create a file and a symlink pointing to it within the tree.
	writeTestFile(t, filepath.Join(srcDir, "real.txt"), "real content")
	if err := os.Symlink("real.txt", filepath.Join(srcDir, "link.txt")); err != nil {
		t.Skipf("symlinks not supported: %v", err)
	}

	err := copyDir(srcDir, dstDir)
	if err != nil {
		t.Fatalf("copyDir failed: %v", err)
	}

	// The symlink should have been copied.
	target, err := os.Readlink(filepath.Join(dstDir, "link.txt"))
	if err != nil {
		t.Fatalf("expected symlink in dst: %v", err)
	}
	if target != "real.txt" {
		t.Errorf("expected symlink target 'real.txt', got %q", target)
	}
}

func TestCopyDir_SymlinkEscapesTree(t *testing.T) {
	tmpDir := t.TempDir()
	srcDir := filepath.Join(tmpDir, "src")
	dstDir := filepath.Join(tmpDir, "dst")
	outsideFile := filepath.Join(tmpDir, "outside-secret.txt")

	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Create a file outside the source tree.
	writeTestFile(t, outsideFile, "secret data")
	writeTestFile(t, filepath.Join(srcDir, "safe.txt"), "safe content")

	// Create a symlink that escapes the source tree.
	if err := os.Symlink(outsideFile, filepath.Join(srcDir, "escape-link")); err != nil {
		t.Skipf("symlinks not supported: %v", err)
	}

	err := copyDir(srcDir, dstDir)
	if err != nil {
		t.Fatalf("copyDir should not fail, but skip the escaping symlink: %v", err)
	}

	// The safe file should be copied.
	assertFileContent(t, filepath.Join(dstDir, "safe.txt"), "safe content")

	// The escaping symlink should NOT have been copied.
	if _, err := os.Lstat(filepath.Join(dstDir, "escape-link")); !os.IsNotExist(err) {
		t.Error("escaping symlink should have been skipped")
	}
}

func TestCopyDir_SymlinkEscapesViaRelativePath(t *testing.T) {
	tmpDir := t.TempDir()
	srcDir := filepath.Join(tmpDir, "src")
	dstDir := filepath.Join(tmpDir, "dst")
	outsideFile := filepath.Join(tmpDir, "secret.txt")

	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Create a file outside the source tree.
	writeTestFile(t, outsideFile, "secret")

	// Create a symlink using "../" to escape.
	if err := os.Symlink("../secret.txt", filepath.Join(srcDir, "relative-escape")); err != nil {
		t.Skipf("symlinks not supported: %v", err)
	}

	err := copyDir(srcDir, dstDir)
	if err != nil {
		t.Fatalf("copyDir should not fail: %v", err)
	}

	// The escaping symlink should NOT have been copied.
	if _, err := os.Lstat(filepath.Join(dstDir, "relative-escape")); !os.IsNotExist(err) {
		t.Error("relative escaping symlink should have been skipped")
	}
}

// assertFileContent verifies that the file at the given path exists and
// contains the expected content.
func assertFileContent(t *testing.T, path, expected string) {
	t.Helper()
	actual := readTestFile(t, path)
	if actual != expected {
		t.Errorf("file %s: expected content %q, got %q", path, expected, actual)
	}
}
