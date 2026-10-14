import { describe, expect, it } from "vitest";
import { normalizeBaseUrl, normalizeToken, originPattern } from "./target";

describe("normalizeBaseUrl", () => {
  it("accepts the pasted page URL, bare host or trailing slash", () => {
    expect(normalizeBaseUrl("https://se-meira.bps9702.com/anomali")).toBe("https://se-meira.bps9702.com");
    expect(normalizeBaseUrl("se-meira.bps9702.com/")).toBe("https://se-meira.bps9702.com");
    expect(normalizeBaseUrl(" http://192.168.1.2:8015/api/ping ")).toBe("http://192.168.1.2:8015");
    expect(normalizeBaseUrl("https://host/apps/rekap/")).toBe("https://host/apps/rekap");
    expect(normalizeBaseUrl("")).toBe("");
  });

  it("rejects non-http schemes", () => {
    expect(() => normalizeBaseUrl("ftp://host")).toThrow();
  });
});

it("builds the host permission pattern", () => {
  expect(originPattern("https://host:8443/apps/rekap")).toBe("https://host:8443/*");
});

it("cleans a pasted token", () => {
  expect(normalizeToken(" Bearer abc123\n")).toBe("abc123");
  expect(normalizeToken("`abc 123`")).toBe("abc123");
});
