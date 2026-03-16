import { test, expect } from './fixtures.js';

test.describe('Servers Tab', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.locator('.tabs .tab', { hasText: 'Servers' }).click();
    await expect(page.locator('.tab.active')).toContainText('Servers');
  });

  test('renders server tab content without crashing', async ({ authedPage: page }) => {
    // Should show stat cards or an error/empty state — not a blank page
    const content = page.locator('.container');
    await expect(content).toBeVisible();

    // Wait for API response (loading state clears)
    await page.waitForTimeout(2000);

    // Should have either stat cards or an error message
    const hasCards = await page.locator('.stat-card').count();
    const hasError = await page.locator('text=error').count();
    const hasEmpty = await page.locator('.empty-state').count();

    expect(hasCards + hasError + hasEmpty).toBeGreaterThan(0);
  });

  test('displays aggregate stat cards when data is available', async ({ authedPage: page }) => {
    // If bootstrap is connected, we should see stat cards
    const cards = page.locator('.stat-card');

    // Wait for data to load
    await page.waitForTimeout(3000);

    const cardCount = await cards.count();
    if (cardCount > 0) {
      // Should show Total Servers, Healthy, Degraded, Offline, Connections
      await expect(page.locator('.stat-card', { hasText: /total/i }).first()).toBeVisible();
    }
  });
});
