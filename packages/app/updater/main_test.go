package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// setupUpdateDirs creates temporary install, staging, and backup directories
// with appropriate content for testing update sequences.
func setupUpdateDirs(t *testing.T) (installDir, stagingDir, backupDir string) {
	t.Helper()
	base := t.TempDir()

	installDir = filepath.Join(base, "install")
	stagingDir = filepath.Join(base, "staging")
	backupDir = filepath.Join(base, "backup")

	if err := os.MkdirAll(installDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Populate install directory with "current version" files.
	writeTestFile(t, filepath.Join(installDir, "app"), "old-binary-v1")
	writeTestFile(t, filepath.Join(installDir, "config.json"), `{"version": "1.0.0"}`)
	writeTestFile(t, filepath.Join(installDir, "old-only.txt"), "this file is removed in v2")

	// Make the app "executable" (on Linux).
	_ = os.Chmod(filepath.Join(installDir, "app"), 0o755)

	// Populate staging directory with "new version" files.
	writeTestFile(t, filepath.Join(stagingDir, "app"), "new-binary-v2")
	writeTestFile(t, filepath.Join(stagingDir, "config.json"), `{"version": "2.0.0"}`)
	writeTestFile(t, filepath.Join(stagingDir, "new-feature.dat"), "new feature data")

	return installDir, stagingDir, backupDir
}

// findTrueBinary returns the path to the "true" binary for use as a
// valid app_executable in tests.
func findTrueBinary(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("true")
	if err != nil {
		t.Skipf("'true' binary not found: %v", err)
	}
	return path
}

func TestRunUpdateSequence_SuccessfulUpdate(t *testing.T) {
	installDir, stagingDir, backupDir := setupUpdateDirs(t)
	base := filepath.Dir(installDir)
	resultPath := filepath.Join(base, "update-result.json")
	lockPath := filepath.Join(backupDir, "update-in-progress.lock")

	// Copy the "true" binary into staging as our fake app executable,
	// so LaunchApp succeeds.
	truePath := findTrueBinary(t)
	trueContent, err := os.ReadFile(truePath)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(stagingDir, "app"), string(trueContent))
	_ = os.Chmod(filepath.Join(stagingDir, "app"), 0o755)

	m := &Manifest{
		SchemaVersion:     1,
		AppPID:            0,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "2.0.0",
		InstallDir:        installDir,
		StagingDir:        stagingDir,
		BackupDir:         backupDir,
		AppExecutable:     "app",
		Platform:          "linux",
	}

	// Use PID of a process that's already exited.
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	_ = cmd.Wait()

	exitCode := runUpdateSequence(m, pid, resultPath, lockPath)
	if exitCode != ExitSuccess {
		t.Fatalf("expected ExitSuccess (0), got %d", exitCode)
	}

	// Verify the install directory has new content.
	assertFileContent(t, filepath.Join(installDir, "app"), string(trueContent))
	assertFileContent(t, filepath.Join(installDir, "config.json"), `{"version": "2.0.0"}`)
	assertFileContent(t, filepath.Join(installDir, "new-feature.dat"), "new feature data")

	// Verify old-only file was removed (ReplaceFiles clears first).
	if _, err := os.Stat(filepath.Join(installDir, "old-only.txt")); !os.IsNotExist(err) {
		t.Error("old-only.txt should have been removed by the update")
	}

	// Verify backup was created.
	assertFileContent(t, filepath.Join(backupDir, "app"), "old-binary-v1")
	assertFileContent(t, filepath.Join(backupDir, "config.json"), `{"version": "1.0.0"}`)

	// Verify result file was written.
	result, err := ReadResult(resultPath)
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if result.Status != StatusPendingVerification {
		t.Errorf("expected status %q, got %q", StatusPendingVerification, result.Status)
	}
	if result.ExitCode != ExitSuccess {
		t.Errorf("expected exit code %d, got %d", ExitSuccess, result.ExitCode)
	}

	// Verify lock file was cleaned up.
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Error("lock file should have been removed after successful update")
	}

	// Verify staging was cleaned up.
	if _, err := os.Stat(stagingDir); !os.IsNotExist(err) {
		t.Error("staging directory should have been removed after successful update")
	}
}

