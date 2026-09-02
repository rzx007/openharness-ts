---
"@openharness/agent-runtime": major
---

Remove the `hostCapabilities` API in favor of per-capability `capabilityOverrides` and permission `effects`. Terminal and background-shell overrides now use observable `{ value, jobs }` bundles, and Host-owned overrides must support the root session tree and are released by the Host.

Rename `setCompactAttachmentsProvider` to `setCompactContextProvider`. `createDefaultNodeAgent` now supplies a local Terminal by default; Attachments and Schedules remain unavailable until a Host provides them.
