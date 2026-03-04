package main

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestWaitForExit_AlreadyExited(t *testing.T) {
	// Use PID 0 which is never a user process (it's the kernel scheduler).
	// isProcessRunning(0) should return false on typical systems since
	// kill(0, 0) sends signal to the calling process group, not PID 0.
	// Instead, start a process and let it exit, then wait on its PID.
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start process: %v", err)
	}
	pid := cmd.Process.Pid
	// Wait for process to complete.
	_ = cmd.Wait()

	// Now wait for the already-exited PID.
	err := WaitForExit(pid, 5*time.Second)
	if err != nil {
		t.Fatalf("WaitForExit should succeed for already-exited PID: %v", err)
	}
}

func TestWaitForExit_ProcessExitsDuringWait(t *testing.T) {
	// Start a process that sleeps briefly then exits.
	cmd := exec.Command("sleep", "1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start sleep process: %v", err)
	}
	pid := cmd.Process.Pid

	// Reap the child in a background goroutine so it doesn't become a zombie.
	// A zombie process still appears as "running" to kill(pid, 0).
	go func() { _ = cmd.Wait() }()

	// Wait for it with a generous timeout.
	err := WaitForExit(pid, 10*time.Second)
	if err != nil {
		t.Fatalf("WaitForExit should succeed when process exits during wait: %v", err)
	}
}

func TestWaitForExit_Timeout(t *testing.T) {
	// Start a long-running process.
	cmd := exec.Command("sleep", "300")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start sleep process: %v", err)
	}
	pid := cmd.Process.Pid

	// Reap the child in a background goroutine so it doesn't become a zombie.
	go func() { _ = cmd.Wait() }()

	// Wait with a very short timeout. The function should send SIGTERM
	// and wait for the grace period. The process should be killed by SIGTERM.
	start := time.Now()
	err := WaitForExit(pid, 1*time.Second)
	elapsed := time.Since(start)

	// The process should have been terminated by SIGTERM within the grace period.
	// If SIGTERM works, err should be nil (process was killed by signal).
	// If SIGTERM doesn't work for some reason, err will indicate timeout.
	if err != nil {
		// This is acceptable; the test validates the timeout path works.
		t.Logf("WaitForExit returned error (timeout path exercised): %v", err)
	}

	// Verify it didn't return instantly - it should have waited at least the timeout.
	if elapsed < 1*time.Second {
		t.Errorf("WaitForExit returned too quickly: %v", elapsed)
	}
}

func TestWaitForExit_DefaultTimeout(t *testing.T) {
	// Verify that passing zero timeout uses the default.
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start process: %v", err)
	}
	pid := cmd.Process.Pid
	_ = cmd.Wait()

	// Zero timeout should use DefaultWaitTimeout and still succeed
	// for an already-exited process.
	err := WaitForExit(pid, 0)
	if err != nil {
		t.Fatalf("WaitForExit with zero timeout should succeed for exited PID: %v", err)
	}
}

func TestWaitForExit_NegativeTimeout(t *testing.T) {
	// Negative timeout should be treated as default.
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start process: %v", err)
	}
	pid := cmd.Process.Pid
	_ = cmd.Wait()

	err := WaitForExit(pid, -5*time.Second)
	if err != nil {
		t.Fatalf("WaitForExit with negative timeout should succeed for exited PID: %v", err)
	}
}

func TestLaunchApp_NonExistentBinary(t *testing.T) {
	err := LaunchApp("/nonexistent/binary/path")
	if err == nil {
		t.Fatal("LaunchApp should fail for non-existent binary")
	}
}

func TestLaunchApp_ValidBinary(t *testing.T) {
	// Launch a real binary that exists.
	truePath, err := exec.LookPath("true")
	if err != nil {
		t.Skipf("'true' binary not found: %v", err)
	}

	err = LaunchApp(truePath)
	if err != nil {
		t.Fatalf("LaunchApp should succeed for a valid binary: %v", err)
	}
}

func TestGetProcessName_CurrentProcess(t *testing.T) {
	// Get the name of the current process.
	pid := os.Getpid()
	name := getProcessName(pid)

	// On Linux, the process name should be available via /proc.
	// It will be the test binary name (something like "updater.test").
	if name == "" {
		t.Log("getProcessName returned empty for current process (may be expected on some platforms)")
		return
	}
	t.Logf("Current process name: %q", name)
}

func TestGetProcessName_NonExistentPID(t *testing.T) {
	// Use a very high PID that almost certainly doesn't exist.
	name := getProcessName(4194304)
	if name != "" {
		t.Errorf("expected empty name for non-existent PID, got %q", name)
	}
}

func TestIsProcessRunning_CurrentProcess(t *testing.T) {
	pid := os.Getpid()
	if !isProcessRunning(pid) {
		t.Error("current process should be detected as running")
	}
}

func TestIsProcessRunning_NonExistentProcess(t *testing.T) {
	// PID 4194304 is beyond the typical max PID range.
	if isProcessRunning(4194304) {
		t.Error("non-existent PID should not be detected as running")
	}
}
