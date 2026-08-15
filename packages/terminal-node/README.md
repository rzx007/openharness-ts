# @openharness/terminal-node

Node-backed terminal runtime for OpenHarness.

This package owns local PTY process management and keeps `node-pty` out of UI surfaces.

`LocalTerminalProvider` keeps a bounded, in-memory output snapshot for each process. The snapshot is
not persisted to disk and is discarded when the terminal is closed or the provider is disposed.
