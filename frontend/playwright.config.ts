import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { TEST_AUTH_USERS } from './tests/testAccount';

const API_PORT = 4100;
const WEB_PORT = 5274;
const storageRoot = path.join(import.meta.dirname, 'tests', '.tmp', 'storage');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
  },
  webServer: [
    {
      // 일부러 --env-file 을 붙이지 않는다. 테스트는 backend/.env 와 무관하게
      // 항상 테스트 전용 계정(tests/testAccount.ts)으로 돌아야 한다.
      command: 'node --import tsx src/server.ts',
      cwd: path.join(import.meta.dirname, '..', 'backend'),
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(API_PORT),
        AUTH_USERS: TEST_AUTH_USERS,
        STORAGE_ROOT: storageRoot,
        // 테스트에서는 원본을 남겨 두어 상태 검증을 단순하게 한다.
        DELETE_SOURCE_AFTER_EXTRACT: 'false',
      },
    },
    {
      command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      cwd: import.meta.dirname,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
