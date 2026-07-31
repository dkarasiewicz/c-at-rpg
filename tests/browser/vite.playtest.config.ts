/**
 * Vite config for the browser playtest ONLY.
 *
 * Same bundle, no hot reload: HMR tears down the page's execution context
 * mid-run the instant anything under src/ is touched, which makes a
 * long-running scripted playtest fail with "execution context was destroyed"
 * for reasons that have nothing to do with the game.
 */
import { defineConfig } from "vite";

export default defineConfig({
  root: process.cwd(),
  server: {
    port: 5199,
    strictPort: true,
    open: false,
    hmr: false,
    watch: null,
  },
});
