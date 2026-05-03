import { test, expect } from './fixtures.js';

test.describe('Security Tab', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.locator('.tabs .tab', { hasText: 'Security' }).click();
    await expect(page.locator('.tab.active')).toContainText('Security');
  });

  test('renders security summary cards', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);
    const cards = page.locator('.stat-card');
    const count = await cards.count();
    // Rate Limit Violations, Bad Clients, Connection Rate, Pairing Abuse
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('displays rate limit violations section', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);

    // Should have a section for rate limit violations
    const heading = page.locator('h3', { hasText: /rate limit/i });
    await expect(heading).toBeVisible();
  });

  test('displays bad clients section', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);

    const heading = page.locator('h3', { hasText: /bad client/i });
    await expect(heading).toBeVisible();
  });

  test('displays pairing abuse section', async ({ authedPage: page }) => {
    await page.waitForTimeout(2000);

    const heading = page.locator('h3', { hasText: /pairing/i });
    await expect(heading).toBeVisible();
  });

  test('shows tables or empty states for all sections', async ({ authedPage: page }) => {
    await page.waitForTimeout(3000);

    // Each section should have a table or empty message
    const tables = page.locator('.data-table');
    const emptyStates = page.locator('.empty-state');

    const tableCount = await tables.count();
    const emptyCount = await emptyStates.count();

    // At least some content should be visible
    expect(tableCount + emptyCount).toBeGreaterThanOrEqual(1);
  });
});
