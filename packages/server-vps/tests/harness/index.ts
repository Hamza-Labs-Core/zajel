/**
 * Test Harness Exports
 *
 * Provides utilities for running real VPS server instances in integration tests.
 * Can be imported by other packages for end-to-end testing.
 */

// Server harness for starting/stopping real VPS server instances
export {
  TestServerHarness,
  createServerCluster,
  startCluster,
  stopCluster,
  type TestServerHarnessOptions,
  type ServerLog,
} from './server-harness.js';

// Mock bootstrap server for simulating CF Workers API
export {
  MockBootstrapServer,
  createMockBootstrap,
  type MockBootstrapOptions,
  type MockBootstrapStats,
  type BootstrapServerEntry,
} from './mock-bootstrap.js';
