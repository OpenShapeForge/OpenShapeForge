// SPDX-License-Identifier: BUSL-1.1
/** Private MCP App/browser handoff for the core artifact transport. */
import { API_BUILD_IDENTITY } from "../config/build-identity.js";
import { fileURLToPath } from "node:url";
import type { SecretKeyring } from "../connectors/secrets.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { createHandoff, readHandoff } from "./handoff-store.js";
import { escapeHtml } from "./browser-pages.js";
import { productName } from "../config/product-name.js";
import { HttpError } from "../rest/http-error.js";

export const ARTIFACT_UPLOAD_APP_URI = "ui://openshapeforge/artifact-upload";
export const ARTIFACT_UPLOAD_PATH = "/api/artifact-upload";
export { ARTIFACT_UPLOAD_TOOL_NAME } from "@openshapeforge/operations";
export const ARTIFACT_UPLOAD_TTL_SECONDS = 10 * 60;

export type PendingArtifactUpload = {
  tenantId: string;
  userId: string;
  roles: string[];
  groups: string[];
  scope: "tenant" | "group" | "self";
  credential: "bearer" | "api-key" | "trusted-context";
};

export async function mintArtifactUpload(input: {
  db: OpenShapeForgeDatabase;
  keyring: SecretKeyring;
  session: TrustedSessionContext;
  origin: string;
  nowMs?: number;
}): Promise<{ uploadUrl: string; expiresAt: string }> {
  if (!input.session.tenantId || !input.session.userId) {
    throw new Error(
      "An authenticated tenant user is required for artifact upload.",
    );
  }
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = nowMs + ARTIFACT_UPLOAD_TTL_SECONDS * 1000;
  const token = await createHandoff({
    db: input.db,
    session: input.session,
    keyring: input.keyring,
    kind: "artifact_upload",
    tenantId: input.session.tenantId,
    userId: input.session.userId,
    payload: {
      tenantId: input.session.tenantId,
      userId: input.session.userId,
      roles: [...(input.session.roles ?? [])],
      groups: [...(input.session.groups ?? [])],
      scope: input.session.scope ?? "self",
      credential:
        input.session.credential === "api-key" ||
        input.session.credential === "trusted-context"
          ? input.session.credential
          : "bearer",
    } satisfies PendingArtifactUpload,
    expiresAtMs,
  });
  return {
    uploadUrl: `${input.origin}${ARTIFACT_UPLOAD_PATH}/${token}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * What the upload tool answers. The upload link is a bearer carrying the
 * person's roles, so where it goes decides who can use it:
 *
 *   private picker   the link travels in `_meta`, which the model never sees.
 *   any other client the link would sit in model-visible text, usable by
 *                    anyone who reads the tool result until it expires. Nothing
 *                    is minted and the tool refuses — unless the deployment
 *                    explicitly accepted a model-visible link.
 */
export async function artifactUploadToolResult(input: {
  privatePicker: boolean;
  modelVisibleLinkAllowed: boolean;
  mint: () => Promise<{ uploadUrl: string; expiresAt: string }>;
}): Promise<{
  content: { type: "text"; text: string }[];
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
}> {
  if (input.privatePicker) {
    const minted = await input.mint();
    return {
      content: [{ type: "text", text: "A private document upload control is ready." }],
      _meta: { uploadUrl: minted.uploadUrl, expiresAt: minted.expiresAt },
    };
  }
  if (!input.modelVisibleLinkAllowed) {
    throw new HttpError(
      409,
      "PRIVATE_UPLOAD_UNAVAILABLE",
      "This MCP client cannot show the private file picker, and the upload link is not shared in chat. " +
        "Ask the person to upload the document from a client that shows the picker, or in the web application.",
    );
  }
  const minted = await input.mint();
  return {
    content: [{
      type: "text",
      text: `This MCP client cannot show the private file picker. Ask the person to open ${minted.uploadUrl}; the one-time link expires at ${minted.expiresAt}.`,
    }],
    structuredContent: {
      pending: true,
      uploadUrl: minted.uploadUrl,
      expiresAt: minted.expiresAt,
    },
  };
}

/** Atomically claims a single-use upload before any bytes are accepted. */
export async function claimArtifactUpload(input: {
  db: OpenShapeForgeDatabase;
  keyring: SecretKeyring;
  token: unknown;
}): Promise<PendingArtifactUpload | null> {
  return readHandoff<PendingArtifactUpload>({
    db: input.db,
    keyring: input.keyring,
    kind: "artifact_upload",
    token: input.token,
    consume: true,
  });
}

const PAGE_STYLE =
  "font:16px/1.45 system-ui,sans-serif;color:CanvasText;background:Canvas;padding:1rem;max-width:42rem;margin:auto";

let artifactUploadAppScript: Promise<string> | undefined;

async function bundledArtifactUploadApp(): Promise<string> {
  artifactUploadAppScript ??= (async () => {
    const result = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL("./artifact-upload-app-client.ts", import.meta.url),
        ),
      ],
      target: "browser",
      define: { __OSF_SOFTWARE_VERSION__: JSON.stringify(API_BUILD_IDENTITY.version) },
      minify: true,
      sourcemap: "none",
    });
    if (!result.success || !result.outputs[0]) {
      throw new Error(
        `MCP artifact upload app bundle failed: ${result.logs.map(String).join("; ")}`,
      );
    }
    return result.outputs[0].text();
  })();
  return artifactUploadAppScript;
}

export async function renderArtifactUploadApp(): Promise<string> {
  const script = await bundledArtifactUploadApp();
  return (
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Upload document</title><body style="${PAGE_STYLE}" data-product-name="${escapeHtml(productName())}">` +
    `<h2 style="font-size:1.2rem">Upload document</h2>` +
    `<p id="upload-message">Preparing the private file picker…</p>` +
    `<input id="upload-file" hidden type="file">` +
    `<progress id="upload-progress" hidden style="width:100%"></progress>` +
    `<script type="module">${script}</script></body>`
  );
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderArtifactUploadPage(uploadUrl: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Upload document</title><body style="${PAGE_STYLE}">
<h1 style="font-size:1.35rem">Upload document</h1>
<p id="message">Choose the file that should be used by ${escapeHtml(productName())}.</p>
<input id="file" type="file"><progress id="progress" hidden style="width:100%"></progress>
<script>
const url=${jsonForHtml(uploadUrl)}, file=document.getElementById('file'), message=document.getElementById('message'), progress=document.getElementById('progress');
file.addEventListener('change',async()=>{const selected=file.files&&file.files[0];if(!selected)return;file.disabled=true;progress.hidden=false;progress.removeAttribute('value');message.textContent='Uploading…';try{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':encodeURIComponent(selected.name)},body:selected});const body=await response.json();if(!response.ok)throw new Error(body?.error?.message||'Upload failed.');message.textContent='Uploaded. Return to the assistant and continue with artifactId '+body.data.artifactId+'.';progress.value=1;progress.max=1;}catch(error){message.textContent=error instanceof Error?error.message:'Upload failed.';file.disabled=false;progress.hidden=true;}});
</script></body>`;
}
