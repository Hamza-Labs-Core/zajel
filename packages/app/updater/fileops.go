package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// bufferSize is the size of the buffer used for file copy operations (32 KB).
const bufferSize = 32 * 1024

// CreateBackup creates a recursive copy of installDir into backupDir.
// Any existing backupDir is removed first.
func CreateBackup(installDir, backupDir string) error {
	// Remove any existing backup directory.
	if _, err := os.Stat(backupDir); err == nil {
		log.Printf("Removing existing backup directory: %s\n", backupDir)
		if err := os.RemoveAll(backupDir); err != nil {
			return fmt.Errorf("removing existing backup dir: %w", err)
		}
	}

	// Create the backup directory.
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return fmt.Errorf("creating backup dir: %w", err)
	}

	// Recursively copy installDir to backupDir.
	if err := copyDir(installDir, backupDir); err != nil {
		// Clean up partial backup on failure.
		_ = os.RemoveAll(backupDir)
		return fmt.Errorf("copying install dir to backup: %w", err)
	}

	return nil
}

// ReplaceFiles replaces the contents of installDir with files from stagingDir.
// The installDir contents are deleted first (preserving the directory itself),
// then files from stagingDir are copied in. This ensures files that existed
// in the old version but not in the new version are removed.
func ReplaceFiles(stagingDir, installDir string) error {
	// Clear existing install directory contents before copying new files.
	if err := removeContents(installDir); err != nil {
		return fmt.Errorf("clearing install dir before replace: %w", err)
	}

	return copyDir(stagingDir, installDir)
}

// Rollback restores the installDir from backupDir.
// The current installDir contents are removed before restoring.
func Rollback(backupDir, installDir string) error {
	// Verify backup directory exists and is non-empty.
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return fmt.Errorf("reading backup dir: %w", err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("backup directory is empty: %s", backupDir)
	}

	// Remove current install directory contents.
	if err := removeContents(installDir); err != nil {
		return fmt.Errorf("clearing install dir for rollback: %w", err)
	}

	// Copy backup to install directory.
	if err := copyDir(backupDir, installDir); err != nil {
		return fmt.Errorf("restoring backup to install dir: %w", err)
	}

	return nil
}

// CleanupStaging removes the staging directory (best effort).
func CleanupStaging(stagingDir string) error {
	if err := os.RemoveAll(stagingDir); err != nil {
		return fmt.Errorf("removing staging dir: %w", err)
	}
	return nil
}

// WriteLockFile creates an update-in-progress.lock file containing
// the full manifest JSON, so recovery can proceed without the original manifest.
func WriteLockFile(path string, manifest *Manifest) error {
	lockData := struct {
		Phase    string    `json:"phase"`
		Manifest *Manifest `json:"manifest"`
	}{
		Phase:    "replacing",
		Manifest: manifest,
	}

	data, err := json.MarshalIndent(lockData, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling lock file data: %w", err)
	}

	// Ensure parent directory exists.
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("creating lock file parent dir: %w", err)
	}

	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("writing lock file: %w", err)
	}

	return nil
}

// RemoveLockFile deletes the lock file at the given path.
func RemoveLockFile(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("removing lock file: %w", err)
	}
	return nil
}

// copyDir recursively copies the contents of src into dst.
// dst must already exist. File permissions from the source are preserved.
// Symlinks that point outside the source tree are skipped with a warning.
func copyDir(src, dst string) error {
	return copyDirWithRoot(src, dst, src)
}

// copyDirWithRoot is the internal recursive implementation of copyDir.
// rootSrc is the top-level source directory, used to detect symlink escapes.
func copyDirWithRoot(src, dst, rootSrc string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return fmt.Errorf("reading directory %q: %w", src, err)
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			// Get source directory info for permissions.
			info, err := entry.Info()
			if err != nil {
				return fmt.Errorf("getting info for %q: %w", srcPath, err)
			}
			if err := os.MkdirAll(dstPath, info.Mode().Perm()); err != nil {
				return fmt.Errorf("creating directory %q: %w", dstPath, err)
			}
			if err := copyDirWithRoot(srcPath, dstPath, rootSrc); err != nil {
				return err
			}
		} else if entry.Type()&os.ModeSymlink != 0 {
			// Handle symlinks: read the link target and check for escapes.
			target, err := os.Readlink(srcPath)
			if err != nil {
				return fmt.Errorf("reading symlink %q: %w", srcPath, err)
			}

			// Resolve the symlink target to an absolute path.
			resolvedTarget := target
			if !filepath.IsAbs(resolvedTarget) {
				resolvedTarget = filepath.Join(filepath.Dir(srcPath), resolvedTarget)
			}
			resolvedTarget = filepath.Clean(resolvedTarget)

			// Check if the resolved target is within the source tree.
			absRoot, err := filepath.Abs(rootSrc)
			if err != nil {
				return fmt.Errorf("resolving root source path: %w", err)
			}
			if !isWithinDir(resolvedTarget, absRoot) {
				log.Printf("WARNING: skipping symlink %q -> %q: target escapes source tree %q\n",
					srcPath, target, rootSrc)
				continue
			}

			// Remove existing symlink/file at dst if present.
			_ = os.Remove(dstPath)
			if err := os.Symlink(target, dstPath); err != nil {
				return fmt.Errorf("creating symlink %q -> %q: %w", dstPath, target, err)
			}
		} else {
			// Regular file.
			if err := copyFile(srcPath, dstPath); err != nil {
				return err
			}
		}
	}

	return nil
}

// isWithinDir checks whether targetPath is within or equal to dirPath.
// Both paths should be absolute or both relative for correct comparison.
func isWithinDir(targetPath, dirPath string) bool {
	targetPath = filepath.Clean(targetPath)
	dirPath = filepath.Clean(dirPath)

	// Ensure dirPath ends with separator for prefix matching.
	if targetPath == dirPath {
		return true
	}
	return strings.HasPrefix(targetPath, dirPath+string(filepath.Separator))
}

// copyFile copies a single file from src to dst, preserving permissions.
func copyFile(src, dst string) error {
	return copyFilePlatform(src, dst)
}

// copyFileDefault is the standard (non-retry) file copy implementation.
// It is used on all platforms. Windows wraps this with retry logic.
// Uses a named return so the deferred dstFile.Close() error is captured.
func copyFileDefault(src, dst string) (retErr error) {
	srcFile, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("opening source file %q: %w", src, err)
	}
	defer srcFile.Close()

	srcInfo, err := srcFile.Stat()
	if err != nil {
		return fmt.Errorf("getting source file info %q: %w", src, err)
	}

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, srcInfo.Mode().Perm())
	if err != nil {
		return fmt.Errorf("creating destination file %q: %w", dst, err)
	}
	defer func() {
		if cerr := dstFile.Close(); cerr != nil && retErr == nil {
			retErr = fmt.Errorf("closing destination file %q: %w", dst, cerr)
		}
	}()

	buf := make([]byte, bufferSize)
	written, err := io.CopyBuffer(dstFile, srcFile, buf)
	if err != nil {
		return fmt.Errorf("copying %q to %q: %w", src, dst, err)
	}

	if written != srcInfo.Size() {
		return fmt.Errorf("size mismatch copying %q: wrote %d bytes, expected %d", src, written, srcInfo.Size())
	}

	return nil
}

// removeContents removes all files and subdirectories inside dir,
// but keeps the directory itself.
func removeContents(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("reading directory %q: %w", dir, err)
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("removing %q: %w", path, err)
		}
	}
	return nil
}
