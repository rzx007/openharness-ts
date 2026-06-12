// apps/frontend/scripts/probe-diff.tsx
/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";

const PATCH = `--- a/hello.ts
+++ b/hello.ts
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 export { x, y };
`;

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <diff
    diff={PATCH}
    view="unified"
    showLineNumbers={true}
    height={10}
  />
);
await new Promise((r) => setTimeout(r, 500));
renderer.destroy();
process.exit(0);
