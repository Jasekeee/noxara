// Lets plain `node tools/x.ts` load src/sim/*.ts, which use extensionless relative imports
// ("./types") — fine for Vite/Vitest, but Node's ESM resolver needs the ".ts". Import this module
// FIRST, then load sim modules with dynamic `await import()` (static imports resolve before any code runs).
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      const fromTs = context.parentURL?.endsWith(".ts") ?? false;
      if (relative && fromTs && !/\.[cm]?[jt]s$/.test(specifier)) {
        for (const ext of [".ts", "/index.ts"]) {
          try {
            return nextResolve(specifier + ext, context);
          } catch {
            /* try next */
          }
        }
      }
      throw err;
    }
  },
});
