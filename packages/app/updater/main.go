package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
)

// Exit codes for the updater binary.
const (
	ExitSuccess         = 0
	ExitGenericFailure  = 1
	ExitManifestError   = 2
	ExitPIDTimeout      = 3
	ExitBackupFailed    = 4
	ExitCopyFailed      = 5
	ExitRollbackSuccess = 6
	ExitRollbackFailed  = 7
	ExitLaunchFailed    = 8
)

func main() {
	log.SetOutput(os.Stderr)
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	manifestPath := flag.String("manifest", "", "Path to the update manifest JSON file")
	pid := flag.Int("pid", 0, "PID of the app process to wait for")
	rollbackMode := flag.Bool("rollback", false, "Restore backup and relaunch previous version")
	flag.Parse()

	if *manifestPath == "" {
		log.Println("ERROR: --manifest flag is required")
		os.Exit(ExitManifestError)
	}

	manifest, err := ParseManifest(*manifestPath)
	if err != nil {
		log.Printf("ERROR: failed to parse manifest: %v\n", err)
		os.Exit(ExitManifestError)
	}

	// Determine result file path: parent of install_dir
	resultDir := filepath.Dir(manifest.InstallDir)
	resultPath := filepath.Join(resultDir, "update-result.json")
	lockPath := filepath.Join(manifest.BackupDir, "update-in-progress.lock")

	if *rollbackMode {
		exitCode := runRollbackSequence(manifest, resultPath, lockPath)
		os.Exit(exitCode)
	}

	// Use PID from CLI flag if provided, otherwise fall back to manifest.
	appPID := manifest.AppPID
	if *pid != 0 {
		appPID = *pid
	}

	exitCode := runUpdateSequence(manifest, appPID, resultPath, lockPath)
	os.Exit(exitCode)
}

// runUpdateSequence performs the full update: wait for PID, backup, replace, launch.
func runUpdateSequence(m *Manifest, appPID int, resultPath, lockPath string) int {
	log.Println("Starting update sequence")
	log.Printf("  Current version: %s\n", m.AppVersionCurrent)
	log.Printf("  Target version:  %s\n", m.AppVersionTarget)
	log.Printf("  Install dir:     %s\n", m.InstallDir)
	log.Printf("  Staging dir:     %s\n", m.StagingDir)
	log.Printf("  Backup dir:      %s\n", m.BackupDir)
	log.Printf("  App PID:         %d\n", appPID)

	// Validate paths.
	if err := validatePaths(m); err != nil {
		log.Printf("ERROR: path validation failed: %v\n", err)
		writeFailureResult(resultPath, m, ExitGenericFailure, err.Error())
		return ExitGenericFailure
	}

	// Wait for app PID to exit.
	log.Printf("Waiting for PID %d to exit...\n", appPID)
	if err := WaitForExit(appPID, 30*time.Second); err != nil {
		log.Printf("ERROR: PID wait failed: %v\n", err)
		writeFailureResult(resultPath, m, ExitPIDTimeout, err.Error())
		return ExitPIDTimeout
	}
	log.Println("App process exited")

	// Write lock file.
	if err := WriteLockFile(lockPath, m); err != nil {
		log.Printf("WARNING: failed to write lock file: %v\n", err)
		// Non-fatal; continue with update.
	}

	// Create backup.
	log.Println("Creating backup...")
	if err := CreateBackup(m.InstallDir, m.BackupDir); err != nil {
		log.Printf("ERROR: backup creation failed: %v\n", err)
		_ = RemoveLockFile(lockPath)
		writeFailureResult(resultPath, m, ExitBackupFailed, err.Error())
		return ExitBackupFailed
	}
	log.Println("Backup created successfully")

	// Replace files.
	log.Println("Replacing files...")
	if err := ReplaceFiles(m.StagingDir, m.InstallDir); err != nil {
		log.Printf("ERROR: file replacement failed: %v\n", err)
		log.Println("Attempting rollback...")
		if rbErr := Rollback(m.BackupDir, m.InstallDir); rbErr != nil {
			log.Printf("ERROR: rollback failed: %v\n", rbErr)
			_ = RemoveLockFile(lockPath)
			writeFailureResult(resultPath, m, ExitRollbackFailed,
				fmt.Sprintf("copy failed: %v; rollback failed: %v", err, rbErr))
			return ExitRollbackFailed
		}
		log.Println("Rollback succeeded")
		_ = RemoveLockFile(lockPath)
		writeRollbackResult(resultPath, m, ExitRollbackSuccess,
			fmt.Sprintf("copy failed: %v; rolled back successfully", err))
		return ExitRollbackSuccess
	}
	log.Println("Files replaced successfully")

	// Platform-specific post-copy actions.
	postCopyPlatform(m)

	// Remove lock file.
	_ = RemoveLockFile(lockPath)

	// Launch new app.
	execPath := filepath.Join(m.InstallDir, m.AppExecutable)
	log.Printf("Launching new app: %s\n", execPath)
	if err := LaunchApp(execPath); err != nil {
		log.Printf("ERROR: failed to launch new app: %v\n", err)
		log.Println("Attempting rollback...")
		if rbErr := Rollback(m.BackupDir, m.InstallDir); rbErr != nil {
			log.Printf("ERROR: rollback after launch failure also failed: %v\n", rbErr)
			writeFailureResult(resultPath, m, ExitRollbackFailed,
				fmt.Sprintf("launch failed: %v; rollback failed: %v", err, rbErr))
			return ExitRollbackFailed
		}
		// Try to launch the old app after rollback.
		_ = LaunchApp(execPath)
		writeRollbackResult(resultPath, m, ExitLaunchFailed,
			fmt.Sprintf("launch failed: %v; rolled back successfully", err))
		return ExitLaunchFailed
	}
	log.Println("New app launched successfully")

	// Write success result.
	result := &UpdateResult{
		Status:            StatusPendingVerification,
		ExitCode:          ExitSuccess,
		AppVersionCurrent: m.AppVersionCurrent,
		AppVersionTarget:  m.AppVersionTarget,
		Timestamp:         time.Now().UTC().Format(time.RFC3339),
	}
	if err := WriteResult(resultPath, result); err != nil {
		log.Printf("WARNING: failed to write result file: %v\n", err)
	}

	// Clean up staging directory (best effort).
	if err := CleanupStaging(m.StagingDir); err != nil {
		log.Printf("WARNING: failed to clean up staging dir: %v\n", err)
	}

	log.Println("Update completed successfully")
	return ExitSuccess
}

