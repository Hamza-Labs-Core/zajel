package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Manifest represents the update manifest JSON written by the Flutter app
// and read by the updater binary. It is the IPC contract between the two.
type Manifest struct {
	SchemaVersion     int    `json:"schema_version"`
	AppPID            int    `json:"app_pid"`
	AppVersionCurrent string `json:"app_version_current"`
	AppVersionTarget  string `json:"app_version_target"`
	InstallDir        string `json:"install_dir"`
	StagingDir        string `json:"staging_dir"`
	BackupDir         string `json:"backup_dir"`
	AppExecutable     string `json:"app_executable"`
	Platform          string `json:"platform"`
	ChecksumSHA256    string `json:"checksum_sha256"`
	Timestamp         string `json:"timestamp"`
}

// ParseManifest reads and validates a manifest JSON file at the given path.
func ParseManifest(path string) (*Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading manifest file: %w", err)
	}

	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parsing manifest JSON: %w", err)
	}

	if err := m.validate(); err != nil {
		return nil, fmt.Errorf("validating manifest: %w", err)
	}

	return &m, nil
}

// validate checks that all required fields are present and valid.
func (m *Manifest) validate() error {
	if m.SchemaVersion != 1 {
		return fmt.Errorf("unsupported schema_version: %d (expected 1)", m.SchemaVersion)
	}

	var missing []string
	if m.AppVersionCurrent == "" {
		missing = append(missing, "app_version_current")
	}
	if m.AppVersionTarget == "" {
		missing = append(missing, "app_version_target")
	}
	if m.InstallDir == "" {
		missing = append(missing, "install_dir")
	}
	if m.StagingDir == "" {
		missing = append(missing, "staging_dir")
	}
	if m.BackupDir == "" {
		missing = append(missing, "backup_dir")
	}
	if m.AppExecutable == "" {
		missing = append(missing, "app_executable")
	}
	if m.Platform == "" {
		missing = append(missing, "platform")
	}

	if len(missing) > 0 {
		return fmt.Errorf("missing required fields: %s", strings.Join(missing, ", "))
	}

	validPlatforms := map[string]bool{
		"windows": true,
		"darwin":  true,
		"linux":   true,
	}
	if !validPlatforms[m.Platform] {
		return fmt.Errorf("unsupported platform: %q (expected windows, darwin, or linux)", m.Platform)
	}

	// Validate paths against traversal attacks.
	pathChecks := []struct {
		name string
		path string
	}{
		{"install_dir", m.InstallDir},
		{"staging_dir", m.StagingDir},
		{"backup_dir", m.BackupDir},
	}
	for _, pc := range pathChecks {
		if err := validatePath(pc.name, pc.path); err != nil {
			return err
		}
	}

	return nil
}

// validatePath checks that a path is absolute and does not contain
// path traversal components ("..").
func validatePath(name, path string) error {
	// Must be absolute.
	if !isAbsolutePath(path) {
		return fmt.Errorf("%s must be an absolute path, got: %q", name, path)
	}

	// Check the ORIGINAL path (not cleaned) for ".." components.
	// filepath.Clean would resolve ".." away, hiding traversal attempts.
	// We reject any path containing ".." as a component, since legitimate
	// paths from our Flutter app should never contain them.
	for _, part := range splitPath(path) {
		if part == ".." {
			return fmt.Errorf("%s contains path traversal component '..': %q", name, path)
		}
	}

	return nil
}

// isAbsolutePath checks if the path is absolute, handling both Unix and
// Windows path formats regardless of the current platform.
func isAbsolutePath(path string) bool {
	if filepath.IsAbs(path) {
		return true
	}
	// On non-Windows platforms, also accept Windows-style absolute paths
	// (e.g., "C:\Users\...") since the manifest may specify a Windows platform.
	if runtime.GOOS != "windows" && len(path) >= 3 {
		drive := path[0]
		if (drive >= 'A' && drive <= 'Z' || drive >= 'a' && drive <= 'z') &&
			path[1] == ':' && (path[2] == '\\' || path[2] == '/') {
			return true
		}
	}
	return false
}

// splitPath splits a cleaned path into its individual components.
func splitPath(path string) []string {
	// Use both separators to handle cross-platform paths in manifest.
	var parts []string
	for _, p := range strings.Split(path, string(filepath.Separator)) {
		if p != "" {
			parts = append(parts, p)
		}
	}
	// Also split on forward slash for Windows paths that use backslash
	// but were cleaned with filepath.Clean.
	if filepath.Separator != '/' {
		var expanded []string
		for _, p := range parts {
			for _, sub := range strings.Split(p, "/") {
				if sub != "" {
					expanded = append(expanded, sub)
				}
			}
		}
		return expanded
	}
	return parts
}
