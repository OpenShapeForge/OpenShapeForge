// SPDX-License-Identifier: BUSL-1.1
declare const __OSF_SOFTWARE_VERSION__: string;
import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

const title = document.getElementById("configuration-title")!;
const message = document.getElementById("configuration-message")!;
const frame = document.getElementById("configuration-frame") as HTMLIFrameElement;
const button = document.getElementById("configuration-open") as HTMLButtonElement;
let formUrl = "";

const app = new App({
  name: "Secure configuration",
  version: __OSF_SOFTWARE_VERSION__,
});
app.ontoolresult = (result) => {
  const meta = result._meta as
    | { configurationUrl?: unknown; displayName?: unknown }
    | undefined;
  if (typeof meta?.configurationUrl !== "string") {
    // The searchable executor also carries ordinary reads and writes. They
    // neither supply a form nor revoke an earlier private handoff.
    if (!formUrl) document.body.hidden = true;
    return;
  }
  document.body.hidden = false;
  formUrl = meta.configurationUrl;
  title.textContent =
    typeof meta.displayName === "string"
      ? `Configure ${meta.displayName}`
      : "Secure configuration";
  message.textContent =
    "Values go directly to the secure configuration service and never through the model.";
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
