/**
 * `src/auth` — bearer-auth middleware barrel.
 *
 * Re-exports the Hono middleware factory and the canonical 401 body so
 * external imports (e.g. `import { bearerAuth } from "./auth/index.js"`)
 * don't have to know the file layout.
 */

export { bearerAuth, UNAUTHORIZED_BODY } from "./middleware.js";
