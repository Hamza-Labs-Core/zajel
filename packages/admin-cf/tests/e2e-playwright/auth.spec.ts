import { test, expect, ADMIN_USER, ADMIN_PASS, loginViaUI } from './fixtures.js';

test.describe('Authentication', () => {
  test('shows login form when unauthenticated', async ({ page }) => {
    await page.goto('/admin/');
    await page.evaluate(() => localStorage.removeItem('zajel_admin_token'));
    await page.reload();

    await expect(page.locator('input[name="username"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('rejects invalid credentials', async ({ page }) => {
    await page.goto('/admin/');
    await page.evaluate(() => localStorage.removeItem('zajel_admin_token'));
    await page.reload();

    await page.fill('input[name="username"]', 'wrong-user');
    await page.fill('input[name="password"]', 'wrong-password');
    await page.click('button[type="submit"]');

    await expect(page.locator('.error-message')).toBeVisible({ timeout: 5000 });
  });

  test('logs in with valid credentials and shows dashboard', async ({ page }) => {
    await loginViaUI(page);
    await expect(page.locator('.tabs')).toBeVisible();
    await expect(page.locator('.user-badge')).toContainText(ADMIN_USER);
  });

  test('persists session via token injection', async ({ authedPage: page }) => {
    // Token was injected by fixture — reload should keep us authenticated
    await page.reload();
    await expect(page.locator('.tabs')).toBeVisible({ timeout: 10_000 });
  });

  test('logout returns to login form', async ({ authedPage: page }) => {
    await page.getByRole('button', { name: /logout/i }).click();
    await expect(page.locator('input[name="username"]')).toBeVisible({ timeout: 5000 });
  });

  test('dashboard shows user badge', async ({ authedPage: page }) => {
    await expect(page.locator('.user-badge')).toBeVisible();
    const badge = await page.locator('.user-badge').textContent();
    expect(badge).toContain(ADMIN_USER);
  });
});
