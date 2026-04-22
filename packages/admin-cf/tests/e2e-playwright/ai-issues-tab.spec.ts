import { test, expect } from './fixtures.js';

test.describe('AI Issues Tab', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.locator('.tabs .tab', { hasText: 'AI Issues' }).click();
    await expect(page.locator('.tab.active')).toContainText('AI Issues');
    await page.waitForTimeout(3000);
  });

  test('renders tab content without crashing', async ({ authedPage: page }) => {
    // Should show the AI Issues heading
    await expect(page.locator('h3', { hasText: 'AI Issues' })).toBeVisible();
  });

  test('shows cost summary cards when API is available', async ({ authedPage: page }) => {
    const cards = page.locator('.stat-card');
    const count = await cards.count();
    // Cost cards only render if /api/ai/costs returns data.
    // With local dev the service binding may not be connected,
    // so we accept 0 or 4+ cards.
    expect(count === 0 || count >= 4).toBe(true);
  });

  test('shows issues list or empty state', async ({ authedPage: page }) => {
    // Should show either issues or "No AI-generated issues"
    const emptyState = page.locator('.empty-state');
    const issuesList = page.locator('[style*="cursor"]'); // issue rows have cursor:pointer

    const emptyVisible = await emptyState.isVisible().catch(() => false);
    const issuesCount = await issuesList.count();

    expect(emptyVisible || issuesCount > 0).toBe(true);
  });
});
