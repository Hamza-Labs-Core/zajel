import { test, expect } from './fixtures.js';

const TABS = [
  { id: 'servers', label: 'Servers' },
  { id: 'users', label: 'Users' },
  { id: 'errors', label: 'Errors' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'clients', label: 'Active Clients' },
  { id: 'health', label: 'Server Health' },
  { id: 'security', label: 'Security' },
  { id: 'ai-issues', label: 'AI Issues' },
  { id: 'notifications', label: 'Notifications' },
] as const;

test.describe('Tab Navigation', () => {
  test('renders all 9 tabs', async ({ authedPage: page }) => {
    const tabs = page.locator('.tabs .tab');
    await expect(tabs).toHaveCount(TABS.length);

    for (const tab of TABS) {
      await expect(page.locator('.tabs .tab', { hasText: tab.label })).toBeVisible();
    }
  });

  test('defaults to servers tab', async ({ authedPage: page }) => {
    const activeTab = page.locator('.tab.active');
    await expect(activeTab).toContainText('Servers');
  });

  for (const tab of TABS) {
    test(`navigates to ${tab.label} tab`, async ({ authedPage: page }) => {
      await page.locator('.tabs .tab', { hasText: tab.label }).click();

      // Active tab should update
      await expect(page.locator('.tab.active')).toContainText(tab.label);

      // Hash should update
      const hash = await page.evaluate(() => window.location.hash);
      expect(hash).toBe(`#/${tab.id}`);
    });
  }

  test('restores tab from URL hash on load', async ({ authedPage: page }) => {
    await page.goto('/admin/#/security');
    await expect(page.locator('.tab.active')).toContainText('Security');
  });

  test('handles invalid hash gracefully', async ({ authedPage: page }) => {
    await page.goto('/admin/#/nonexistent');
    // Should fall back to servers tab
    await expect(page.locator('.tab.active')).toContainText('Servers');
  });
});
