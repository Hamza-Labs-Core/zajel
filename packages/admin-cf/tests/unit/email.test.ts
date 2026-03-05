/**
 * Unit tests for email notification construction (US-8.2)
 */

import { describe, it, expect } from 'vitest';
import {
  buildEmailSubject,
  buildEmailHtml,
  buildRawMimeEmail,
  getSenderEmail,
  severityLevel,
  passesSeverityFilter,
  hashEmail,
} from '../../src/email.js';

const sampleNotification = {
  severity: 'critical' as const,
  title: 'Server srv-01 offline',
  message: 'Server srv-01 has not sent a heartbeat for 5 minutes.',
  category: 'server_offline' as const,
};

const dashboardUrl = 'https://admin.zajel.hamzalabs.dev';
const unsubscribeUrl = 'https://admin.zajel.hamzalabs.dev/admin/api/notifications/unsubscribe?token=test-jwt';

describe('buildEmailSubject', () => {
  it('formats subject with severity and title', () => {
    const subject = buildEmailSubject(sampleNotification);
    expect(subject).toBe('[Zajel Alert - CRITICAL] Server srv-01 offline');
  });

  it('formats subject for warning severity', () => {
    const subject = buildEmailSubject({ ...sampleNotification, severity: 'warning' });
    expect(subject).toBe('[Zajel Alert - WARNING] Server srv-01 offline');
  });

  it('formats subject for info severity', () => {
    const subject = buildEmailSubject({ ...sampleNotification, severity: 'info' });
    expect(subject).toBe('[Zajel Alert - INFO] Server srv-01 offline');
  });
});

describe('buildEmailHtml', () => {
  it('returns valid HTML with severity badge', () => {
    const html = buildEmailHtml(sampleNotification, dashboardUrl, unsubscribeUrl);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Zajel Admin Alert');
    expect(html).toContain('critical'); // severity badge text
    expect(html).toContain('Server srv-01 offline'); // title
    expect(html).toContain('Server srv-01 has not sent a heartbeat'); // message
    expect(html).toContain('View in Dashboard'); // CTA button
    expect(html).toContain(dashboardUrl); // dashboard link
    expect(html).toContain('Unsubscribe'); // unsubscribe link
    expect(html).toContain(unsubscribeUrl);
  });

  it('contains severity-specific badge color for critical', () => {
    const html = buildEmailHtml(sampleNotification, dashboardUrl, unsubscribeUrl);
    expect(html).toContain('#EF4444'); // red for critical
  });

  it('contains severity-specific badge color for warning', () => {
    const html = buildEmailHtml(
      { ...sampleNotification, severity: 'warning' },
      dashboardUrl,
      unsubscribeUrl
    );
    expect(html).toContain('#EAB308'); // yellow for warning
  });

  it('contains severity-specific badge color for info', () => {
    const html = buildEmailHtml(
      { ...sampleNotification, severity: 'info' },
      dashboardUrl,
      unsubscribeUrl
    );
    expect(html).toContain('#3B82F6'); // blue for info
  });

  it('escapes HTML special characters in title and message', () => {
    const html = buildEmailHtml(
      {
        ...sampleNotification,
        title: 'Alert <script>',
        message: 'Rate > 100 & rising',
      },
      dashboardUrl,
      unsubscribeUrl
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Rate &gt; 100 &amp; rising');
    expect(html).not.toContain('<script>');
  });
});

describe('buildRawMimeEmail', () => {
  it('constructs valid MIME email with headers', () => {
    const raw = buildRawMimeEmail(
      'notifications@zajel.hamzalabs.dev',
      'admin@example.com',
      '[Zajel Alert - CRITICAL] Test',
      '<html><body>Hello</body></html>'
    );

    expect(raw).toContain('From: notifications@zajel.hamzalabs.dev');
    expect(raw).toContain('To: admin@example.com');
    expect(raw).toContain('Subject: [Zajel Alert - CRITICAL] Test');
    expect(raw).toContain('MIME-Version: 1.0');
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).toContain('Content-Type: text/plain');
    expect(raw).toContain('Content-Type: text/html');
    expect(raw).toContain('<html><body>Hello</body></html>');
  });

  it('includes text/plain fallback', () => {
    const raw = buildRawMimeEmail(
      'from@test.com',
      'to@test.com',
      'Test',
      '<html><body><p>Hello World</p></body></html>'
    );

    // Plain text section should contain stripped content
    expect(raw).toContain('Hello World');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
  });
});

describe('getSenderEmail', () => {
  it('returns env var if set', () => {
    expect(getSenderEmail('custom@example.com')).toBe('custom@example.com');
  });

  it('returns default if env var undefined', () => {
    expect(getSenderEmail(undefined)).toBe('notifications@zajel.hamzalabs.dev');
  });

  it('returns default if env var empty', () => {
    expect(getSenderEmail('')).toBe('notifications@zajel.hamzalabs.dev');
  });
});

describe('severityLevel', () => {
  it('ranks critical highest', () => {
    expect(severityLevel('critical')).toBe(3);
  });

  it('ranks warning in middle', () => {
    expect(severityLevel('warning')).toBe(2);
  });

  it('ranks info lowest', () => {
    expect(severityLevel('info')).toBe(1);
  });

  it('returns 0 for unknown', () => {
    expect(severityLevel('unknown')).toBe(0);
  });
});

describe('passesSeverityFilter', () => {
  it('critical notification passes all filters', () => {
    expect(passesSeverityFilter('critical', 'critical')).toBe(true);
    expect(passesSeverityFilter('critical', 'warning')).toBe(true);
    expect(passesSeverityFilter('critical', 'info')).toBe(true);
  });

  it('warning notification passes warning and info filters', () => {
    expect(passesSeverityFilter('warning', 'critical')).toBe(false);
    expect(passesSeverityFilter('warning', 'warning')).toBe(true);
    expect(passesSeverityFilter('warning', 'info')).toBe(true);
  });

  it('info notification only passes info filter', () => {
    expect(passesSeverityFilter('info', 'critical')).toBe(false);
    expect(passesSeverityFilter('info', 'warning')).toBe(false);
    expect(passesSeverityFilter('info', 'info')).toBe(true);
  });
});

describe('hashEmail', () => {
  it('returns a hex string', async () => {
    const hash = await hashEmail('admin@example.com');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns consistent hash for same email', async () => {
    const hash1 = await hashEmail('admin@example.com');
    const hash2 = await hashEmail('admin@example.com');
    expect(hash1).toBe(hash2);
  });

  it('is case-insensitive', async () => {
    const hash1 = await hashEmail('Admin@Example.com');
    const hash2 = await hashEmail('admin@example.com');
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different emails', async () => {
    const hash1 = await hashEmail('admin@example.com');
    const hash2 = await hashEmail('other@example.com');
    expect(hash1).not.toBe(hash2);
  });
});
