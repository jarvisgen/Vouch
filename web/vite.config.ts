import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Plain HTTP dev server — simplest local setup. Open http://localhost:5174.
// (Fresh port avoids browsers that cached :5173 as HTTPS from the old self-signed setup.)
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
});
