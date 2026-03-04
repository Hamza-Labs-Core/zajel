//go:build darwin

package main

import (
	"fmt"
	"log"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// isProcessRunningPlatform checks if a process is still running on macOS
// using kill(pid, 0). Returns true if the process exists.
func isProcessRunningPlatform(pid int) bool {
	err := syscall.Kill(pid, 0)
	// If err is nil, the process exists. If ESRCH, it does not.
	// EPERM means the process exists but we don't have permission (still running).
	return err == nil || err == syscall.EPERM
}

// terminateProcessPlatform sends SIGTERM to the process on macOS.
func terminateProcessPlatform(pid int) {
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		log.Printf("WARNING: failed to send SIGTERM to PID %d: %v\n", pid, err)
	}
}

// detachProcessPlatform is a no-op on macOS. Process detachment
// is handled naturally by the OS when the parent exits.
func detachProcessPlatform(cmd *exec.Cmd) {
	// No special setup needed on macOS.
}

// copyFilePlatform copies a file using the default implementation on macOS.
// No retry logic is needed since macOS does not lock files like Windows.
func copyFilePlatform(src, dst string) error {
	return copyFileDefault(src, dst)
}

// postCopyPlatform performs macOS-specific post-copy actions:
// clears the Gatekeeper quarantine attribute from the app bundle.
func postCopyPlatform(m *Manifest) {
	clearQuarantine(m.InstallDir)
}

// getProcessName returns the name of the process with the given PID on macOS.
// Uses ps to query the process name. Returns an empty string if the name cannot
// be determined. Note: on macOS, /proc is not available, so we use ps(1).
func getProcessName(pid int) string {
	out, err := exec.Command("ps", "-p", fmt.Sprintf("%d", pid), "-o", "comm=").Output()
	if err != nil {
		return ""
	}
	name := strings.TrimSpace(string(out))
	// ps returns the full path; extract just the base name.
	if name != "" {
		name = filepath.Base(name)
	}
	return name
}

// clearQuarantine removes the com.apple.quarantine extended attribute
// from all files in the given path. This prevents the "app downloaded
// from the internet" warning dialog from appearing.
func clearQuarantine(path string) {
	// Check if there is a .app bundle in the install directory.
	matches, err := filepath.Glob(filepath.Join(path, "*.app"))
	if err == nil && len(matches) > 0 {
		for _, appBundle := range matches {
			log.Printf("Clearing quarantine attribute from %s\n", appBundle)
			cmd := exec.Command("xattr", "-rd", "com.apple.quarantine", appBundle)
			if output, err := cmd.CombinedOutput(); err != nil {
				log.Printf("WARNING: failed to clear quarantine on %s: %v (%s)\n",
					appBundle, err, string(output))
			}
		}
		return
	}

	// No .app bundle found; clear quarantine on the entire directory.
	log.Printf("Clearing quarantine attribute from %s\n", path)
	cmd := exec.Command("xattr", "-rd", "com.apple.quarantine", path)
	if output, err := cmd.CombinedOutput(); err != nil {
		// Non-fatal; xattr may not be present or attribute may not exist.
		log.Printf("WARNING: failed to clear quarantine: %v (%s)\n", err, string(output))
	}
}
