import { cpSync } from "node:fs"
import { resolve } from "node:path"

import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import type { Plugin } from "vite"

function copySessionMigrations(): Plugin {
  return {
    name: "copy-session-migrations",
    writeBundle(options) {
      const outputDirectory = resolve(options.dir ?? "out/main")
      cpSync(
        resolve("../../packages/services/src/session-runtime/migrations"),
        resolve(outputDirectory, "migrations"),
        { recursive: true }
      )
    },
  }
}

export default defineConfig({
  main: {
    plugins: [copySessionMigrations()],
    build: {
      externalizeDeps: {
        exclude: ["@openharness/client", "@openharness/server", "electron-store"],
      },
    },
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@main": resolve("src/main"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
