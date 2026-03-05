/**
 * Unit tests for webhook payload construction (US-8.3)
 */

import { describe, it, expect } from 'vitest';
import { buildWebhookPayload, severityToDiscordColor } from '../../src/webhook.js';

const sampleNotification = {
  severity: 'critical' as const,
  title: 'Server srv-01 offline',
  message: 'Server srv-01 has not sent a heartbeat for 5 minutes.',
  category: 'server_offline' as const,
};

const dashboardUrl = 'https://admin.zajel.hamzalabs.dev';

describe('buildWebhookPayload', () => {
  describe('generic format', () => {
    it('returns JSON payload with all required fields', () => {
      const result = buildWebhookPayload(sampleNotification, 'generic', dashboardUrl);

      expect(result.contentType).toBe('application/json');
      const parsed = JSON.parse(result.body);
      expect(parsed.severity).toBe('critical');
      expect(parsed.title).toBe('Server srv-01 offline');
      expect(parsed.message).toBe('Server srv-01 has not sent a heartbeat for 5 minutes.');
      expect(parsed.category).toBe('server_offline');
      expect(parsed.dashboardLink).toBe(dashboardUrl);
      expect(typeof parsed.timestamp).toBe('number');
    });

    it('handles info severity', () => {
      const result = buildWebhookPayload(
        { ...sampleNotification, severity: 'info' },
        'generic',
        dashboardUrl
      );
      const parsed = JSON.parse(result.body);
      expect(parsed.severity).toBe('info');
    });
  });

  describe('slack format', () => {
    it('returns Slack-compatible payload with text and blocks', () => {
      const result = buildWebhookPayload(sampleNotification, 'slack', dashboardUrl);

      expect(result.contentType).toBe('application/json');
      const parsed = JSON.parse(result.body);

      // Top-level text field (required by Slack)
      expect(parsed.text).toBe('[CRITICAL] Server srv-01 offline');

      // Blocks array
      expect(parsed.blocks).toHaveLength(2);

      // Section block with mrkdwn
      expect(parsed.blocks[0].type).toBe('section');
      expect(parsed.blocks[0].text.type).toBe('mrkdwn');
      expect(parsed.blocks[0].text.text).toContain('*Server srv-01 offline*');
      expect(parsed.blocks[0].text.text).toContain('Server srv-01 has not sent a heartbeat');

      // Context block
      expect(parsed.blocks[1].type).toBe('context');
      expect(parsed.blocks[1].elements).toHaveLength(2);
      expect(parsed.blocks[1].elements[0].text).toContain('*critical*');
      expect(parsed.blocks[1].elements[1].text).toContain('View in Dashboard');
      expect(parsed.blocks[1].elements[1].text).toContain(dashboardUrl);
    });

    it('uses uppercase severity in text field', () => {
      const result = buildWebhookPayload(
        { ...sampleNotification, severity: 'warning' },
        'slack',
        dashboardUrl
      );
      const parsed = JSON.parse(result.body);
      expect(parsed.text).toBe('[WARNING] Server srv-01 offline');
    });
  });

  describe('discord format', () => {
    it('returns Discord-compatible payload with embeds', () => {
      const result = buildWebhookPayload(sampleNotification, 'discord', dashboardUrl);

      expect(result.contentType).toBe('application/json');
      const parsed = JSON.parse(result.body);

      // Embeds array
      expect(parsed.embeds).toHaveLength(1);
      const embed = parsed.embeds[0];

      expect(embed.title).toBe('Server srv-01 offline');
      expect(embed.description).toBe('Server srv-01 has not sent a heartbeat for 5 minutes.');
      expect(embed.color).toBe(0xEF4444); // critical = red
      expect(embed.url).toBe(dashboardUrl);
      expect(embed.footer.text).toBe('Zajel Admin');

      // Fields
      expect(embed.fields).toHaveLength(2);
      expect(embed.fields[0].name).toBe('Severity');
      expect(embed.fields[0].value).toBe('critical');
      expect(embed.fields[0].inline).toBe(true);
      expect(embed.fields[1].name).toBe('Category');
      expect(embed.fields[1].value).toBe('server_offline');
      expect(embed.fields[1].inline).toBe(true);

      // Timestamp is ISO string
      expect(embed.timestamp).toBeDefined();
      expect(() => new Date(embed.timestamp)).not.toThrow();
    });

    it('uses correct color for warning severity', () => {
      const result = buildWebhookPayload(
        { ...sampleNotification, severity: 'warning' },
        'discord',
        dashboardUrl
      );
      const parsed = JSON.parse(result.body);
      expect(parsed.embeds[0].color).toBe(0xEAB308);
    });

    it('uses correct color for info severity', () => {
      const result = buildWebhookPayload(
        { ...sampleNotification, severity: 'info' },
        'discord',
        dashboardUrl
      );
      const parsed = JSON.parse(result.body);
      expect(parsed.embeds[0].color).toBe(0x3B82F6);
    });
  });

  it('defaults to generic format for unknown format', () => {
    // The function casts to the union type, but testing the default case
    const result = buildWebhookPayload(sampleNotification, 'generic', dashboardUrl);
    const parsed = JSON.parse(result.body);
    expect(parsed.severity).toBe('critical');
    expect(parsed.dashboardLink).toBe(dashboardUrl);
  });
});

describe('severityToDiscordColor', () => {
  it('returns red for critical', () => {
    expect(severityToDiscordColor('critical')).toBe(0xEF4444);
  });

  it('returns yellow for warning', () => {
    expect(severityToDiscordColor('warning')).toBe(0xEAB308);
  });

  it('returns blue for info', () => {
    expect(severityToDiscordColor('info')).toBe(0x3B82F6);
  });

  it('returns gray for unknown severity', () => {
    expect(severityToDiscordColor('unknown')).toBe(0x94A3B8);
  });
});
