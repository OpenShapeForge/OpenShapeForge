// SPDX-License-Identifier: BUSL-1.1
import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

const message = document.getElementById("upload-message")!;
const file = document.getElementById("upload-file") as HTMLInputElement;
const progress = document.getElementById(
  "upload-progress",
) as HTMLProgressElement;
let uploadUrl = "";

const app = new App({ name: "Document upload", version: "1.0.0" });
app.ontoolresult = (result) => {
  const meta = result._meta as { uploadUrl?: unknown } | undefined;
  if (typeof meta?.uploadUrl !== "string") {
    message.textContent = "No private upload was supplied.";
    return;
  }
  uploadUrl = meta.uploadUrl;
  // The page that embeds this script names the deployment (data-product-name).
  const product = document.body.dataset.productName || "the application";
  message.textContent =
    `Choose a file. Its bytes go directly to ${product}, not through the model.`;
  file.hidden = false;
};

file.addEventListener("change", async () => {
  const selected = file.files?.[0];
  if (!selected || !uploadUrl) return;
  file.disabled = true;
  progress.hidden = false;
  progress.removeAttribute("value");
  message.textContent = "Uploading…";
  try {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(selected.name),
      },
      body: selected,
    });
    const body = (await response.json()) as {
      data?: {
        artifactId?: unknown;
        fileName?: unknown;
        mediaType?: unknown;
        byteSize?: unknown;
      };
      error?: { message?: unknown };
    };
    if (!response.ok || typeof body.data?.artifactId !== "string") {
      throw new Error(
        typeof body.error?.message === "string"
          ? body.error.message
          : "Upload failed.",
      );
    }
    const uploaded = body.data;
    progress.value = 1;
    progress.max = 1;
    message.textContent = `${String(uploaded.fileName ?? selected.name)} uploaded.`;
    await app.updateModelContext({
      content: [
        {
          type: "text",
          text: `The user uploaded ${String(uploaded.fileName ?? selected.name)}. Use artifactId ${uploaded.artifactId} in the requested create operation.`,
        },
      ],
      structuredContent: { artifact: uploaded },
    });
    await app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: "The document file is uploaded. Continue the requested operation with the supplied artifact.",
        },
      ],
    });
  } catch (error) {
    message.textContent =
      error instanceof Error ? error.message : "Upload failed.";
    file.disabled = false;
    progress.hidden = true;
  }
});

window.addEventListener("error", (event) => {
  console.error(event.error);
  message.textContent =
    "The private file picker could not be opened in this client.";
});
await app.connect();
