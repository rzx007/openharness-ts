import { describe, expect, it } from "vitest";

import {
  ProviderCapabilityMismatchFailure,
  RequestFailure,
  requestFailure,
} from "./index.js";

describe("requestFailure", () => {
  it("classifies an explicit provider image rejection", () => {
    const error = requestFailure("This model does not support image input", 400);
    expect(error).toBeInstanceOf(ProviderCapabilityMismatchFailure);
    expect(error).toMatchObject({ code: "provider_capability_mismatch", statusCode: 400 });
  });

  it("keeps unrelated bad requests generic", () => {
    expect(requestFailure("Invalid temperature", 400)).toBeInstanceOf(RequestFailure);
    expect(requestFailure("Invalid temperature", 400)).not.toBeInstanceOf(
      ProviderCapabilityMismatchFailure,
    );
  });
});
