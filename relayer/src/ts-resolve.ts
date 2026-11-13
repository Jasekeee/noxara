// Lets Node (type stripping) load the shared simulation in ../src/sim, whose relative imports are
// extensionless ("./types", "./match") for Vite. Used via `node --import ./src/ts-resolve.ts`.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || /\.[cm]?[jt]s$/.test(specifier)) throw e;
      for (const ext of [".ts", "/index.ts"]) {
        try {
          return nextResolve(specifier + ext, context);
        } catch {
          // try the next candidate
        }
      }
      throw e;
    }
  },
});
