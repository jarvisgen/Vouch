import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Plain HTTP dev server — simplest local setup. Open http://localhost:5173.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
