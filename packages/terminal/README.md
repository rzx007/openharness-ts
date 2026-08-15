# @openharness/terminal

Portable terminal protocol and interfaces for OpenHarness surfaces.

This package intentionally does not depend on Electron, React, xterm, or node-pty. It only defines
the terminal session model, event model, and provider/connection interfaces.

Sessions are named and remain addressable after their shell exits. A host can list sessions and use
`read()` to restore the bounded in-memory output snapshot before it resumes consuming live events.
Data events and snapshots carry a monotonic sequence number so an attaching view can join the two
streams without dropping or duplicating output.
