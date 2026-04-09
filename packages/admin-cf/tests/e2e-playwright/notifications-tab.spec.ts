import { test, expect } from './fixtures.js';

test.describe('Notifications Tab', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.locator('.tabs .tab', { hasText: 'Notifications' }).click();
    await expect(page.locator('.tab.active')).toContainText('Notifications');
    // Wait for data load
    await page.waitForTimeout(3000);
  });

  test('renders notification summary cards', async ({ authedPage: page }) => {
    const cards = page.locator('.stat-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('shows email configuration heading', async ({ authedPage: page }) => {
    await expect(page.locator('h3', { hasText: 'Email Configuration' })).toBeVisible();
  });

  test('shows webhook configuration heading', async ({ authedPage: page }) => {
    await expect(page.locator('h3', { hasText: 'Webhook Configuration' })).toBeVisible();
  });

  test('shows alert rules heading', async ({ authedPage: page }) => {
    await expect(page.locator('h3', { hasText: 'Alert Rules' })).toBeVisible();
  });

  test('shows alert history heading', async ({ authedPage: page }) => {
    await expect(page.locator('h3', { hasText: 'Alert History' })).toBeVisible();
  });

  test('save configuration button exists', async ({ authedPage: page }) => {
    const saveBtn = page.getByRole('button', { name: /save/i });
    await expect(saveBtn).toBeVisible();
  });

  test('test notification button exists', async ({ authedPage: page }) => {
    const testBtn = page.getByRole('button', { name: /test/i });
    await expect(testBtn).toBeVisible();
  });
});
