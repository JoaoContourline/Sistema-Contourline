// @ts-check
import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

export default defineConfig({
  testDir:   './tests',
  timeout:   40_000,
  retries:   process.env.CI ? 1 : 0,
  workers:   1, // testes são sequenciais (compartilham dados no Supabase)
  reporter:  [['html', { open: 'never' }], ['list']],

  use: {
    baseURL:          process.env.TEST_URL || 'http://localhost:3000',
    screenshot:       'only-on-failure',
    video:            'retain-on-failure',
    trace:            'retain-on-failure',
    headless:         process.env.CI ? true : false,
    actionTimeout:    15_000,
    navigationTimeout:20_000,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
