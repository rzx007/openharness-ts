import { describe, it, expect } from "vitest";
import { VoiceMode } from "./index.js";

describe("VoiceMode", () => {
  it("isActive returns false by default", () => {
    const mode = new VoiceMode();
    expect(mode.isActive()).toBe(false);
  });

  it("start throws not implemented", async () => {
    const mode = new VoiceMode();
    await expect(mode.start()).rejects.toThrow(
      "Voice mode not yet implemented"
    );
  });

  it("stop deactivates", async () => {
    const mode = new VoiceMode();
    await mode.stop();
    expect(mode.isActive()).toBe(false);
  });

  it("listen throws not implemented", async () => {
    const mode = new VoiceMode();
    const iter = mode.listen();
    await expect(iter.next()).rejects.toThrow(
      "Speech-to-text not yet implemented"
    );
  });

  it("accepts config", () => {
    const mode = new VoiceMode({ language: "en-US", model: "whisper" });
    expect(mode.isActive()).toBe(false);
  });
});
