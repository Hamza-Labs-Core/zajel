//go:build linux

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// isProcessRunningPlatform checks if a process is still running on Linux
// using kill(pid, 0). Returns true if the process exists.
func isProcessRunningPlatform(pid int) bool {
	err := syscall.Kill(pid, 0)
	// If err is nil, the process exists. If ESRCH, it does not.
	// EPERM means the process exists but we don't have permission (still running).
	return err == nil || err == syscall.EPERM
}

// terminateProcessPlatform sends SIGTERM to the process on Linux.
func terminateProcessPlatform(pid int) {
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		log.Printf("WARNING: failed to send SIGTERM to PID %d: %v\n", pid, err)
	}
}

// detachProcessPlatform is a no-op on Linux. Process detachment
// is handled naturally by the OS when the parent exits.
func detachProcessPlatform(cmd *exec.Cmd) {
	// No special setup needed on Linux.
}

// copyFilePlatform copies a file using the default implementation on Linux.
// No retry logic is needed since Linux does not lock files like Windows.
func copyFilePlatform(src, dst string) error {
	return copyFileDefault(src, dst)
}

// postCopyPlatform performs Linux-specific post-copy actions:
// sets executable permissions on the main binary and shared objects.
func postCopyPlatform(m *Manifest) {
	// Make the main executable runnable.
	execPath := filepath.Join(m.InstallDir, m.AppExecutable)
	makeExecutable(execPath)

	// Make shared objects in lib/ executable.
	libDir := filepath.Join(m.InstallDir, "lib")
	if info, err := os.Stat(libDir); err == nil && info.IsDir() {
		entries, err := os.ReadDir(libDir)
		if err != nil {
			log.Printf("WARNING: failed to read lib directory: %v\n", err)
			return
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				soPath := filepath.Join(libDir, entry.Name())
				makeExecutable(soPath)
			}
		}
	}
}

// getProcessName returns the name of the process with the given PID on Linux
// by reading /proc/<pid>/comm. Returns an empty string if the name cannot be
// determined (e.g., the process has already exited or /proc is not available).
func getProcessName(pid int) string {
	commPath := fmt.Sprintf("/proc/%d/comm", pid)
	data, err := os.ReadFile(commPath)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// makeExecutable sets the executable permission bit (+x) on the given file.
func makeExecutable(path string) {
	info, err := os.Stat(path)
	if err != nil {
		log.Printf("WARNING: cannot stat %s for chmod: %v\n", path, err)
		return
	}

	// Add executable bits for owner, group, and others (matching existing read bits).
	mode := info.Mode()
	newMode := mode | 0o111
	if newMode == mode {
		return // Already executable.
	}

	if err := os.Chmod(path, newMode); err != nil {
		log.Printf("WARNING: failed to chmod +x %s: %v\n", path, err)
	} else {
		log.Printf("Set executable permission on %s\n", path)
	}
}
