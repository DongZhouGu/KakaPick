import { describe, expect, it } from "vitest";
import config from "../../vite.config.js";

describe("production client build", () => {
  it("removes stale hashed assets before writing a release build", () => {
    expect(config.build?.emptyOutDir).toBe(true);
  });
});