// runRollbackSequence restores the backup and relaunches the old app.
func runRollbackSequence(m *Manifest, resultPath, lockPath string) int {
	log.Println("Starting rollback sequence")
	log.Printf("  Install dir: %s\n", m.InstallDir)
	log.Printf("  Backup dir:  %s\n", m.BackupDir)

	// Verify backup directory exists.
	info, err := os.Stat(m.BackupDir)
	if err != nil || !info.IsDir() {
		errMsg := "backup directory does not exist or is not a directory"
		if err != nil {
			errMsg = fmt.Sprintf("backup directory not accessible: %v", err)
		}
		log.Printf("ERROR: %s\n", errMsg)
		writeFailureResult(resultPath, m, ExitRollbackFailed, errMsg)
		return ExitRollbackFailed
	}

	// Restore from backup.
	log.Println("Restoring from backup...")
	if err := Rollback(m.BackupDir, m.InstallDir); err != nil {
		log.Printf("ERROR: rollback failed: %v\n", err)
		writeFailureResult(resultPath, m, ExitRollbackFailed,
			fmt.Sprintf("rollback failed: %v", err))
		return ExitRollbackFailed
	}
	log.Println("Rollback completed successfully")

	// Remove lock file if present.
	_ = RemoveLockFile(lockPath)

	// Write rollback result.
	result := &UpdateResult{
		Status:            StatusRolledBack,
		ExitCode:          ExitRollbackSuccess,
		AppVersionCurrent: m.AppVersionCurrent,
		AppVersionTarget:  m.AppVersionTarget,
		Timestamp:         time.Now().UTC().Format(time.RFC3339),
		ErrorMessage:      "Rolled back to previous version due to startup failures",
	}
	if err := WriteResult(resultPath, result); err != nil {
		log.Printf("WARNING: failed to write result file: %v\n", err)
	}

	// Launch the restored app.
	execPath := filepath.Join(m.InstallDir, m.AppExecutable)
	log.Printf("Launching restored app: %s\n", execPath)
	if err := LaunchApp(execPath); err != nil {
		log.Printf("ERROR: failed to launch restored app: %v\n", err)
		writeFailureResult(resultPath, m, ExitRollbackFailed,
			fmt.Sprintf("rollback succeeded but failed to launch old app: %v", err))
		return ExitRollbackFailed
	}

	log.Println("Rollback sequence completed successfully")
	return ExitSuccess
}

// validatePaths checks that the staging and install directories exist
// and the backup directory's parent is writable.
func validatePaths(m *Manifest) error {
	// Check staging directory exists and has files.
	entries, err := os.ReadDir(m.StagingDir)
	if err != nil {
		return fmt.Errorf("staging directory not readable: %w", err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("staging directory is empty: %s", m.StagingDir)
	}

	// Check install directory exists.
	info, err := os.Stat(m.InstallDir)
	if err != nil {
		return fmt.Errorf("install directory not accessible: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("install path is not a directory: %s", m.InstallDir)
	}

	// Check backup directory parent is writable.
	backupParent := filepath.Dir(m.BackupDir)
	if err := os.MkdirAll(backupParent, 0o755); err != nil {
		return fmt.Errorf("backup directory parent not writable: %w", err)
	}

	return nil
}

// writeFailureResult writes an update-result.json with a failed status.
func writeFailureResult(path string, m *Manifest, exitCode int, errMsg string) {
	result := &UpdateResult{
		Status:            StatusFailed,
		ExitCode:          exitCode,
		AppVersionCurrent: m.AppVersionCurrent,
		AppVersionTarget:  m.AppVersionTarget,
		Timestamp:         time.Now().UTC().Format(time.RFC3339),
		ErrorMessage:      errMsg,
	}
	if err := WriteResult(path, result); err != nil {
		log.Printf("WARNING: failed to write failure result: %v\n", err)
	}
}

// writeRollbackResult writes an update-result.json with a rolled_back status.
func writeRollbackResult(path string, m *Manifest, exitCode int, errMsg string) {
	result := &UpdateResult{
		Status:            StatusRolledBack,
		ExitCode:          exitCode,
		AppVersionCurrent: m.AppVersionCurrent,
		AppVersionTarget:  m.AppVersionTarget,
		Timestamp:         time.Now().UTC().Format(time.RFC3339),
		ErrorMessage:      errMsg,
	}
	if err := WriteResult(path, result); err != nil {
		log.Printf("WARNING: failed to write rollback result: %v\n", err)
	}
}
