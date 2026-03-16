import { test, expect } from './fixtures.js';

test.describe('Errors Tab', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.locator('.tabs .tab', { hasText: 'Errors' }).click();
    await expect(page.locator('.tab.active')).toContainText('Errors');
  });

  test('renders error summary cards', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);
    const cards = page.locator('.stat-card');
    await expect(cards.first()).toBeVisible();

    // Should have at minimum: Total Errors, Rate Change, Regressions, Severity
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('shows range selector with 3 options', async ({ authedPage: page }) => {
    const rangeButtons = page.locator('.range-btn');
    await expect(rangeButtons).toHaveCount(3);
    await expect(page.locator('.range-btn', { hasText: '1h' })).toBeVisible();
    await expect(page.locator('.range-btn', { hasText: '24h' })).toBeVisible();
    await expect(page.locator('.range-btn', { hasText: '7d' })).toBeVisible();
  });

  test('switching range updates data', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);

    // Click 1h range
    await page.locator('.range-btn', { hasText: '1h' }).click();
    await page.waitForTimeout(1500);

    // Click 7d range
    await page.locator('.range-btn', { hasText: '7d' }).click();
    await page.waitForTimeout(1500);

    // Page should still render without errors
    await expect(page.locator('.stat-card').first()).toBeVisible();
  });

  test('shows errors table or empty state', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);

    const table = page.locator('.data-table');
    const emptyState = page.locator('.empty-state');

    const tableVisible = await table.isVisible().catch(() => false);
    const emptyVisible = await emptyState.isVisible().catch(() => false);

    // One of the two must be present
    expect(tableVisible || emptyVisible).toBe(true);
  });
});
