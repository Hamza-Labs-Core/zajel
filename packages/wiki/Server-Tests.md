# Server Tests

Zajel has two server implementations, each with its own test suite, plus cross-component integration tests and a web client E2E suite. All server-side tests use Vitest; integration and E2E tests use Vitest or Playwright.

## Overview

| Component | Test Path | Runner | CI Workflow |
|-----------|-----------|--------|-------------|
| CF Workers (signaling) | `packages/server/src/__tests__/` | Vitest | `server-tests.yml` |
| VPS Server | `packages/server-vps/` | Vitest (2 shards) | `server-vps-tests.yml` |
| Integration Tests | `packages/integration-tests/src/scenarios/` | Vitest + Playwright | `integration-tests.yml` |
| Web Client | `packages/web-client/` | Vitest + Playwright (2 shards) | `web-client-tests.yml` |

## CF Workers Tests

The Cloudflare Workers signaling server (`packages/server/`) has unit and E2E tests.

### Unit Tests

Located at `packages/server/src/__tests__/`:

| File | Tests |
|------|-------|
| `websocket-handler.test.js` | WebSocket message handling: registration, pairing protocol, signal relay, heartbeat, connection cleanup |
| `websocket-handler-chunks.test.js` | Chunk relay: channel content chunk forwarding between publishers and subscribers |
| `rendezvous-registry.test.js` | Rendezvous registry: meeting point registration, lookup, expiry for trusted peer reconnection |
| `relay-registry.test.js` | Relay registry: channel relay routing, subscriber management |
| `relay-registry-do.test.js` | Relay registry Durable Object: persistent relay state |
| `chunk-index.test.js` | Chunk index: content-addressable chunk storage and retrieval |

### E2E Tests

Run via `npm run test:e2e` in the server workspace. These test the full CF Workers stack including Durable Objects.

### Running Locally

```bash
# Unit tests
npm test --workspace=zajel-signaling

# E2E tests
npm run test:e2e --workspace=zajel-signaling
```

### CI Configuration (`server-tests.yml`)

Triggered on push/PR to `main`/`feature/**` when `packages/server/**` changes:

```yaml
jobs:
  unit-tests:
    steps:
      - run: npm ci
      - run: npm test --workspace=zajel-signaling

  e2e-tests:
    steps:
      - run: npm ci
      - run: npm run test:e2e --workspace=zajel-signaling
```

Concurrency group: `server-${{ github.ref }}` with cancel-in-progress.

## VPS Server Tests

The VPS signaling server (`packages/server-vps/`) has unit and integration tests. Unit tests are sharded for faster CI execution.

### Running Locally

```bash
# All tests
npm test --workspace=@zajel/server-vps

# Integration tests only
npm test --workspace=@zajel/server-vps -- tests/integration/

# Specific shard (for debugging CI shard failures)
npm test --workspace=@zajel/server-vps -- --shard=1/2
```

### CI Configuration (`server-vps-tests.yml`)

Triggered on push/PR to `main`/`feature/**` when `packages/server-vps/**` changes:

```yaml
jobs:
  unit-tests:
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2]
        total-shards: [2]
    steps:
      - run: npm ci
      - run: npm test --workspace=@zajel/server-vps -- --shard=${{ matrix.shard }}/${{ matrix.total-shards }}

  integration-tests:
    steps:
      - run: npm ci
      - run: npm test --workspace=@zajel/server-vps -- tests/integration/
```

Concurrency group: `server-vps-${{ github.ref }}` with cancel-in-progress.

Integration test results are uploaded as artifacts (`vps-integration-results`) with 7-day retention.

## Integration Tests

The cross-component integration tests (`packages/integration-tests/`) validate the signaling protocol end-to-end by spinning up a real VPS server and connecting clients.

### Test Scenarios

| File | Tests |
|------|-------|
| `pairing-flow.test.ts` | Full pairing lifecycle: registration, code exchange, pair request, accept, match, WebRTC signal relay |
| `web-to-web.test.ts` | Two Playwright browser instances connect via the web client, pair, and exchange messages |

### Support Files

| File | Purpose |
|------|---------|
| `orchestrator.ts` | Test orchestrator: starts VPS server, manages lifecycle |
| `test-constants.ts` | Shared test constants |
| `index.ts` | Package entry point |

### Running Locally

```bash
# Pairing flow tests
npm run test:pairing --workspace=@zajel/integration-tests

# Web-to-web tests (requires Playwright + Chromium)
cd packages/web-client && npx playwright install --with-deps chromium
npm run test:web-to-web --workspace=@zajel/integration-tests
```

