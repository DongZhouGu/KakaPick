import { describe, expect, it } from "vitest";
import { isInternalNavigation, safeExternalUrl } from "./security.js";

describe("Electron navigation policy", () => {
  const appUrl = "http://127.0.0.1:43110/?token=abc";

  it("keeps only the active loopback origin inside the app window", () => {
    expect(isInternalNavigation(appUrl, "http://127.0.0.1:43110/albums/one")).toBe(true);
    expect(isInternalNavigation(appUrl, "http://127.0.0.1:43111/")).toBe(false);
    expect(isInternalNavigation(appUrl, "http://localhost:43110/")).toBe(false);
    expect(isInternalNavigation(appUrl, "file:///etc/passwd")).toBe(false);
    expect(isInternalNavigation(appUrl, "not a url")).toBe(false);
  });

  it("allows only credential-free HTTP(S) URLs to open externally", () => {
    expect(safeExternalUrl("https://example.com/docs")?.href).toBe("https://example.com/docs");
    expect(safeExternalUrl("http://example.com/")?.href).toBe("http://example.com/");
    expect(safeExternalUrl("https://user:secret@example.com/")).toBeUndefined();
    expect(safeExternalUrl("file:///tmp/photo.jpg")).toBeUndefined();
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("not a url")).toBeUndefined();
  });
});
