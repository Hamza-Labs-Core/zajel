/**
 * Unit tests for AES-GCM webhook config encryption (US-8.3)
 */

import { describe, it, expect } from 'vitest';
import { encryptWebhookConfig, decryptWebhookConfig } from '../../src/crypto.js';

const testSecret = 'super-secret-jwt-key-for-testing-purposes-12345';

describe('encryptWebhookConfig / decryptWebhookConfig', () => {
  it('round-trips a simple config string', async () => {
    const config = JSON.stringify({
      url: 'https://hooks.slack.com/services/T00/B00/xxxxx',
      authHeader: 'Bearer slack-token',
    });

    const encrypted = await encryptWebhookConfig(config, testSecret);
    const decrypted = await decryptWebhookConfig(encrypted, testSecret);

    expect(decrypted).toBe(config);
  });

  it('returns base64-encoded ciphertext', async () => {
    const config = '{"url":"https://example.com"}';
    const encrypted = await encryptWebhookConfig(config, testSecret);

    // Should be a valid base64 string
    expect(() => atob(encrypted)).not.toThrow();
    // Should not be the same as the plaintext
    expect(encrypted).not.toBe(config);
  });

  it('produces different ciphertexts for the same input (random IV)', async () => {
    const config = '{"url":"https://example.com"}';

    const encrypted1 = await encryptWebhookConfig(config, testSecret);
    const encrypted2 = await encryptWebhookConfig(config, testSecret);

    // Different IVs should produce different ciphertexts
    expect(encrypted1).not.toBe(encrypted2);

    // But both should decrypt to the same value
    const decrypted1 = await decryptWebhookConfig(encrypted1, testSecret);
    const decrypted2 = await decryptWebhookConfig(encrypted2, testSecret);
    expect(decrypted1).toBe(config);
    expect(decrypted2).toBe(config);
  });

  it('fails to decrypt with wrong secret', async () => {
    const config = '{"url":"https://example.com"}';
    const encrypted = await encryptWebhookConfig(config, testSecret);

    await expect(
      decryptWebhookConfig(encrypted, 'wrong-secret-key-totally-different')
    ).rejects.toThrow();
  });

  it('fails to decrypt tampered ciphertext', async () => {
    const config = '{"url":"https://example.com"}';
    const encrypted = await encryptWebhookConfig(config, testSecret);

    // Tamper with the ciphertext
    const decoded = atob(encrypted);
    const tampered = decoded.slice(0, -2) + 'XX';
    const reencoded = btoa(tampered);

    await expect(
      decryptWebhookConfig(reencoded, testSecret)
    ).rejects.toThrow();
  });

  it('handles empty string', async () => {
    const encrypted = await encryptWebhookConfig('', testSecret);
    const decrypted = await decryptWebhookConfig(encrypted, testSecret);
    expect(decrypted).toBe('');
  });

  it('handles large config objects', async () => {
    const config = JSON.stringify({
      url: 'https://hooks.slack.com/services/T00/B00/xxxxx',
      authHeader: 'Bearer ' + 'x'.repeat(1000),
      label: 'A very long label that goes on and on',
      format: 'slack',
      severityFilter: 'critical',
      cooldownMinutes: 5,
    });

    const encrypted = await encryptWebhookConfig(config, testSecret);
    const decrypted = await decryptWebhookConfig(encrypted, testSecret);
    expect(decrypted).toBe(config);
  });

  it('handles unicode characters', async () => {
    const config = JSON.stringify({
      url: 'https://example.com',
      label: 'Alerte urgente',
    });

    const encrypted = await encryptWebhookConfig(config, testSecret);
    const decrypted = await decryptWebhookConfig(encrypted, testSecret);
    expect(decrypted).toBe(config);
  });
});
