#!/usr/bin/env node
import("tsx/esm/api").then(({ register }) => {
  register();
  import("./merge-scout.ts");
});
