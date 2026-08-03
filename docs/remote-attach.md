# Remote Attach

Task 12 defines two separate connection modes.

- **Local discovery:** `ohs` and `ohs --tui` use the private local daemon registry under `~/.openharness-ts/daemon/`. The registry contains a bearer token and must not be copied to another machine.
- **Remote attach:** Web, Desktop, and another machine receive an explicit daemon URL plus bearer token through a secure channel. They never read the local registry.

## Start a browser-capable daemon

The default daemon binds to `127.0.0.1`. A non-loopback bind requires an explicit token. Browser origins are deny-by-default and must be listed exactly.

```bash
ohs serve --host 0.0.0.0 --port 8787 \
  --token "$OPENHARNESS_DAEMON_TOKEN" \
  --allow-origin https://desk.example \
  --allow-origin http://localhost:5173
```

Put TLS and any network access policy in front of a non-loopback daemon. Do not put the token in a URL, query string, browser local storage shared by untrusted pages, or a copied local registry file.

## Attach a TUI

```bash
ohs --tui \
  --daemon-url https://daemon.example \
  --daemon-token "$OPENHARNESS_DAEMON_TOKEN"
```

`--daemon-url` never starts or replaces a local daemon. It passes the explicit connection descriptor to the normal TUI client path.

## Web/Desktop SDK

`@openharness/client` uses `fetch`, including for SSE, so the bearer token is sent in the `Authorization` header without placing it in the event-stream URL.

```ts
import { OpenHarnessClient, syncEvents } from "@openharness/client";

const client = new OpenHarnessClient({
  baseUrl: "https://daemon.example",
  token: process.env.OPENHARNESS_DAEMON_TOKEN,
});

await client.health();
const sessions = await client.listSessions();
const state = await syncEvents(client);
```

An allowed browser origin controls which pages may issue cross-origin requests. It is not an authentication substitute: every remote request still needs the bearer token.
