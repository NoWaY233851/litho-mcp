import { createDeps } from "../src/deps.js";
import { createLazyFetch } from "../src/http.js";

export default {
  fetch: createLazyFetch(
    () => createDeps(process.env),
    (message) => console.error(`litho: ${message}`),
  ),
};
