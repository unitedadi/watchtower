import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const repairApi = env.WATCHTOWER_REPAIR_API_BASE || "http://127.0.0.1:3002";
  const operatorToken = env.WATCHTOWER_REPAIR_OPERATOR_TOKEN || "";
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api/repair-cases": {
          target: repairApi,
          changeOrigin: true,
          rewrite: () => "/telemetry/repair-cases",
          headers: operatorToken ? { Authorization: `Bearer ${operatorToken}` } : {},
        },
      },
    },
  };
});
