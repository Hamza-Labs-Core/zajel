//go:build windows

package main

import (
	"fmt"
	"log"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess         = kernel32.NewProc("OpenProcess")
	procWaitForSingleObject = kernel32.NewProc("WaitForSingleObject")
	procCloseHandle         = kernel32.NewProc("CloseHandle")
)

const (
	processQueryLimitedInfo = 0x1000
	waitTimeout             = 0x00000102
	waitObject0             = 0x00000000
	waitFailed              = 0xFFFFFFFF
	infinite                = 0xFFFFFFFF
)

// isProcessRunningPlatform checks if a process is still running on Windows
// using OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION.
func isProcessRunningPlatform(pid int) bool {
	handle, _, err := procOpenProcess.Call(
		uintptr(processQueryLimitedInfo),
		0,
		uintptr(pid),
	)
	if handle == 0 {
		// OpenProcess failed; process likely does not exist.
		_ = err
		return false
	}
	defer procCloseHandle.Call(handle)

	// Wait with zero timeout to check if the process has exited.
	ret, _, _ := procWaitForSingleObject.Call(handle, 0)
	return ret == uintptr(waitTimeout)
}

// terminateProcessPlatform terminates a process on Windows using TerminateProcess.
func terminateProcessPlatform(pid int) {
	handle, _, _ := procOpenProcess.Call(
		uintptr(0x0001), // PROCESS_TERMINATE
		0,
		uintptr(pid),
	)
	if handle == 0 {
		return
	}
	defer procCloseHandle.Call(handle)

	// TerminateProcess with exit code 1.
	syscall.TerminateProcess(syscall.Handle(handle), 1)
}

// detachProcessPlatform configures a command to run detached on Windows
// using CREATE_NEW_PROCESS_GROUP and DETACHED_PROCESS creation flags.
func detachProcessPlatform(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | 0x00000008, // DETACHED_PROCESS
	}
}

// copyFilePlatform copies a file with retry logic for locked DLLs on Windows.
// Retries up to 5 times with exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms.
func copyFilePlatform(src, dst string) error {
	var lastErr error
	backoff := 100 * time.Millisecond

	for attempt := 0; attempt < 5; attempt++ {
		lastErr = copyFileDefault(src, dst)
		if lastErr == nil {
			return nil
		}
		log.Printf("File copy attempt %d failed for %q: %v (retrying in %v)\n",
			attempt+1, src, lastErr, backoff)
		time.Sleep(backoff)
		backoff *= 2
	}

	return fmt.Errorf("failed after 5 attempts: %w", lastErr)
}

// postCopyPlatform performs Windows-specific post-copy actions.
// No additional actions are needed on Windows.
func postCopyPlatform(m *Manifest) {
	// No post-copy actions needed on Windows.
}

// getProcessName returns the name of the process with the given PID on Windows.
// Uses tasklist to query the process name. Returns an empty string if the name
// cannot be determined. Note: this is best-effort; if the process has already
// exited or tasklist is unavailable, an empty string is returned.
func getProcessName(pid int) string {
	out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH").Output()
	if err != nil {
		return ""
	}
	// Output format: "process.exe","PID","Session Name","Session#","Mem Usage"
	line := strings.TrimSpace(string(out))
	if strings.HasPrefix(line, "\"") {
		// Extract the process name from the first quoted field.
		end := strings.Index(line[1:], "\"")
		if end > 0 {
			return line[1 : end+1]
		}
	}
	return ""
}

// waitForPIDPlatform uses WaitForSingleObject for efficient PID waiting on Windows.
// This is an alternative to polling that blocks until the process exits or timeout.
func waitForPIDPlatform(pid int, timeout time.Duration) error {
	handle, _, err := procOpenProcess.Call(
		uintptr(processQueryLimitedInfo|0x00100000), // SYNCHRONIZE
		0,
		uintptr(pid),
	)
	if handle == 0 {
		// Process does not exist or cannot be opened; treat as already exited.
		_ = err
		return nil
	}
	defer procCloseHandle.Call(handle)

	timeoutMs := uint32(timeout.Milliseconds())
	ret, _, _ := procWaitForSingleObject.Call(handle, uintptr(timeoutMs))

	switch ret {
	case uintptr(waitObject0):
		return nil // Process exited.
	case uintptr(waitTimeout):
		return fmt.Errorf("process %d did not exit within %v", pid, timeout)
	default:
		return fmt.Errorf("WaitForSingleObject failed for PID %d", pid)
	}
}
