package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeManifestFile writes a manifest JSON string to a temporary file
// and returns the path.
func writeManifestFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write manifest file: %v", err)
	}
	return path
}

func TestParseManifest(t *testing.T) {
	manifestJSON := `{
		"schema_version": 1,
		"app_pid": 12345,
		"app_version_current": "1.0.0",
		"app_version_target": "1.2.0",
		"install_dir": "/home/user/.local/share/zajel/app",
		"staging_dir": "/home/user/.local/share/zajel/update-staging/zajel-1.2.0-linux",
		"backup_dir": "/home/user/.local/share/zajel/update-backup",
		"app_executable": "zajel",
		"platform": "linux",
		"checksum_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"timestamp": "2026-03-03T12:00:00Z"
	}`

	path := writeManifestFile(t, manifestJSON)
	m, err := ParseManifest(path)
	if err != nil {
		t.Fatalf("ParseManifest failed: %v", err)
	}

	if m.SchemaVersion != 1 {
		t.Errorf("expected schema_version 1, got %d", m.SchemaVersion)
	}
	if m.AppPID != 12345 {
		t.Errorf("expected app_pid 12345, got %d", m.AppPID)
	}
	if m.AppVersionCurrent != "1.0.0" {
		t.Errorf("expected app_version_current '1.0.0', got %q", m.AppVersionCurrent)
	}
	if m.AppVersionTarget != "1.2.0" {
		t.Errorf("expected app_version_target '1.2.0', got %q", m.AppVersionTarget)
	}
	if m.InstallDir != "/home/user/.local/share/zajel/app" {
		t.Errorf("unexpected install_dir: %q", m.InstallDir)
	}
	if m.StagingDir != "/home/user/.local/share/zajel/update-staging/zajel-1.2.0-linux" {
		t.Errorf("unexpected staging_dir: %q", m.StagingDir)
	}
	if m.BackupDir != "/home/user/.local/share/zajel/update-backup" {
		t.Errorf("unexpected backup_dir: %q", m.BackupDir)
	}
	if m.AppExecutable != "zajel" {
		t.Errorf("expected app_executable 'zajel', got %q", m.AppExecutable)
	}
	if m.Platform != "linux" {
		t.Errorf("expected platform 'linux', got %q", m.Platform)
	}
	if m.ChecksumSHA256 != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Errorf("unexpected checksum_sha256: %q", m.ChecksumSHA256)
	}
	if m.Timestamp != "2026-03-03T12:00:00Z" {
		t.Errorf("unexpected timestamp: %q", m.Timestamp)
	}
}

func TestParseManifest_WindowsPaths(t *testing.T) {
	manifestJSON := `{
		"schema_version": 1,
		"app_pid": 9876,
		"app_version_current": "1.0.0",
		"app_version_target": "1.2.0",
		"install_dir": "C:\\Users\\John Doe\\AppData\\Local\\Zajel\\app",
		"staging_dir": "C:\\Users\\John Doe\\AppData\\Local\\Zajel\\update-staging",
		"backup_dir": "C:\\Users\\John Doe\\AppData\\Local\\Zajel\\update-backup",
		"app_executable": "zajel.exe",
		"platform": "windows",
		"checksum_sha256": "abc123",
		"timestamp": "2026-03-03T12:00:00Z"
	}`

	path := writeManifestFile(t, manifestJSON)
	m, err := ParseManifest(path)
	if err != nil {
		t.Fatalf("ParseManifest failed: %v", err)
	}

	if m.InstallDir != `C:\Users\John Doe\AppData\Local\Zajel\app` {
		t.Errorf("unexpected install_dir: %q", m.InstallDir)
	}
	if m.AppExecutable != "zajel.exe" {
		t.Errorf("expected app_executable 'zajel.exe', got %q", m.AppExecutable)
	}
	if m.Platform != "windows" {
		t.Errorf("expected platform 'windows', got %q", m.Platform)
	}
}

func TestParseManifest_DarwinPlatform(t *testing.T) {
	manifestJSON := `{
		"schema_version": 1,
		"app_pid": 5555,
		"app_version_current": "2.0.0",
		"app_version_target": "2.1.0",
		"install_dir": "/Applications",
		"staging_dir": "/Users/user/Library/Application Support/com.zajel.zajel/update-staging",
		"backup_dir": "/Users/user/Library/Application Support/com.zajel.zajel/update-backup",
		"app_executable": "zajel.app/Contents/MacOS/zajel",
		"platform": "darwin",
		"checksum_sha256": "def456",
		"timestamp": "2026-03-03T12:00:00Z"
	}`

	path := writeManifestFile(t, manifestJSON)
	m, err := ParseManifest(path)
	if err != nil {
		t.Fatalf("ParseManifest failed: %v", err)
	}

	if m.Platform != "darwin" {
		t.Errorf("expected platform 'darwin', got %q", m.Platform)
	}
}

