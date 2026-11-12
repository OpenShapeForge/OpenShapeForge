// SPDX-License-Identifier: BUSL-1.1
import { API_BUILD_IDENTITY } from "../../config/build-identity.js";
import { describe, expect, it } from "bun:test";
import {
  ARTIFACT_UPLOAD_APP_URI,
  ARTIFACT_UPLOAD_PRIVACY_HEADERS,
  artifactUploadPagePolicy,
  ARTIFACT_UPLOAD_TOOL_NAME,
  renderArtifactUploadApp,
  renderArtifactUploadPage,
} from "../artifact-upload.js";

describe("artifact upload MCP App", () => {
  it("bundles a private file picker without an upload credential", async () => {
    const html = await renderArtifactUploadApp();
    expect(html).toContain(API_BUILD_IDENTITY.version);
    expect(ARTIFACT_UPLOAD_APP_URI).toBe("ui://openshapeforge/artifact-upload");
    expect(ARTIFACT_UPLOAD_TOOL_NAME).toBe("upload_document_file");
    expect(html).toContain('id="upload-file"');
    expect(html).toContain("ui/update-model-context");
    expect(html).not.toContain("/api/artifact-upload/");
  });

  it("embeds only the single-use URL in the no-App browser fallback", () => {
    const html = renderArtifactUploadPage(
      "https://hubble.localhost/api/artifact-upload/token-value",
    );
    expect(html).toContain(
      "https://hubble.localhost/api/artifact-upload/token-value",
    );
    expect(html).toContain("application/octet-stream");
    expect(html).toContain("artifactId");
  });

  it("keeps the token link out of caches and referrers and confines the page", () => {
    expect(ARTIFACT_UPLOAD_PRIVACY_HEADERS).toMatchObject({
      "cache-control": "private, no-store, max-age=0",
      "referrer-policy": "no-referrer",
    });
    const html = renderArtifactUploadPage(
      "https://hubble.localhost/api/artifact-upload/token-value",
      "bm9uY2U=",
    );
    expect(html).toContain('<script nonce="bm9uY2U=">');
    const policy = artifactUploadPagePolicy("https://hubble.localhost", "bm9uY2U=");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'nonce-bm9uY2U='");
    expect(policy).toContain("connect-src 'self' https://hubble.localhost");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("token-value");
  });
});
