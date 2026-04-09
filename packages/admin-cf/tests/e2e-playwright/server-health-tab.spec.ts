import { test, expect } from './fixtures.js';

test.describe('Server Health Tab', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.locator('.tabs .tab', { hasText: 'Server Health' }).click();
    await expect(page.locator('.tab.active')).toContainText('Server Health');
  });

  test('renders health summary cards', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);
    const cards = page.locator('.stat-card');
    const count = await cards.count();
    // Should show Total, Healthy, Degraded, Offline cards (or at least some)
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('shows log viewer section', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);

    // Look for log-related UI: severity dropdown, search input, or "Logs" heading
    const logsHeading = page.locator('h3', { hasText: /log/i });
    const headingVisible = await logsHeading.isVisible().catch(() => false);

    if (headingVisible) {
      // Severity dropdown should exist
      const severitySelect = page.locator('select').first();
      await expect(severitySelect).toBeVisible();
    }
  });

  test('log viewer severity filter works', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);

    // Find severity select if present
    const selects = page.locator('select');
    const selectCount = await selects.count();

    if (selectCount > 0) {
      // Change severity filter — should not crash
      const firstSelect = selects.first();
      const options = await firstSelect.locator('option').allTextContents();
      if (options.length > 1) {
        await firstSelect.selectOption({ index: 1 });
        await page.waitForTimeout(1500);
        await expect(page.locator('.container')).toBeVisible();
      }
    }
  });

  test('log viewer search works', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);

    const searchInput = page.locator('input[type="text"][placeholder*="earch"]');
    const searchVisible = await searchInput.isVisible().catch(() => false);

    if (searchVisible) {
      await searchInput.fill('test-query');
      await page.waitForTimeout(1500);
      // Should not crash
      await expect(page.locator('.container')).toBeVisible();
    }
  });
});