func TestParseManifest_MissingFields(t *testing.T) {
	tests := []struct {
		name        string
		json        string
		wantMissing string
	}{
		{
			name: "missing app_version_current",
			json: `{
				"schema_version": 1,
				"app_version_target": "1.2.0",
				"install_dir": "/opt/zajel",
				"staging_dir": "/tmp/staging",
				"backup_dir": "/tmp/backup",
				"app_executable": "zajel",
				"platform": "linux"
			}`,
			wantMissing: "app_version_current",
		},
		{
			name: "missing app_version_target",
			json: `{
				"schema_version": 1,
				"app_version_current": "1.0.0",
				"install_dir": "/opt/zajel",
				"staging_dir": "/tmp/staging",
				"backup_dir": "/tmp/backup",
				"app_executable": "zajel",
				"platform": "linux"
			}`,
			wantMissing: "app_version_target",
		},
		{
			name: "missing install_dir",
			json: `{
				"schema_version": 1,
				"app_version_current": "1.0.0",
				"app_version_target": "1.2.0",
				"staging_dir": "/tmp/staging",
				"backup_dir": "/tmp/backup",
				"app_executable": "zajel",
				"platform": "linux"
			}`,
			wantMissing: "install_dir",
		},
		{
			name: "missing staging_dir",
			json: `{
				"schema_version": 1,
				"app_version_current": "1.0.0",
				"app_version_target": "1.2.0",
				"install_dir": "/opt/zajel",
				"backup_dir": "/tmp/backup",
				"app_executable": "zajel",
				"platform": "linux"
			}`,
			wantMissing: "staging_dir",
		},
		{
			name: "missing backup_dir",
			json: `{
				"schema_version": 1,
				"app_version_current": "1.0.0",
				"app_version_target": "1.2.0",
				"install_dir": "/opt/zajel",
				"staging_dir": "/tmp/staging",
				"app_executable": "zajel",
				"platform": "linux"
			}`,
			wantMissing: "backup_dir",
		},
		{
			name: "missing app_executable",
			json: `{
				"schema_version": 1,
				"app_version_current": "1.0.0",
				"app_version_target": "1.2.0",
				"install_dir": "/opt/zajel",
				"staging_dir": "/tmp/staging",
				"backup_dir": "/tmp/backup",
				"platform": "linux"
			}`,
			wantMissing: "app_executable",
		},
		{
			name: "missing platform",
			json: `{
				"schema_version": 1,
				"app_version_current": "1.0.0",
				"app_version_target": "1.2.0",
				"install_dir": "/opt/zajel",
				"staging_dir": "/tmp/staging",
				"backup_dir": "/tmp/backup",
				"app_executable": "zajel"
			}`,
			wantMissing: "platform",
		},
		{
			name: "multiple missing fields",
			json: `{
				"schema_version": 1,
				"platform": "linux"
			}`,
			wantMissing: "app_version_current",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := writeManifestFile(t, tc.json)
			_, err := ParseManifest(path)
			if err == nil {
				t.Fatal("expected error for missing fields")
			}
			if !strings.Contains(err.Error(), tc.wantMissing) {
				t.Errorf("error should mention %q, got: %v", tc.wantMissing, err)
			}
		})
	}
}

func TestParseManifest_InvalidJSON(t *testing.T) {
	tests := []struct {
		name string
		json string
	}{
		{
			name: "empty file",
			json: "",
		},
		{
			name: "truncated JSON",
			json: `{"schema_version": 1, "app_version`,
		},
		{
			name: "plain text",
			json: "this is not json",
		},
		{
			name: "XML instead of JSON",
			json: `<manifest><version>1</version></manifest>`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := writeManifestFile(t, tc.json)
			_, err := ParseManifest(path)
			if err == nil {
				t.Fatal("expected error for invalid JSON")
			}
		})
	}
}

