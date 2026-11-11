// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it } from "bun:test";
import { artifactUploadToolResult } from "../artifact-upload.js";
import { MODEL_VISIBLE_UPLOAD_LINK_ENV, modelVisibleUploadLinkAllowed } from "../handoff-config.js";

const UPLOAD_URL = "https://api.example.test/api/artifact-upload/private-bearer-token";
const minted = { uploadUrl: UPLOAD_URL, expiresAt: "2026-09-05T10:10:00.000Z" };

function minter() {
  const state = { calls: 0 };
  return { state, mint: async () => { state.calls += 1; return minted; } };
}

describe("artifact upload link delivery", () => {
  it("keeps the bearer link in private metadata when the picker can render", async () => {
    const { state, mint } = minter();
    const result = await artifactUploadToolResult({ privatePicker: true, modelVisibleLinkAllowed: false, mint });
    expect(state.calls).toBe(1);
    expect(result._meta).toEqual(minted);
    expect(JSON.stringify(result.content)).not.toContain("/api/artifact-upload/");
    expect(result.structuredContent).toBeUndefined();
  });

  it("mints nothing and refuses when the link would be model-visible", async () => {
    const { state, mint } = minter();
    const error = await artifactUploadToolResult({ privatePicker: false, modelVisibleLinkAllowed: false, mint })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, code: "PRIVATE_UPLOAD_UNAVAILABLE" });
    expect((error as Error).message).not.toContain("/api/artifact-upload/");
    expect(state.calls).toBe(0);
  });

  it("shares the link in text only where the deployment opted in", async () => {
    const { state, mint } = minter();
    const result = await artifactUploadToolResult({ privatePicker: false, modelVisibleLinkAllowed: true, mint });
    expect(state.calls).toBe(1);
    expect(result.content[0]?.text).toContain(UPLOAD_URL);
    expect(result.structuredContent).toEqual({ pending: true, ...minted });
  });
});

describe("model-visible upload link opt-in", () => {
  const previous = process.env[MODEL_VISIBLE_UPLOAD_LINK_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[MODEL_VISIBLE_UPLOAD_LINK_ENV];
    else process.env[MODEL_VISIBLE_UPLOAD_LINK_ENV] = previous;
  });

  it("is off unless the deployment sets exactly 1", () => {
    delete process.env[MODEL_VISIBLE_UPLOAD_LINK_ENV];
    expect(modelVisibleUploadLinkAllowed()).toBe(false);
    process.env[MODEL_VISIBLE_UPLOAD_LINK_ENV] = "true";
    expect(modelVisibleUploadLinkAllowed()).toBe(false);
    process.env[MODEL_VISIBLE_UPLOAD_LINK_ENV] = "1";
    expect(modelVisibleUploadLinkAllowed()).toBe(true);
  });
});
