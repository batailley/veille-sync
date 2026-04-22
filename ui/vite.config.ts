import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3003,
    strictPort: true,
    host: "localhost",
    proxy: {
      "/api": {
        target: "http://localhost:3004",
        changeOrigin: false,
      },
    },
  },
});