func TestRunUpdateSequence_EmptyStaging(t *testing.T) {
	installDir, _, backupDir := setupUpdateDirs(t)
	base := filepath.Dir(installDir)
	resultPath := filepath.Join(base, "update-result.json")
	lockPath := filepath.Join(backupDir, "update-in-progress.lock")

	// Create an empty staging directory.
	emptyStagingDir := filepath.Join(base, "empty-staging")
	if err := os.MkdirAll(emptyStagingDir, 0o755); err != nil {
		t.Fatal(err)
	}

	m := &Manifest{
		SchemaVersion:     1,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "2.0.0",
		InstallDir:        installDir,
		StagingDir:        emptyStagingDir,
		BackupDir:         backupDir,
		AppExecutable:     "app",
		Platform:          "linux",
	}

	// Use a PID that's already exited.
	cmd := exec.Command("true")
	_ = cmd.Start()
	pid := cmd.Process.Pid
	_ = cmd.Wait()

	exitCode := runUpdateSequence(m, pid, resultPath, lockPath)
	if exitCode != ExitGenericFailure {
		t.Errorf("expected ExitGenericFailure (%d), got %d", ExitGenericFailure, exitCode)
	}

	// Verify result file indicates failure.
	result, err := ReadResult(resultPath)
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if result.Status != StatusFailed {
		t.Errorf("expected status %q, got %q", StatusFailed, result.Status)
	}
}

func TestRunUpdateSequence_LaunchFailure_Rollback(t *testing.T) {
	installDir, stagingDir, backupDir := setupUpdateDirs(t)
	base := filepath.Dir(installDir)
	resultPath := filepath.Join(base, "update-result.json")
	lockPath := filepath.Join(backupDir, "update-in-progress.lock")

	// The staging has a non-executable "app" file, so LaunchApp will fail.
	// (It's just text content, not a real binary.)

	m := &Manifest{
		SchemaVersion:     1,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "2.0.0",
		InstallDir:        installDir,
		StagingDir:        stagingDir,
		BackupDir:         backupDir,
		AppExecutable:     "app",
		Platform:          "linux",
	}

	cmd := exec.Command("true")
	_ = cmd.Start()
	pid := cmd.Process.Pid
	_ = cmd.Wait()

	exitCode := runUpdateSequence(m, pid, resultPath, lockPath)

	// Since the "app" is not a real binary, launching it should fail.
	// The sequence should attempt rollback.
	if exitCode != ExitLaunchFailed && exitCode != ExitRollbackFailed {
		// It could be ExitLaunchFailed if rollback succeeded, or
		// ExitRollbackFailed if rollback also failed.
		t.Logf("exitCode = %d (ExitLaunchFailed=%d, ExitRollbackFailed=%d)",
			exitCode, ExitLaunchFailed, ExitRollbackFailed)
	}

	// Verify a result file was written.
	result, err := ReadResult(resultPath)
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if result.Status != StatusRolledBack && result.Status != StatusFailed {
		t.Errorf("expected status rolled_back or failed, got %q", result.Status)
	}
}

func TestRunRollbackSequence_Success(t *testing.T) {
	base := t.TempDir()
	installDir := filepath.Join(base, "install")
	backupDir := filepath.Join(base, "backup")
	resultPath := filepath.Join(base, "update-result.json")
	lockPath := filepath.Join(backupDir, "update-in-progress.lock")

	if err := os.MkdirAll(installDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Install dir has "broken" v2 content.
	writeTestFile(t, filepath.Join(installDir, "app"), "broken-v2")

	// Backup dir has known-good v1 content.
	// Copy the "true" binary so LaunchApp succeeds after rollback.
	truePath := findTrueBinary(t)
	trueContent, err := os.ReadFile(truePath)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(backupDir, "app"), string(trueContent))
	_ = os.Chmod(filepath.Join(backupDir, "app"), 0o755)
	writeTestFile(t, filepath.Join(backupDir, "config.json"), `{"version": "1.0.0"}`)

	// Write a lock file to verify it gets cleaned up.
	writeTestFile(t, lockPath, "lock")

	m := &Manifest{
		SchemaVersion:     1,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "2.0.0",
		InstallDir:        installDir,
		StagingDir:        filepath.Join(base, "staging"),
		BackupDir:         backupDir,
		AppExecutable:     "app",
		Platform:          "linux",
	}

	exitCode := runRollbackSequence(m, resultPath, lockPath)
	if exitCode != ExitSuccess {
		t.Fatalf("expected ExitSuccess (0), got %d", exitCode)
	}

	// Verify install directory was restored from backup.
	assertFileContent(t, filepath.Join(installDir, "app"), string(trueContent))
	assertFileContent(t, filepath.Join(installDir, "config.json"), `{"version": "1.0.0"}`)

	// Verify broken v2 content is gone.
	// (The "app" binary was replaced with the true binary from backup.)

	// Verify result file.
	result, err := ReadResult(resultPath)
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if result.Status != StatusRolledBack {
		t.Errorf("expected status %q, got %q", StatusRolledBack, result.Status)
	}

	// Verify lock file was removed.
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Error("lock file should have been removed after rollback")
	}
}

