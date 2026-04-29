/**
 * `src/auth` — bearer-auth middleware barrel.
 *
 * Re-exports the Hono middleware factory so external imports
 * (e.g. `import { bearerAuth } from "./auth/index.js"`) don't have to
 * know the file layout. `UNAUTHORIZED_BODY` is intentionally NOT re-
 * exported here — tests reach it directly through `./middleware.js` and
 * no cross-module consumer needs the literal.
 */

export { bearerAuth } from "./middleware.js";
