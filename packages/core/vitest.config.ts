import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        // node:sqlite 是较新的内置模块,vite 的内置模块清单还没收录,强制外置
        external: [/^node:/],
      },
    },
  },
});
