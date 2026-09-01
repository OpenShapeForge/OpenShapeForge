// SPDX-License-Identifier: BUSL-1.1
import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

const title = document.getElementById("configuration-title")!;
const message = document.getElementById("configuration-message")!;
const frame = document.getElementById("configuration-frame") as HTMLIFrameElement;
const button = document.getElementById("configuration-open") as HTMLButtonElement;
let formUrl = "";

const app = new App({ name: "KERN secure configuration", version: "1.0.0" });
app.ontoolresult = (result) => {
  const meta = result._meta as
    | { configurationUrl?: unknown; displayName?: unknown }
    | undefined;
  if (typeof meta?.configurationUrl !== "string") {
    message.textContent = "No secure configuration form was supplied.";
    return;
  }
  formUrl = meta.configurationUrl;
  title.textContent =
    typeof meta.displayName === "string"
      ? `Configure ${meta.displayName}`
      : "Secure configuration";
  message.textContent =
    "Values go directly to KERN and never through the model.";
  frame.src = formUrl;
  frame.hidden = false;
  button.hidden = false;
};
button.addEventListener("click", () => {
  if (formUrl) void app.openLink({ url: formUrl });
});
window.addEventListener("error", (event) => {
  console.error(event.error);
  message.textContent = "The secure form could not be opened in this client.";
});
await app.connect();
