import assert from "node:assert/strict";
import test from "node:test";

import { parseReleaseArgs, ReleaseArgError, USAGE } from "./npm-release.mjs";

test("parseReleaseArgs requires an explicit x.y.z version", () => {
  assert.deepEqual(parseReleaseArgs(["1.0.1"]), {
    dryRun: false,
    skipBuild: false,
    version: "1.0.1",
  });
  assert.deepEqual(parseReleaseArgs(["--dry-run", "1.0.1"]), {
    dryRun: true,
    skipBuild: false,
    version: "1.0.1",
  });
  assert.deepEqual(parseReleaseArgs(["1.0.1", "--skip-build", "--dry-run"]), {
    dryRun: true,
    skipBuild: true,
    version: "1.0.1",
  });
});

test("parseReleaseArgs rejects missing, extra, and non-explicit versions", () => {
  assert.throws(() => parseReleaseArgs([]), ReleaseArgError);
  assert.throws(() => parseReleaseArgs(["--dry-run"]), ReleaseArgError);
  assert.throws(() => parseReleaseArgs(["auto"]), ReleaseArgError);
  assert.throws(() => parseReleaseArgs(["patch"]), ReleaseArgError);
  assert.throws(() => parseReleaseArgs(["1.0.1-beta.1"]), ReleaseArgError);
  assert.throws(() => parseReleaseArgs(["1.0.1", "extra"]), ReleaseArgError);
  assert.throws(() => parseReleaseArgs(["help"]), (error) => {
    return error instanceof ReleaseArgError && error.message === USAGE;
  });
});
