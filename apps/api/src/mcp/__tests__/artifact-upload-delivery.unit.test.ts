// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { artifactUploadSession, artifactUploadToolResult } from "../artifact-upload.js";

const UPLOAD_URL = "https://api.example.test/api/artifact-upload/one-time-token";
const minted = { uploadUrl: UPLOAD_URL, expiresAt: "2026-09-05T10:10:00.000Z" };

describe("artifact upload link delivery", () => {
  it("keeps the link in private metadata when the picker can render", () => {
    const result = artifactUploadToolResult({ privatePicker: true, minted });
    expect(result._meta).toEqual(minted);
    expect(JSON.stringify(result.content)).not.toContain("/api/artifact-upload/");
    expect(result.structuredContent).toBeUndefined();
  });

  it("gives every other client the link and how to send the file", () => {
    const result = artifactUploadToolResult({ privatePicker: false, minted });
    expect(result._meta).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain(UPLOAD_URL);
    expect(text).toContain("application/octet-stream");
    expect(text).toContain("x-file-name");
    expect(text).toContain("one file, once, until 2026-09-05T10:10:00.000Z");
    expect(result.structuredContent).toEqual({
      pending: true,
      ...minted,
      upload: {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": "<URL-encoded file name>" },
        body: "the raw file bytes",
      },
    });
  });
});

describe("the session an upload link produces", () => {
  it("names the tenant and the person and carries no authority", () => {
    expect(artifactUploadSession({
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "person-a",
      credential: "bearer",
    })).toEqual({
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "person-a",
      roles: [],
      groups: [],
      scope: "self",
      credential: "bearer",
    });
  });

  it("ignores roles a stored token still carries", () => {
    const stored = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "person-a",
      credential: "bearer" as const,
      roles: ["organization-admin"],
      groups: ["finance"],
      scope: "tenant",
    };
    const session = artifactUploadSession(stored);
    expect(session.roles).toEqual([]);
    expect(session.groups).toEqual([]);
    expect(session.scope).toBe("self");
  });
});
