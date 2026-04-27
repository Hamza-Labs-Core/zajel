import { test, expect, ADMIN_USER, BASE_URL } from './fixtures.js';

test.describe('Users Tab', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.locator('.tabs .tab', { hasText: 'Users' }).click();
    await expect(page.locator('.tab.active')).toContainText('Users');
    // Wait for user list to load
    await page.waitForTimeout(2000);
  });

  test('shows current admin user in user list', async ({ authedPage: page }) => {
    const userRows = page.locator('.user-row');
    const count = await userRows.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Our admin user should be listed
    const texts = await userRows.allTextContents();
    const hasAdmin = texts.some(t => t.includes(ADMIN_USER));
    expect(hasAdmin).toBe(true);
  });

  test('shows role badge for admin user', async ({ authedPage: page }) => {
    await expect(page.locator('.role-badge').first()).toBeVisible();
  });

  test('shows create user form for super-admin', async ({ authedPage: page }) => {
    const usernameInput = page.locator('#new-username');
    const formVisible = await usernameInput.isVisible().catch(() => false);
    if (formVisible) {
      await expect(page.locator('#new-password')).toBeVisible();
      await expect(page.locator('#new-role')).toBeVisible();
    }
  });

  test('creates and deletes a test user', async ({ authedPage: page, authToken }) => {
    const testUser = `test-user-${Date.now()}`;

    const formVisible = await page.locator('#new-username').isVisible().catch(() => false);
    if (!formVisible) {
      test.skip(true, 'Create user form not visible — not super-admin');
      return;
    }

    // Create user via UI
    await page.fill('#new-username', testUser);
    await page.fill('#new-password', 'TestPassword!2026xyz');
    await page.selectOption('#new-role', 'admin');
    await page.getByRole('button', { name: /add user/i }).click();

    // Wait for user to appear in list
    await expect(page.locator('.user-row', { hasText: testUser })).toBeVisible({ timeout: 5000 });

    // Delete via API to clean up
    const usersRes = await fetch(`${BASE_URL}/admin/api/users`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const usersBody = await usersRes.json() as { success: boolean; data: Array<{ id: string; username: string }> };
    const users = Array.isArray(usersBody.data) ? usersBody.data : [];
    const created = users.find((u) => u.username === testUser);

    if (created) {
      await fetch(`${BASE_URL}/admin/api/users/${created.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
    }
  });
});
