import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS (self-signed) so wallets treat the dev origin as secure — fixes the
// "your connection is not secure" warning on connect. Accept the cert once in the browser.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: 5173,
    https: {},
    // Proxy API to the HTTP backend so an HTTPS page doesn't hit mixed-content blocks.
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
});
