#!/bin/bash
#
# Integration Test Runner for Zajel Flutter App
#
# This script:
# 1. Optionally starts a local VPS server for testing
# 2. Runs Flutter integration tests
# 3. Cleans up after completion
#
# Usage:
#   ./run_integration_tests.sh                  # Run all integration tests (localhost)
#   ./run_integration_tests.sh --with-server    # Start VPS server and run tests
#   ./run_integration_tests.sh --mock           # Run with mock server (no network)
#   ./run_integration_tests.sh --ci             # Run in CI mode
#   ./run_integration_tests.sh app              # Run only app_test.dart
#   ./run_integration_tests.sh connection       # Run only connection_test.dart
#
# Environment variables:
#   TEST_VPS_SERVER_URL   - WebSocket URL for VPS server (default: ws://localhost:8080)
#   TEST_BOOTSTRAP_URL    - HTTP URL for bootstrap server (default: http://localhost:8787)
#   TEST_PEER_CODE        - Pairing code of a test peer (for two-device tests)
#   TEST_VERBOSE          - Set to 'true' for verbose output
#   TEST_DEVICE           - Device ID for testing (e.g., 'emulator-5554')
#

set -e

# Default configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VPS_SERVER_DIR="$PROJECT_ROOT/packages/server-vps"
VPS_PID_FILE="/tmp/zajel-test-vps.pid"
START_SERVER=false
USE_MOCK=false
CI_MODE=false
TEST_FILE=""
VERBOSE="${TEST_VERBOSE:-false}"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --with-server)
            START_SERVER=true
            shift
            ;;
        --mock)
            USE_MOCK=true
            export TEST_USE_MOCK_SERVER=true
            shift
            ;;
        --ci)
            CI_MODE=true
            export CI=true
            export TEST_VERBOSE=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            export TEST_VERBOSE=true
            shift
            ;;
        app)
            TEST_FILE="app_test.dart"
            shift
            ;;
        connection)
            TEST_FILE="connection_test.dart"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS] [TEST_FILE]"
            echo ""
            echo "Options:"
            echo "  --with-server    Start local VPS server before testing"
            echo "  --mock           Run with mock server (no network required)"
            echo "  --ci             Run in CI mode (longer timeouts, verbose)"
            echo "  --verbose, -v    Enable verbose output"
            echo "  --help, -h       Show this help message"
            echo ""
            echo "Test Files:"
            echo "  app              Run only app_test.dart"
            echo "  connection       Run only connection_test.dart"
            echo ""
            echo "Environment Variables:"
            echo "  TEST_VPS_SERVER_URL   - VPS server WebSocket URL"
            echo "  TEST_BOOTSTRAP_URL    - Bootstrap server HTTP URL"
            echo "  TEST_PEER_CODE        - Test peer's pairing code"
            echo "  TEST_VERBOSE          - Enable verbose logging"
            echo "  TEST_DEVICE           - Target device ID"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to start VPS server
start_vps_server() {
    log_info "Starting VPS server for testing..."

    if [ ! -d "$VPS_SERVER_DIR" ]; then
        log_error "VPS server directory not found: $VPS_SERVER_DIR"
        exit 1
    fi

    cd "$VPS_SERVER_DIR"

    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        log_info "Installing VPS server dependencies..."
        npm install
    fi

    # Start the server in the background
    log_info "Starting VPS server on ws://localhost:8080..."
    npm run dev &
    VPS_PID=$!
    echo $VPS_PID > "$VPS_PID_FILE"

    # Wait for server to be ready
    log_info "Waiting for VPS server to be ready..."
    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -s http://localhost:8080/health > /dev/null 2>&1; then
            log_success "VPS server is ready"
            return 0
        fi

        # Check if process is still running
        if ! kill -0 $VPS_PID 2>/dev/null; then
            log_error "VPS server process died"
            return 1
        fi

        sleep 1
        attempt=$((attempt + 1))
    done

    log_error "VPS server failed to start within timeout"
    return 1
}

# Function to stop VPS server
stop_vps_server() {
    if [ -f "$VPS_PID_FILE" ]; then
        local pid=$(cat "$VPS_PID_FILE")
        if kill -0 $pid 2>/dev/null; then
            log_info "Stopping VPS server (PID: $pid)..."
            kill $pid 2>/dev/null || true
            # Wait for graceful shutdown
            sleep 2
            # Force kill if still running
            kill -9 $pid 2>/dev/null || true
        fi
        rm -f "$VPS_PID_FILE"
    fi
}

# Cleanup function
cleanup() {
    log_info "Cleaning up..."
    stop_vps_server
    cd "$SCRIPT_DIR"
}

# Set up trap for cleanup
trap cleanup EXIT

# Main execution
main() {
    log_info "Zajel Integration Test Runner"
    log_info "=============================="

    # Change to the app directory
    cd "$SCRIPT_DIR"

    # Print configuration
    if [ "$VERBOSE" = "true" ]; then
        log_info "Configuration:"
        log_info "  Project root: $PROJECT_ROOT"
        log_info "  Start server: $START_SERVER"
        log_info "  Use mock: $USE_MOCK"
        log_info "  CI mode: $CI_MODE"
        log_info "  Test file: ${TEST_FILE:-all}"
        log_info "  VPS URL: ${TEST_VPS_SERVER_URL:-ws://localhost:8080}"
        log_info "  Bootstrap URL: ${TEST_BOOTSTRAP_URL:-http://localhost:8787}"
    fi

    # Start VPS server if requested
    if [ "$START_SERVER" = "true" ]; then
        start_vps_server
    fi

    # Get Flutter packages
    log_info "Getting Flutter packages..."
    flutter pub get

    # Determine which tests to run
    local test_target=""
    if [ -n "$TEST_FILE" ]; then
        test_target="integration_test/$TEST_FILE"
    else
        test_target="integration_test"
    fi

    # Determine device
    local device_arg=""
    if [ -n "$TEST_DEVICE" ]; then
        device_arg="-d $TEST_DEVICE"
    fi

    # Run integration tests
    log_info "Running integration tests: $test_target"

    # Use flutter test for integration tests
    # Note: flutter drive is deprecated for integration tests in favor of flutter test
    local test_cmd="flutter test $test_target $device_arg"

    if [ "$VERBOSE" = "true" ]; then
        test_cmd="$test_cmd --reporter expanded"
    fi

    log_info "Running: $test_cmd"

    if eval $test_cmd; then
        log_success "All integration tests passed!"
        exit 0
    else
        log_error "Some integration tests failed"
        exit 1
    fi
}

# Run main function
main