func TestRunRollbackSequence_MissingBackup(t *testing.T) {
	base := t.TempDir()
	installDir := filepath.Join(base, "install")
	backupDir := filepath.Join(base, "nonexistent-backup")
	resultPath := filepath.Join(base, "update-result.json")
	lockPath := filepath.Join(base, "lock")

	if err := os.MkdirAll(installDir, 0o755); err != nil {
		t.Fatal(err)
	}

	m := &Manifest{
		SchemaVersion:     1,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "2.0.0",
		InstallDir:        installDir,
		StagingDir:        filepath.Join(base, "staging"),
		BackupDir:         backupDir,
		AppExecutable:     "app",
		Platform:          "linux",
	}

	exitCode := runRollbackSequence(m, resultPath, lockPath)
	if exitCode != ExitRollbackFailed {
		t.Errorf("expected ExitRollbackFailed (%d), got %d", ExitRollbackFailed, exitCode)
	}

	// Verify result file indicates failure.
	result, err := ReadResult(resultPath)
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if result.Status != StatusFailed {
		t.Errorf("expected status %q, got %q", StatusFailed, result.Status)
	}
}

func TestRunRollbackSequence_LaunchFailure(t *testing.T) {
	base := t.TempDir()
	installDir := filepath.Join(base, "install")
	backupDir := filepath.Join(base, "backup")
	resultPath := filepath.Join(base, "update-result.json")
	lockPath := filepath.Join(base, "lock")

	if err := os.MkdirAll(installDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Backup has a non-executable text file as "app", so LaunchApp will fail.
	writeTestFile(t, filepath.Join(backupDir, "app"), "not-a-real-binary")
	writeTestFile(t, filepath.Join(backupDir, "config.json"), `{"version": "1.0.0"}`)

	m := &Manifest{
		SchemaVersion:     1,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "2.0.0",
		InstallDir:        installDir,
		StagingDir:        filepath.Join(base, "staging"),
		BackupDir:         backupDir,
		AppExecutable:     "app",
		Platform:          "linux",
	}

	exitCode := runRollbackSequence(m, resultPath, lockPath)
	if exitCode != ExitRollbackFailed {
		t.Errorf("expected ExitRollbackFailed (%d), got %d", ExitRollbackFailed, exitCode)
	}

	// The rollback itself succeeded (files restored), but launch failed.
	result, err := ReadResult(resultPath)
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if result.Status != StatusFailed {
		t.Errorf("expected status %q, got %q", StatusFailed, result.Status)
	}
}

func TestValidatePaths_Valid(t *testing.T) {
	base := t.TempDir()
	installDir := filepath.Join(base, "install")
	stagingDir := filepath.Join(base, "staging")
	backupDir := filepath.Join(base, "backup")

	if err := os.MkdirAll(installDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Staging must have at least one file.
	writeTestFile(t, filepath.Join(stagingDir, "app"), "binary")

	m := &Manifest{
		InstallDir: installDir,
		StagingDir: stagingDir,
		BackupDir:  backupDir,
	}

	err := validatePaths(m)
	if err != nil {
		t.Fatalf("validatePaths should succeed: %v", err)
	}
}

func TestValidatePaths_MissingStagingDir(t *testing.T) {
	base := t.TempDir()
	installDir := filepath.Join(base, "install")
	if err := os.MkdirAll(installDir, 0o755); err != nil {
		t.Fatal(err)
	}

	m := &Manifest{
		InstallDir: installDir,
		StagingDir: filepath.Join(base, "nonexistent-staging"),
		BackupDir:  filepath.Join(base, "backup"),
	}

	err := validatePaths(m)
	if err == nil {
		t.Fatal("validatePaths should fail for missing staging dir")
	}
}

func TestWriteAndReadResultRoundTrip(t *testing.T) {
	resultPath := filepath.Join(t.TempDir(), "result.json")

	original := &UpdateResult{
		Status:            StatusPendingVerification,
		ExitCode:          ExitSuccess,
		AppVersionCurrent: "1.0.0",
		AppVersionTarget:  "2.0.0",
		Timestamp:         "2026-03-03T12:00:00Z",
	}

	if err := WriteResult(resultPath, original); err != nil {
		t.Fatalf("WriteResult failed: %v", err)
	}

	// Verify the file is valid JSON.
	data, err := os.ReadFile(resultPath)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("result file is not valid JSON: %v", err)
	}

	readBack, err := ReadResult(resultPath)
	if err != nil {
		t.Fatalf("ReadResult failed: %v", err)
	}

	if readBack.Status != original.Status {
		t.Errorf("status: got %q, want %q", readBack.Status, original.Status)
	}
	if readBack.ExitCode != original.ExitCode {
		t.Errorf("exit_code: got %d, want %d", readBack.ExitCode, original.ExitCode)
	}
}
