import { defineConfig } from "vite";
import { landingPage } from "./scripts/landing-plugin.ts";

export default defineConfig({
  plugins: [landingPage()],
  build: { outDir: "dist", sourcemap: true },
});
