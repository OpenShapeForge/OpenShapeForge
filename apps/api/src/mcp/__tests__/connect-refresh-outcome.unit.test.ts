// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { HttpError } from "../../rest/http-error.js";
import { connectRefreshOutcome } from "../connect-refresh-outcome.js";

describe("connect refresh", () => {
  it("recognizes a renewed connection without asking for consent", async () => {
    expect(await connectRefreshOutcome(async () => ({ accessToken: "synthetic" }))).toBe("connected");
  });
  it("asks for new consent when the refresh grant is refused", async () => {
    expect(await connectRefreshOutcome(async () => { throw new HttpError(403, "REAUTHORIZATION_REQUIRED", "refused"); })).toBe("reauthorize");
  });
  it("does not turn temporary, configuration or cancellation failures into consent", async () => {
    for (const error of [new HttpError(502, "TOKEN_REFRESH_FAILED", "temporary"), new HttpError(400, "PROVIDER_MISCONFIGURED", "configuration"), new DOMException("cancelled", "AbortError")]) {
      await expect(connectRefreshOutcome(async () => { throw error; })).rejects.toBe(error);
    }
  });
});
