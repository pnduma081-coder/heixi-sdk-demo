import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  envDir: false,
  server: {
    middlewareMode: true,
    fs: {
      strict: true,
      deny: [
        ".env",
        ".env.*",
        "**/.local/**",
        "**/server/**",
        "**/scripts/**",
        "**/tests/**",
        "**/*.pem",
        "**/*.sqlite*",
      ],
    },
  },
});
