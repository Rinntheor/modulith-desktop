import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite'
import { vitePluginGenerateModules } from './scripts/vite-plugin-generate-modules';
import path from 'path';




const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(),vitePluginGenerateModules()],

  /*
   * 多入口：主窗口 + 托盘菜单。
   *
   * 托盘菜单必须是**独立的 HTML 入口**，因为它显示在主窗口之外
   * （主窗口可能已被隐藏到托盘），而且无边框、透明、始终置顶。
   * 把它做成主窗口里的一段界面行不通：那要求主窗口一直在屏幕上，
   * 而那与"关掉窗口就省内存"是矛盾的。
   *
   * 不写这一段时的表现很典型：开发模式下一切正常（Vite 按 URL 提供任意 HTML），
   * 而**发布版**里托盘菜单窗口是空白的 —— 构建产物里只有 index.html。
   * 那正是"只在发布版里坏掉"这一类问题。
   *
   * key 决定产物的路径（`tray-menu.html`），Tauri 的窗口 URL 按它去找。
   */
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'tray-menu': path.resolve(__dirname, 'tray-menu.html'),
      },
    },
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@styles": path.resolve(__dirname, "./src/styles"),
      "@components": path.resolve(__dirname, "./src/components"),
      "@modules": path.resolve(__dirname, "./src/modules"),
      "@utils": path.resolve(__dirname, "./src/utils"),
      "@hooks": path.resolve(__dirname, "./src/hooks"),
      // 注意：这里曾经是 "./src/components/contexts"，该目录并不存在
      // （contexts 实际位于 src/contexts）。所有调用方实际走的都是 `@/`，
      // 因此这条别名从未被命中；留着只会在日后误导。
      "@contexts": path.resolve(__dirname, "./src/contexts"),
      "@config": path.resolve(__dirname, "./src/config"),
      "@types": path.resolve(__dirname, "./src/types"),
      "@assets": path.resolve(__dirname, "./src/assets"),
      "@pages": path.resolve(__dirname, "./src/pages"),
      // 原为裸别名 "constants" → "./src/constants"（目录不存在）。
      // 裸别名会遮蔽同名 npm 包，隐患大于收益，故移除；
      // 需要时用 "@/constants" 或新增带前缀的别名。
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
