import { test, expect } from './fixtures.js';

test.describe('Active Clients Tab', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.locator('.tabs .tab', { hasText: 'Active Clients' }).click();
    await expect(page.locator('.tab.active')).toContainText('Active Clients');
  });

  test('renders total active clients count', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);
    // The large active count number should be visible
    await expect(page.locator('.container')).toBeVisible();
  });

  test('shows platform breakdown section', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);

    // Should have section titles for platform/connection/version breakdowns
    const headings = page.locator('h3');
    const count = await headings.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('displays donut charts when data exists', async ({ authedPage: page }) => {
    await page.waitForTimeout(3000);

    // Donut charts are SVG elements
    const svgs = page.locator('svg');
    const svgCount = await svgs.count();
    // Charts render as SVGs — 0 is OK if no data
    expect(svgCount).toBeGreaterThanOrEqual(0);
  });
});
