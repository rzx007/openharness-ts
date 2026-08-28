import type { ServerCapabilities } from "@openharness/client"
import { describe, expect, it } from "vitest"

import {
  disabledDesktopAttachmentSupport,
  normalizeDesktopAttachmentSupport,
  resolveDesktopAttachmentSupport,
} from "./attachment-types"

const attachmentLimits = {
  maxFilesPerPrompt: 20,
  maxBytesPerFile: 100 * 1024 * 1024,
  maxBytesPerPrompt: 250 * 1024 * 1024,
  maxSessionReferencedBytes: 2 * 1024 * 1024 * 1024,
  resumableThresholdBytes: 25 * 1024 * 1024,
  uploadSessionTtlMs: 24 * 60 * 60 * 1_000,
  stagingTtlMs: 24 * 60 * 60 * 1_000,
}

const attachmentCapabilities: ServerCapabilities = {
  serverVersion: "0.1.0",
  protocol: { version: 2 },
  features: { attachments: 1 },
  attachments: {
    uploadModes: ["single"],
    limits: attachmentLimits,
  },
}

describe("resolveDesktopAttachmentSupport", () => {
  it("normalizes an older bootstrap without attachment capability to disabled", () => {
    expect(normalizeDesktopAttachmentSupport(undefined)).toBe(disabledDesktopAttachmentSupport)
  })

  it("enables the daemon attachment contract in development", () => {
    expect(
      resolveDesktopAttachmentSupport(attachmentCapabilities, {
        isPackaged: false,
        forceEnable: false,
      })
    ).toEqual({
      daemonSupported: true,
      interactionEnabled: true,
      uploadModes: ["single"],
      limits: attachmentLimits,
    })
  })

  it("keeps an old daemon on the text-only path", () => {
    expect(
      resolveDesktopAttachmentSupport(
        {
          serverVersion: "0.1.0",
          protocol: { version: 2 },
          features: {},
        },
        { isPackaged: false, forceEnable: false }
      )
    ).toEqual({
      daemonSupported: false,
      interactionEnabled: false,
      uploadModes: [],
      limits: null,
    })
  })

  it("keeps production disabled unless an internal override is explicit", () => {
    expect(
      resolveDesktopAttachmentSupport(attachmentCapabilities, {
        isPackaged: true,
        forceEnable: false,
      }).interactionEnabled
    ).toBe(false)

    expect(
      resolveDesktopAttachmentSupport(attachmentCapabilities, {
        isPackaged: true,
        forceEnable: true,
      }).interactionEnabled
    ).toBe(true)
  })
})
