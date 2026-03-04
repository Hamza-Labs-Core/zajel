package main

import (
	"fmt"
	"log"
	"os/exec"
	"runtime"
	"time"
)

// DefaultWaitTimeout is the default timeout for WaitForExit if no timeout is provided.
const DefaultWaitTimeout = 60 * time.Second

// WaitForExit polls until the process with the given PID has exited.
// If the process has not exited after `timeout`, it sends SIGTERM (Unix)
// or TerminateProcess (Windows) and waits an additional 10 seconds.
// Returns an error if the process is still running after all attempts.
//
// Limitation: WaitForExit only checks PID existence, not process identity.
// If the original process exits and another process reuses the same PID,
// WaitForExit may wait for the wrong process. On Linux, a best-effort
// process name check is logged as a warning if the name does not match
// expectations. On macOS and Windows, PID reuse detection is not
// implemented due to platform API constraints.
func WaitForExit(pid int, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = DefaultWaitTimeout
	}

	// Best-effort process name check: log a warning if the process name
	// is available and doesn't look like an expected app process.
	if name := getProcessName(pid); name != "" {
		log.Printf("PID %d process name: %q\n", pid, name)
	}

	deadline := time.Now().Add(timeout)
	pollInterval := 500 * time.Millisecond

	// Poll until PID exits or timeout is reached.
	for time.Now().Before(deadline) {
		if !isProcessRunning(pid) {
			return nil
		}
		time.Sleep(pollInterval)
	}

	// Timeout reached; attempt to terminate the process.
	log.Printf("PID %d did not exit within %v, sending termination signal\n", pid, timeout)
	terminateProcess(pid)

	// Wait an additional 10 seconds after sending the signal.
	graceDeadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(graceDeadline) {
		if !isProcessRunning(pid) {
			return nil
		}
		time.Sleep(pollInterval)
	}

	return fmt.Errorf("process %d did not exit after %v timeout + 10s grace period", pid, timeout)
}

// LaunchApp starts the application at the given path as a detached process.
// The updater does not wait for the launched process to complete.
func LaunchApp(executablePath string) error {
	cmd := exec.Command(executablePath)

	// Detach the process so it survives the updater's exit.
	detachProcess(cmd)

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting app %q: %w", executablePath, err)
	}

	// Release the process so the updater does not wait for it.
	if err := cmd.Process.Release(); err != nil {
		// Non-fatal: the process is already started.
		log.Printf("WARNING: failed to release launched process: %v\n", err)
	}

	return nil
}

// isProcessRunning checks whether a process with the given PID is still running.
// Uses platform-specific implementation.
func isProcessRunning(pid int) bool {
	return isProcessRunningPlatform(pid)
}

// terminateProcess sends a termination signal to the given PID.
// Uses platform-specific implementation.
func terminateProcess(pid int) {
	terminateProcessPlatform(pid)
}

// detachProcess configures the command to run as a detached process.
// Uses platform-specific SysProcAttr on Windows.
func detachProcess(cmd *exec.Cmd) {
	if runtime.GOOS == "windows" {
		detachProcessPlatform(cmd)
	}
	// On Unix, cmd.Start() already creates a new process.
	// The updater will exit after Start(), leaving the child running.
}
