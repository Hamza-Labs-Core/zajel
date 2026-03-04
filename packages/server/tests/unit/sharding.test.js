import { describe, it, expect } from 'vitest';
import {
  getServerRegistryShardId,
  KNOWN_REGIONS,
} from '../../src/sharding/server-registry-sharding.js';
import {
  getAttestationShardId,
  extractDeviceIdFromRequest,
} from '../../src/sharding/attestation-sharding.js';

describe('Server Registry Sharding', () => {
  const mockEnv = {
    SERVER_REGISTRY: {
      idFromName: (name) => ({ name, type: 'server-registry' }),
    },
  };

  it('should route known regions to regional shards', () => {
    const id = getServerRegistryShardId(mockEnv, 'us-east');
    expect(id.name).toBe('region:us-east');
  });

  it('should route unknown regions to default shard', () => {
    // 'unknown-region' is not in KNOWN_REGIONS, so it must fall back to default
    const id = getServerRegistryShardId(mockEnv, 'unknown-region');
    expect(id.name).toBe('region:default');
  });

  it('should route null region to default shard', () => {
    const id = getServerRegistryShardId(mockEnv, null);
    expect(id.name).toBe('region:default');
  });

  it('should route invalid region names to default shard', () => {
    const id = getServerRegistryShardId(mockEnv, 'invalid region!');
    expect(id.name).toBe('region:default');
  });

  it('should route empty string region to default shard', () => {
    const id = getServerRegistryShardId(mockEnv, '');
    expect(id.name).toBe('region:default');
  });

  it('should route arbitrary alphanumeric regions to default shard (not in KNOWN_REGIONS)', () => {
    // Even regions matching the old regex but not in KNOWN_REGIONS should go to default
    const id = getServerRegistryShardId(mockEnv, 'brazil');
    expect(id.name).toBe('region:default');

    const id2 = getServerRegistryShardId(mockEnv, 'us-east-2');
    expect(id2.name).toBe('region:default');
  });

  it('should have at least 6 known regions', () => {
    expect(KNOWN_REGIONS.length).toBeGreaterThanOrEqual(6);
    expect(KNOWN_REGIONS).toContain('default');
  });

  it('should include all expected known regions', () => {
    expect(KNOWN_REGIONS).toContain('us-east');
    expect(KNOWN_REGIONS).toContain('us-west');
    expect(KNOWN_REGIONS).toContain('eu-west');
    expect(KNOWN_REGIONS).toContain('eu-central');
    expect(KNOWN_REGIONS).toContain('ap-southeast');
    expect(KNOWN_REGIONS).toContain('ap-northeast');
    expect(KNOWN_REGIONS).toContain('default');
  });
});

describe('Attestation Registry Sharding', () => {
  const mockEnv = {
    ATTESTATION_REGISTRY: {
      idFromName: (name) => ({ name, type: 'attestation-registry' }),
    },
  };

  it('should route device_id to shard by first 2 hex chars', () => {
    const id = getAttestationShardId(mockEnv, 'a1b2c3d4e5f6');
    expect(id.name).toBe('device-shard:a1');
  });

  it('should handle uppercase device_id', () => {
    const id = getAttestationShardId(mockEnv, 'A1B2C3D4');
    expect(id.name).toBe('device-shard:a1');
  });

  it('should route to shard 00 for invalid device_id', () => {
    const id = getAttestationShardId(mockEnv, 'invalid');
    expect(id.name).toBe('device-shard:00');
  });

  it('should route to shard 00 for null device_id', () => {
    const id = getAttestationShardId(mockEnv, null);
    expect(id.name).toBe('device-shard:00');
  });

  it('should distribute across 256 shards', () => {
    const shards = new Set();

    // Generate device IDs with all possible first 2 hex chars
    for (let i = 0; i < 256; i++) {
      const prefix = i.toString(16).padStart(2, '0');
      const deviceId = `${prefix}aabbccdd`;
      const id = getAttestationShardId(mockEnv, deviceId);
      shards.add(id.name);
    }

    expect(shards.size).toBe(256);
  });
});

describe('extractDeviceIdFromRequest', () => {
  it('should extract device_id from valid JSON request', async () => {
    const request = new Request('http://test/attest/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'a1b2c3d4e5f6' }),
    });

    const deviceId = await extractDeviceIdFromRequest(request);
    expect(deviceId).toBe('a1b2c3d4e5f6');

    // Verify original request body is not consumed
    const body = await request.json();
    expect(body.device_id).toBe('a1b2c3d4e5f6');
  });

  it('should return null for non-JSON content type', async () => {
    const request = new Request('http://test/attest/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    });

    const deviceId = await extractDeviceIdFromRequest(request);
    expect(deviceId).toBeNull();
  });

  it('should return null for invalid JSON body', async () => {
    const request = new Request('http://test/attest/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json {{{',
    });

    const deviceId = await extractDeviceIdFromRequest(request);
    expect(deviceId).toBeNull();
  });

  it('should return null when device_id is missing from body', async () => {
    const request = new Request('http://test/attest/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ other_field: 'value' }),
    });

    const deviceId = await extractDeviceIdFromRequest(request);
    expect(deviceId).toBeNull();
  });

  it('should return null when Content-Type header is missing', async () => {
    const request = new Request('http://test/attest/challenge', {
      method: 'POST',
      body: JSON.stringify({ device_id: 'abc123' }),
    });

    const deviceId = await extractDeviceIdFromRequest(request);
    expect(deviceId).toBeNull();
  });
});
