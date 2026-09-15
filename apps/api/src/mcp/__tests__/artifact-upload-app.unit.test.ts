// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  ARTIFACT_UPLOAD_APP_URI,
  ARTIFACT_UPLOAD_TOOL_NAME,
  renderArtifactUploadApp,
  renderArtifactUploadPage,
} from "../artifact-upload.js";

describe("artifact upload MCP App", () => {
  it("bundles a private file picker without an upload credential", async () => {
    const html = await renderArtifactUploadApp();
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
});
