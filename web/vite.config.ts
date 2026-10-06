import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// `base: "./"` and a flat asset folder let the iOS app load the build from its bundle.
export default defineConfig({
  base: "./",
  build: {
    assetsDir: "",
  },
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
});
