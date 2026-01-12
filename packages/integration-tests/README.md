# Zajel Integration Tests

Cross-app integration tests for the Zajel P2P messaging system, coordinating tests between VPS server, web-client, and (potentially) Flutter app.

## Overview

This package provides a test orchestrator and integration test scenarios that verify the complete flow of:

- VPS signaling server functionality
- Web client pairing and communication
- Cross-client message exchange
- WebRTC signaling relay
- Connection resilience

## Prerequisites

### System Requirements

- Node.js 20.0.0 or higher
- npm 9.0.0 or higher

### Dependencies

Before running integration tests, install Playwright browsers:

```bash
# Navigate to integration-tests package
cd packages/integration-tests

# Install dependencies
npm install

# Install Playwright browsers (required for browser-based tests)
npx playwright install chromium
```

### Related Packages

Ensure the following packages are built:

```bash
# Build server-vps
cd packages/server-vps
npm install
npm run build

# Build web-client (for browser tests)
cd packages/web-client
npm install
npm run build
```

## Running Tests

### All Integration Tests

```bash
# From the integration-tests directory
npm test

# Or from the repository root
npm run test:integration
```

### Specific Test Scenarios

```bash
# Web-to-web browser tests only
npm run test:web-to-web

# Pairing flow tests only
npm run test:pairing
```

### Watch Mode

```bash
npm run test:watch
```

### Verbose Output

Set the `VERBOSE` environment variable for detailed logs:

```bash
VERBOSE=1 npm test
```

## Test Scenarios

### Web-to-Web Tests (`web-to-web.test.ts`)

Tests end-to-end communication between two browser instances:

- **Browser Loading**: Both browsers load the web client successfully
- **Unique Pairing Codes**: Each client generates a unique pairing code
- **Complete Pairing Flow**: Full pairing handshake between browsers
- **Pairing Rejection**: Handles rejected pairing requests
- **Message Exchange**: Text messages sent and received
- **Bidirectional Messaging**: Both parties can send/receive
- **Connection Resilience**: Handles peer disconnection gracefully

### Pairing Flow Tests (`pairing-flow.test.ts`)

Tests pairing mechanics from VPS server perspective:

- **Registration**: Valid and invalid registration scenarios
- **Pairing Between Clients**: WebSocket-to-WebSocket pairing
- **WebRTC Signaling**: Offer/answer/ICE candidate relay
- **Browser to WebSocket**: Cross-platform pairing
- **Multi-Client**: Simultaneous connections
- **Keep-Alive**: Ping/pong mechanism

## Architecture

### Test Orchestrator

The `TestOrchestrator` class coordinates test infrastructure:

```typescript
import { TestOrchestrator } from './orchestrator';

const orchestrator = new TestOrchestrator({
  headless: true,        // Run browsers headlessly
  verbose: false,        // Enable debug logging
  startupTimeout: 30000, // Timeout for service startup
});

// Start infrastructure
await orchestrator.startMockBootstrap();  // Mock CF Workers bootstrap
await orchestrator.startVpsServer();      // Start VPS signaling server
await orchestrator.startWebClient();      // Start Vite dev server

// Create test clients
const browser = await orchestrator.connectWebBrowser();
const { ws, serverInfo } = await orchestrator.createWsClient();

// Cleanup
await orchestrator.cleanup();
```

### Mock Bootstrap Server

The orchestrator includes a mock CF Workers bootstrap server for:

- Server registration
- Server discovery
- Heartbeat handling
- Peer list exchange

### Helper Functions

```typescript
import { waitFor, delay, getNextPort } from './orchestrator';

// Wait for a condition with timeout
await waitFor(() => someCondition(), 10000);

// Simple delay
await delay(1000);

// Get unique port for test services
const port = getNextPort();
```

## CI Configuration

### GitHub Actions Example

```yaml
name: Integration Tests

on: [push, pull_request]

jobs:
  integration-tests:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: |
          npm ci
          cd packages/server-vps && npm ci && npm run build
          cd ../web-client && npm ci
          cd ../integration-tests && npm ci

      - name: Install Playwright browsers
        run: npx playwright install chromium --with-deps
        working-directory: packages/integration-tests

      - name: Run integration tests
        run: npm test
        working-directory: packages/integration-tests
        env:
          CI: true
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CI` | Running in CI environment | `false` |
| `VERBOSE` | Enable verbose logging | `false` |
| `HEADLESS` | Run browsers headlessly | `true` |

## Troubleshooting

### Browser Tests Failing

1. Ensure Playwright browsers are installed:
   ```bash
   npx playwright install chromium
   ```

2. On Linux, install system dependencies:
   ```bash
   npx playwright install-deps chromium
   ```

### Port Conflicts

Tests use random ports starting from 15000+. If conflicts occur:

1. Check for orphaned processes:
   ```bash
   lsof -i :15000-20000
   ```

2. Kill any stale processes from previous test runs

### Timeout Issues

- Increase `startupTimeout` in orchestrator config
- Check system resources (CPU, memory)
- Ensure network is not blocking localhost connections

### WebSocket Connection Failures

1. Verify server-vps package is built:
   ```bash
   cd packages/server-vps && npm run build
   ```

2. Check for firewall rules blocking localhost

## Adding New Tests

1. Create a new test file in `src/scenarios/`:
   ```typescript
   // src/scenarios/my-feature.test.ts
   import { describe, it, expect, beforeAll, afterAll } from 'vitest';
   import { TestOrchestrator } from '../orchestrator';

   describe('My Feature Tests', () => {
     let orchestrator: TestOrchestrator;

     beforeAll(async () => {
       orchestrator = new TestOrchestrator({ headless: true });
       await orchestrator.startMockBootstrap();
       await orchestrator.startVpsServer();
     }, 45000);

     afterAll(async () => {
       await orchestrator.cleanup();
     });

     it('should test my feature', async () => {
       // Test implementation
     });
   });
   ```

2. Add a script to `package.json` if needed:
   ```json
   {
     "scripts": {
       "test:my-feature": "vitest run --testPathPattern=my-feature"
     }
   }
   ```

## Future Enhancements

### Flutter App Testing

Flutter app integration testing requires:

- Android emulator or iOS simulator
- Flutter driver or integration_test package
- Appium or similar automation framework

This is more complex due to:

- Device/emulator setup requirements
- Platform-specific build steps
- Longer test execution times

A potential approach:

```typescript
// Future: Flutter orchestration
async startFlutterApp(): Promise<void> {
  // Launch emulator
  // Build and install app
  // Connect via Flutter driver
}
```

### Network Condition Simulation

Future tests could simulate:

- Network latency
- Packet loss
- Connection drops
- Bandwidth limitations

Using tools like `tc` (traffic control) or proxy servers.
