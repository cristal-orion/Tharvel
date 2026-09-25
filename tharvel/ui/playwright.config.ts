import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 3,
  use: {
    baseURL: 'http://127.0.0.1:5187',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5187 --strictPort',
    url: 'http://127.0.0.1:5187/tharveladmin/',
    env: { VITE_SERVER_BASE: 'http://127.0.0.1:5187', VITE_DEV_BYPASS_AUTH: '0' },
    reuseExistingServer: false,
  },
});
