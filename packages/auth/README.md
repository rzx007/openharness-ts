# @openharness/auth

Authentication helpers for OpenHarness.

This package separates OpenHarness-managed API keys from external auth sources
such as a local Codex CLI subscription login.

## Credential Storage

`CredentialStorage` stores provider API keys in:

```text
$OPENHARNESS_CONFIG_DIR/credentials.json
```

When `OPENHARNESS_CONFIG_DIR` is not set, the default path is:

```text
~/.openharness-ts/credentials.json
```

Example shape:

```json
{
  "deepseek": {
    "api_key": "sk-xxx"
  }
}
```

## Codex Subscription

Codex subscription auth is external. OpenHarness reads the local Codex CLI auth
file and does not copy that token into `credentials.json`.

Default source:

```text
~/.codex/auth.json
```

With `CODEX_HOME`:

```text
$CODEX_HOME/auth.json
```

## Usage

```ts
import { CredentialStorage, describeCodexAuthState } from "@openharness/auth";

const storage = new CredentialStorage();
await storage.storeApiKey("deepseek", "sk-xxx");
const key = await storage.loadApiKey("deepseek");

const codex = await describeCodexAuthState();
if (codex.configured) {
  console.log(`Codex ready: ${codex.profileLabel ?? codex.source}`);
}
```

## CLI Semantics

```text
auth     prepares a credential source
provider chooses the model vendor
model    chooses the model name
```

Main CLI shape:

```bash
ohs auth login deepseek sk-xxx
ohs auth login codex
```

See `docs/auth-provider-model.md` for the complete runtime flow.

## Tests

```bash
pnpm --filter @openharness/auth test
```
