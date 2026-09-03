import { describe, expect, it } from "vitest";

import { isPublicAddress } from "../safe-remote-image.js";

describe("safe remote image address policy", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "ff02::1",
    // NAT64 well-known prefix 64:ff9b::/96 embeds the IPv4 in the last 32 bits.
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::c0a8:1",
    // 6to4 2002::/16 embeds the IPv4 in bits 16..48.
    "2002:7f00:1::1",
    "2002:c0a8:1::",
    "2002:a9fe:a9fe::",
  ])("blocks private, local, and mapped address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])(
    "allows public address %s",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );
});
