import type { Config } from "drizzle-kit";

export default {
  schema: "./src/session-runtime/schema.ts",
  out: "./src/session-runtime/migrations",
  dialect: "sqlite",
} satisfies Config;