### CI Configuration (`integration-tests.yml`)

Triggered on push/PR to `main`/`feature/**` when `packages/integration-tests/**`, `packages/server-vps/**`, or `packages/web-client/**` change:

```yaml
jobs:
  setup:
    steps:
      - run: npm ci
      - run: npm run build --workspace=@zajel/server-vps
      - run: npm run build --workspace=@zajel/web-client

  pairing-flow:
    needs: setup
    steps:
      - run: npm run test:pairing --workspace=@zajel/integration-tests

  web-to-web:
    needs: setup
    steps:
      - run: npx playwright install --with-deps chromium
      - run: npm run test:web-to-web --workspace=@zajel/integration-tests
```

Uses artifact caching: `node_modules` and `server-vps/dist` are cached between jobs. The web client build is uploaded as an artifact for the web-to-web job.

Concurrency group: `integration-${{ github.ref }}` with cancel-in-progress.

Web-to-web test results uploaded as `web-to-web-results` with 7-day retention.

## Web Client Tests

The web client (`packages/web-client/`) has Vitest unit tests and Playwright E2E tests.

### Unit Tests

Run via `npm run test:run`:

```bash
npm run test:run --workspace=@zajel/web-client
```

### Playwright E2E (Chromium only)

The E2E suite uses Playwright with Chromium. Firefox and WebKit are excluded because the Web Crypto API requires a secure context that these browsers do not provide for localhost, even with HTTPS or 127.0.0.1.

Tests are sharded into 2 parallel matrix jobs:

```bash
cd packages/web-client
npx playwright install --with-deps chromium
npx playwright test --project=chromium --shard=1/2
```

### CI Configuration (`web-client-tests.yml`)

Triggered on push/PR to `main`/`feature/**` when `packages/web-client/**` changes:

```yaml
jobs:
  unit-tests:
    timeout-minutes: 10
    steps:
      - run: npm ci
      - run: npm run test:run --workspace=@zajel/web-client

  build:
    timeout-minutes: 10
    steps:
      - run: npm ci
      - run: npm run build --workspace=@zajel/web-client

  e2e-chromium:
    needs: build
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2]
        total-shards: [2]
    steps:
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test --project=chromium --shard=${{ matrix.shard }}/${{ matrix.total-shards }}
```

Playwright test results and reports uploaded as `playwright-chromium-shard-N` with 7-day retention.

Concurrency group: `web-client-${{ github.ref }}` with cancel-in-progress.

## PR Pipeline Server Tests

The PR Pipeline (`pr-pipeline.yml`) also runs server tests as part of Phase 1:

```yaml
server-tests:
  steps:
    - name: Test server-vps
      run: npm test -- --run

    - name: Test server (CF)
      run: npm test -- --run
```

And headless client tests:

```yaml
headless-client-tests:
  steps:
    - run: pip install -e packages/headless-client[dev]
    - run: pytest packages/headless-client/tests/ -v --timeout=30
    - run: pytest tests/test_channels_headless.py tests/test_groups_headless.py -v --timeout=60
```

## Test Patterns

### Vitest with Workers

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { handleWebSocketMessage } from '../websocket-handler';

describe('WebSocket Handler', () => {
  let mockWebSocket;

  beforeEach(() => {
    mockWebSocket = {
      send: vi.fn(),
      close: vi.fn(),
    };
  });

  it('handles registration message', () => {
    const message = JSON.stringify({
      type: 'register',
      code: 'ABC123',
      publicKey: 'base64key...',
    });
    handleWebSocketMessage(mockWebSocket, message);
    expect(mockWebSocket.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"registered"')
    );
  });
});
```

### Integration Test with Server Orchestrator

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestOrchestrator } from '../orchestrator';

describe('Pairing Flow', () => {
  let orchestrator: TestOrchestrator;

  beforeAll(async () => {
    orchestrator = new TestOrchestrator();
    await orchestrator.start();
  });

  afterAll(async () => {
    await orchestrator.stop();
  });

  it('completes full pairing flow', async () => {
    const alice = await orchestrator.createClient();
    const bob = await orchestrator.createClient();

    await alice.register();
    await bob.register();

    await alice.pairWith(bob.code);
    // ...
  });
});
```

## Sharding Strategy

Sharding is used in two places to reduce CI wall-clock time:

| Suite | Shards | Purpose |
|-------|--------|---------|
| VPS Server unit tests | 2 | Split large test suite across 2 runners |
| Playwright web client E2E | 2 | Split browser tests across 2 runners |

Both use `fail-fast: false` so that all shards run even if one fails, maximizing diagnostic information.