func TestParseManifest_UnsupportedSchemaVersion(t *testing.T) {
	manifestJSON := `{
		"schema_version": 99,
		"app_pid": 12345,
		"app_version_current": "1.0.0",
		"app_version_target": "1.2.0",
		"install_dir": "/opt/zajel",
		"staging_dir": "/tmp/staging",
		"backup_dir": "/tmp/backup",
		"app_executable": "zajel",
		"platform": "linux",
		"checksum_sha256": "abc123",
		"timestamp": "2026-03-03T12:00:00Z"
	}`

	path := writeManifestFile(t, manifestJSON)
	_, err := ParseManifest(path)
	if err == nil {
		t.Fatal("expected error for unsupported schema version")
	}
	if !strings.Contains(err.Error(), "unsupported schema_version") {
		t.Errorf("error should mention unsupported schema_version, got: %v", err)
	}
}

func TestParseManifest_InvalidPlatform(t *testing.T) {
	manifestJSON := `{
		"schema_version": 1,
		"app_pid": 12345,
		"app_version_current": "1.0.0",
		"app_version_target": "1.2.0",
		"install_dir": "/opt/zajel",
		"staging_dir": "/tmp/staging",
		"backup_dir": "/tmp/backup",
		"app_executable": "zajel",
		"platform": "android",
		"checksum_sha256": "abc123",
		"timestamp": "2026-03-03T12:00:00Z"
	}`

	path := writeManifestFile(t, manifestJSON)
	_, err := ParseManifest(path)
	if err == nil {
		t.Fatal("expected error for invalid platform")
	}
	if !strings.Contains(err.Error(), "unsupported platform") {
		t.Errorf("error should mention unsupported platform, got: %v", err)
	}
}

func TestParseManifest_FileNotFound(t *testing.T) {
	_, err := ParseManifest("/nonexistent/path/manifest.json")
	if err == nil {
		t.Fatal("expected error for non-existent manifest file")
	}
}

func TestParseManifest_UnicodePaths(t *testing.T) {
	manifestJSON := `{
		"schema_version": 1,
		"app_pid": 12345,
		"app_version_current": "1.0.0",
		"app_version_target": "1.2.0",
		"install_dir": "/home/用户/zajel",
		"staging_dir": "/home/用户/zajel-staging",
		"backup_dir": "/home/用户/zajel-backup",
		"app_executable": "zajel",
		"platform": "linux",
		"checksum_sha256": "abc123",
		"timestamp": "2026-03-03T12:00:00Z"
	}`

	path := writeManifestFile(t, manifestJSON)
	m, err := ParseManifest(path)
	if err != nil {
		t.Fatalf("ParseManifest failed with unicode paths: %v", err)
	}

	if m.InstallDir != "/home/用户/zajel" {
		t.Errorf("unexpected install_dir: %q", m.InstallDir)
	}
}

func TestParseManifest_PathTraversal(t *testing.T) {
	tests := []struct {
		name       string
		installDir string
		stagingDir string
		backupDir  string
		wantErr    string
	}{
		{
			name:       "install_dir with ..",
			installDir: "/opt/zajel/../../etc/passwd",
			stagingDir: "/tmp/staging",
			backupDir:  "/tmp/backup",
			wantErr:    "install_dir contains path traversal",
		},
		{
			name:       "staging_dir with ..",
			installDir: "/opt/zajel",
			stagingDir: "/tmp/staging/../../etc",
			backupDir:  "/tmp/backup",
			wantErr:    "staging_dir contains path traversal",
		},
		{
			name:       "backup_dir with ..",
			installDir: "/opt/zajel",
			stagingDir: "/tmp/staging",
			backupDir:  "/tmp/backup/../../../etc",
			wantErr:    "backup_dir contains path traversal",
		},
		{
			name:       "relative install_dir",
			installDir: "relative/path/to/app",
			stagingDir: "/tmp/staging",
			backupDir:  "/tmp/backup",
			wantErr:    "install_dir must be an absolute path",
		},
		{
			name:       "relative staging_dir",
			installDir: "/opt/zajel",
			stagingDir: "staging",
			backupDir:  "/tmp/backup",
			wantErr:    "staging_dir must be an absolute path",
		},
		{
			name:       "relative backup_dir",
			installDir: "/opt/zajel",
			stagingDir: "/tmp/staging",
			backupDir:  "backup",
			wantErr:    "backup_dir must be an absolute path",
		},
		{
			name:       "dot-dot only path",
			installDir: "/../../../",
			stagingDir: "/tmp/staging",
			backupDir:  "/tmp/backup",
			wantErr:    "path traversal",
		},
		{
			name:       "embedded .. in middle",
			installDir: "/opt/zajel/../../../etc/shadow",
			stagingDir: "/tmp/staging",
			backupDir:  "/tmp/backup",
			wantErr:    "path traversal",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			manifestJSON := fmt.Sprintf(`{
				"schema_version": 1,
				"app_pid": 12345,
				"app_version_current": "1.0.0",
				"app_version_target": "1.2.0",
				"install_dir": %q,
				"staging_dir": %q,
				"backup_dir": %q,
				"app_executable": "zajel",
				"platform": "linux",
				"checksum_sha256": "abc123",
				"timestamp": "2026-03-03T12:00:00Z"
			}`, tc.installDir, tc.stagingDir, tc.backupDir)

			path := writeManifestFile(t, manifestJSON)
			_, err := ParseManifest(path)
			if err == nil {
				t.Fatalf("expected error containing %q", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("expected error containing %q, got: %v", tc.wantErr, err)
			}
		})
	}
}

