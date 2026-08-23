import { cpSync } from "node:fs"
import { resolve } from "node:path"

import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
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
        exclude: [
          "@openharness/client",
          "@openharness/server",
          "@openharness/terminal",
          "@openharness/terminal-node",
          "electron-store",
        ],
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
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: "./src/routes",
        generatedRouteTree: "./src/routeTree.gen.ts",
      }),
      react(),
      tailwindcss(),
    ],
  },
})
