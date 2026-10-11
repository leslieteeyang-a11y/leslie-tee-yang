import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 三个入口:index.html = BI 看板;loyalty.html = 顾客资料(柜台用的独立页);join.html = 顾客自己扫 QR 登记(不用登入);delivery.html = 送货排单(2026-10-06);driver.html = 司机凭连结签收拍照(不用登入,2026-10-07)
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        loyalty: fileURLToPath(new URL('./loyalty.html', import.meta.url)),
        join: fileURLToPath(new URL('./join.html', import.meta.url)),
        delivery: fileURLToPath(new URL('./delivery.html', import.meta.url)),
        driver: fileURLToPath(new URL('./driver.html', import.meta.url)),
      },
    },
  },
});
