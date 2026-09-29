import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 两个入口:index.html = BI 看板;loyalty.html = 顾客资料(柜台用的独立页)
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        loyalty: fileURLToPath(new URL('./loyalty.html', import.meta.url)),
      },
    },
  },
});
