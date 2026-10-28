import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite proxies /api to the Fastify server so the UI and API share one
// origin: cookies just work and no API CORS is needed. (Uploads still go
// straight from the browser to S3; that origin is allowed via bucket CORS.)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
