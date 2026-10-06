import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // configure-pages가 알려주는 경로: 커스텀 도메인은 /, 프로젝트 Pages는 /저장소명/.
  base: process.env.PAGES_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  server: {
    // 127.0.0.1과 localhost 양쪽에서 열리도록 명시한다.
    host: '127.0.0.1',
    port: 5273,
    open: false,
    watch: {
      // 테스트 산출물이 쓰일 때마다 전체 리로드가 걸려 입력값이 날아간다.
      ignored: [
        '**/test-results/**',
        '**/playwright-report/**',
        '**/.playwright-artifacts-*/**',
        '**/tests/.tmp/**',
        '**/storage/**',
      ],
    },
    // 개발 중에는 프론트와 API가 같은 오리진으로 보이게 프록시한다.
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
});