func TestParseManifest_ValidAbsolutePaths(t *testing.T) {
	// These should all pass validation.
	tests := []struct {
		name       string
		installDir string
		stagingDir string
		backupDir  string
		platform   string
	}{
		{
			name:       "unix absolute paths",
			installDir: "/opt/zajel/app",
			stagingDir: "/tmp/zajel-staging",
			backupDir:  "/tmp/zajel-backup",
			platform:   "linux",
		},
		{
			name:       "windows absolute paths",
			installDir: `C:\Users\Test\AppData\Local\Zajel\app`,
			stagingDir: `C:\Users\Test\AppData\Local\Zajel\staging`,
			backupDir:  `C:\Users\Test\AppData\Local\Zajel\backup`,
			platform:   "windows",
		},
		{
			name:       "deep unix paths",
			installDir: "/home/user/.local/share/com.zajel.zajel/app",
			stagingDir: "/home/user/.local/share/com.zajel.zajel/update-staging",
			backupDir:  "/home/user/.local/share/com.zajel.zajel/update-backup",
			platform:   "linux",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			manifestJSON := fmt.Sprintf(`{
				"schema_version": 1,
				"app_pid": 12345,
				"app_version_current": "1.0.0",
				"app_version_target": "1.2.0",
				"install_dir": %q,
				"staging_dir": %q,
				"backup_dir": %q,
				"app_executable": "zajel",
				"platform": %q,
				"checksum_sha256": "abc123",
				"timestamp": "2026-03-03T12:00:00Z"
			}`, tc.installDir, tc.stagingDir, tc.backupDir, tc.platform)

			path := writeManifestFile(t, manifestJSON)
			_, err := ParseManifest(path)
			if err != nil {
				t.Fatalf("expected no error for valid paths, got: %v", err)
			}
		})
	}
}

func TestValidatePath(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{name: "valid unix path", path: "/opt/zajel", wantErr: false},
		{name: "valid deep path", path: "/home/user/.local/share/app", wantErr: false},
		{name: "relative path", path: "relative/path", wantErr: true},
		{name: "dot-dot in path", path: "/opt/../etc", wantErr: true},
		{name: "leading dot-dot", path: "/../etc", wantErr: true},
		{name: "just dot-dot", path: "..", wantErr: true},
		{name: "empty string", path: "", wantErr: true},
		{name: "dot path", path: ".", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validatePath("test_field", tc.path)
			if tc.wantErr && err == nil {
				t.Errorf("expected error for path %q", tc.path)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("unexpected error for path %q: %v", tc.path, err)
			}
		})
	}
}

func TestParseManifest_ZeroSchemaVersion(t *testing.T) {
	manifestJSON := `{
		"app_pid": 12345,
		"app_version_current": "1.0.0",
		"app_version_target": "1.2.0",
		"install_dir": "/opt/zajel",
		"staging_dir": "/tmp/staging",
		"backup_dir": "/tmp/backup",
		"app_executable": "zajel",
		"platform": "linux"
	}`

	path := writeManifestFile(t, manifestJSON)
	_, err := ParseManifest(path)
	if err == nil {
		t.Fatal("expected error for zero/missing schema_version")
	}
	if !strings.Contains(err.Error(), "unsupported schema_version") {
		t.Errorf("error should mention unsupported schema_version, got: %v", err)
	}
}
