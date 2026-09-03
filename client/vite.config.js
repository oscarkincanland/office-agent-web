import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // shpjs → immediate 依赖浏览器全局 global（旧打包假设），此处兜底
    global: "globalThis",
  },
  resolve: {
    alias: {
      // shpjs → safe-buffer 依赖 Node 内置 buffer，用浏览器 polyfill 包替换
      buffer: "buffer/",
    },
  },
  server: {
    port: 3002,
    proxy: {
      "/api": "http://localhost:3002",
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1500,
  },
});
