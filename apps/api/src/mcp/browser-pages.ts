// SPDX-License-Identifier: BUSL-1.1
/**
 * The pages a person sees in a browser during an MCP flow: the entity-OAuth
 * return leg (after approving a provider sign-in started by connect_service)
 * and the configuration handoff (the form an admin fills in when the client
 * cannot show the secure elicitation form).
 *
 * One layout, rendered server-side into a single self-contained document —
 * inline CSS only, system font stack, an inline SVG mark, no script, no
 * external asset. That keeps every page readable on a phone, in light and
 * dark, and compatible with a strict Content-Security-Policy should the API
 * ever send one. Every interpolated value passes through `escapeHtml`; only
 * the `bodyHtml` slot takes pre-rendered markup, and the sole producer of
 * that is the configuration form below, which escapes its own inputs.
 *
 * Copy follows one rule: say what happened, then what to do next, one short
 * sentence each. Failures never show internals (no state values, no error
 * messages from the database or a provider).
 */
import {
  elicitationSchemaFromDefinitions,
  isSecretDefinition,
} from "./elicitation.js";
import type { PendingConfiguration } from "./configuration-handoff.js";

type JsonRecord = Record<string, unknown>;

const PRODUCT_NAME = "Hubble";
const DEFAULT_HOST_NAME = PRODUCT_NAME;
const HOST_NAME_ENV = "OSF_INTEGRATION_HOST_NAME";

/** The name the deployment shows people; the integration host sets it. */
export function hostDisplayName(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[HOST_NAME_ENV]?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_HOST_NAME;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type PageTone = "success" | "error" | "neutral";

export type BrowserPage = {
  /** Document title; the host name is appended. */
  title: string;
  /** The one-line heading: what happened. */
  heading: string;
  /** One sentence expanding on the heading. */
  lead: string;
  /** One sentence on what to do now; rendered emphasised. */
  next?: string | undefined;
  tone?: PageTone | undefined;
  /** Short context shown above the heading, e.g. the provider name. */
  eyebrow?: string | undefined;
  /** Pre-escaped markup placed after the lead (the configuration form). */
  bodyHtml?: string | undefined;
  hostName?: string | undefined;
};

const STYLE = `
:root{color-scheme:light dark;
--bg:#f4f5f7;--card:#ffffff;--text:#1a1d21;--muted:#5b6470;--line:#d9dde3;
--accent:#2457c5;--accent-text:#ffffff;--focus:#2457c5;
--ok:#1d7a4a;--ok-bg:#e6f4ec;--err:#b3261e;--err-bg:#fbeae9;--info-bg:#eef3fc;--info-line:#c6d5f2;
--field-bg:#ffffff}
@media (prefers-color-scheme:dark){:root{
--bg:#131518;--card:#1c1f24;--text:#e8eaed;--muted:#a0a8b3;--line:#343a43;
--accent:#7ea2ec;--accent-text:#0f1420;--focus:#7ea2ec;
--ok:#63c58f;--ok-bg:#16301f;--err:#f2a29c;--err-bg:#3a1c1a;--info-bg:#1b2436;--info-line:#2f4166;
--field-bg:#15181c}}
*{box-sizing:border-box}
html{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2.5rem 1rem 2rem}
header.brand{display:flex;align-items:center;gap:.6rem;margin-bottom:1.5rem;color:var(--muted);font-size:.95rem}
header.brand svg{width:1.75rem;height:1.75rem;flex:none}
header.brand strong{color:var(--text);font-weight:600}
main{width:100%;max-width:32rem;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.75rem 1.5rem;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.status{display:flex;align-items:center;gap:.6rem;margin:0 0 1rem}
.status svg{width:2rem;height:2rem;flex:none}
.status.success svg{color:var(--ok)}
.status.error svg{color:var(--err)}
.status.neutral svg{color:var(--accent)}
.eyebrow{margin:0 0 .35rem;font-size:.85rem;letter-spacing:.02em;text-transform:uppercase;color:var(--muted);font-weight:600}
h1{font-size:1.35rem;line-height:1.3;margin:0 0 .75rem;font-weight:650}
p{margin:0 0 .75rem}
p.next{font-weight:600;margin-top:1rem}
p.small,small{font-size:.9rem;color:var(--muted)}
.callout{border:1px solid var(--info-line);background:var(--info-bg);border-radius:10px;padding:.75rem .9rem;margin:0 0 1rem}
.callout.error{border-color:var(--err);background:var(--err-bg)}
.field{margin:0 0 1.15rem}
.field label,.field .label{display:block;font-weight:600;margin-bottom:.25rem}
.field .hint{display:block;font-size:.9rem;color:var(--muted);margin-bottom:.4rem}
.field .req{color:var(--err);margin-left:.15rem}
.field .error{display:block;color:var(--err);font-size:.9rem;margin-top:.35rem}
input[type=text],input[type=password],input[type=number],select{width:100%;font:inherit;color:var(--text);background:var(--field-bg);border:1px solid var(--line);border-radius:8px;padding:.6rem .7rem}
input[aria-invalid=true],select[aria-invalid=true]{border-color:var(--err)}
input:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.check{display:flex;align-items:center;gap:.5rem}
.check input{width:1.1rem;height:1.1rem;margin:0}
.check label{margin:0}
button{font:inherit;font-weight:600;color:var(--accent-text);background:var(--accent);border:0;border-radius:8px;padding:.7rem 1.4rem;cursor:pointer}
footer{margin-top:1.5rem;font-size:.8rem;color:var(--muted)}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:480px){body{padding:1.25rem .75rem}main{padding:1.35rem 1.1rem;border-radius:12px}}
`.trim();

/** A lens: the Hubble mark. Uses currentColor so it follows the theme. */
const MARK_SVG =
  `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">` +
  `<circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="2.5"/>` +
  `<circle cx="16" cy="16" r="6" fill="currentColor"/>` +
  `<circle cx="13.5" cy="13.5" r="1.6" fill="var(--card,#fff)"/></svg>`;

const ICONS: Record<PageTone, string> = {
  success:
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="2"/>` +
    `<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  error:
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="2"/>` +
    `<path d="M12 7v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
    `<circle cx="12" cy="16.5" r="1.3" fill="currentColor"/></svg>`,
  neutral:
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/>` +
    `<path d="M7 9h10M7 13h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

const TONE_LABEL: Record<PageTone, string> = {
  success: "Done",
  error: "Something went wrong",
  neutral: "",
};

/** The shared layout. Everything in `page` is escaped here except `bodyHtml`. */
export function renderBrowserPage(page: BrowserPage): string {
  const hostName = page.hostName ?? hostDisplayName();
  const tone = page.tone ?? "neutral";
  const title = escapeHtml(`${page.title} · ${hostName}`);
  const brandLine =
    hostName === PRODUCT_NAME
      ? `<strong>${escapeHtml(PRODUCT_NAME)}</strong>`
      : `<strong>${escapeHtml(hostName)}</strong><span aria-hidden="true">·</span><span>${escapeHtml(PRODUCT_NAME)}</span>`;
  const status =
    tone === "neutral"
      ? ""
      : `<div class="status ${tone}">${ICONS[tone]}<span class="eyebrow">${escapeHtml(TONE_LABEL[tone])}</span></div>`;
  const eyebrow = page.eyebrow
    ? `<p class="eyebrow">${escapeHtml(page.eyebrow)}</p>`
    : "";
  const next = page.next ? `<p class="next">${escapeHtml(page.next)}</p>` : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${title}</title><style>${STYLE}</style></head>` +
    `<body><header class="brand">${MARK_SVG}${brandLine}</header>` +
    `<main>${status}${eyebrow}<h1>${escapeHtml(page.heading)}</h1>` +
    `<p>${escapeHtml(page.lead)}</p>${page.bodyHtml ?? ""}${next}</main>` +
    `<footer>Powered by OpenShapeForge</footer></body></html>`
  );
}

// ---------------------------------------------------------------------------
// Entity OAuth return leg
// ---------------------------------------------------------------------------

export type EntityOAuthOutcome =
  /** Tokens stored on the connection row. */
  | "connected"
  /** The state was unknown, already used, or expired. */
  | "invalid_state"
  /** The provider answered with an error (e.g. access_denied). */
  | "provider_refused"
  /** The provider returned without an authorization code. */
  | "no_code"
  /** Token exchange or the database write failed. */
  | "store_failed";

export type EntityOAuthPageInput = {
  outcome: EntityOAuthOutcome;
  /** Human name of the provider, when the pending record is known. */
  providerName?: string | undefined;
  /** Where the tokens landed: the person's own row or the tenant's. */
  connectionScope?: "user" | "tenant" | undefined;
  hostName?: string | undefined;
};

export function renderEntityOAuthCallbackPage(
  input: EntityOAuthPageInput,
): string {
  const hostName = input.hostName ?? hostDisplayName();
  const provider = input.providerName?.trim() || "The provider";
  const named = Boolean(input.providerName?.trim());
  const owner =
    input.connectionScope === "tenant" ? "your organization" : "your account";
  const retry = named
    ? `Go back to your chat and start the ${provider} sign-in again.`
    : "Go back to your chat and start the sign-in again.";
  const base = { hostName, eyebrow: named ? provider : undefined };
  switch (input.outcome) {
    case "connected":
      return renderBrowserPage({
        ...base,
        tone: "success",
        title: `${provider} connected`,
        heading: `${provider} is connected`,
        lead: `${provider} is now connected for ${owner} in ${hostName}.`,
        next: "Go back to your chat and run the tool again. You can close this window.",
      });
    case "invalid_state":
      return renderBrowserPage({
        ...base,
        tone: "error",
        title: "Sign-in link expired",
        heading: "This sign-in link is no longer valid",
        lead: "The link was already used or has expired, so nothing was stored.",
        next: `${retry} If the new link fails too, ask your administrator.`,
      });
    case "provider_refused":
      return renderBrowserPage({
        ...base,
        tone: "error",
        title: "Sign-in not completed",
        heading: `${provider} did not approve the sign-in`,
        lead: `The sign-in was cancelled or refused at ${provider}, so nothing was stored.`,
        next: `${retry} If you keep seeing this, ask your administrator to check the ${hostName} setup at ${provider}.`,
      });
    case "no_code":
      return renderBrowserPage({
        ...base,
        tone: "error",
        title: "Sign-in not completed",
        heading: "The sign-in did not complete",
        lead: `${provider} returned without an authorization code, so nothing was stored.`,
        next: `${retry} If it happens again, ask your administrator.`,
      });
    case "store_failed":
      return renderBrowserPage({
        ...base,
        tone: "error",
        title: "Connection not saved",
        heading: "The connection could not be saved",
        lead: `${provider} approved the sign-in, but ${hostName} could not store the connection. Nothing was stored.`,
        next: `${retry} If it happens again, ask your administrator.`,
      });
  }
}

// ---------------------------------------------------------------------------
// Configuration handoff
// ---------------------------------------------------------------------------

/** Unknown, used-up, or expired configuration token. */
export function renderConfigurationExpiredPage(hostName?: string): string {
  return renderBrowserPage({
    hostName,
    tone: "error",
    title: "Configuration link expired",
    heading: "This configuration link is no longer valid",
    lead: "The link was already used or has expired, so nothing was stored.",
    next: "Go back to your chat and ask your assistant to start the configuration again.",
  });
}

/** The row was created and the token burned. */
export function renderConfigurationSavedPage(
  displayName: string,
  hostName?: string,
): string {
  const host = hostName ?? hostDisplayName();
  const name = displayName.trim() || "The configuration";
  return renderBrowserPage({
    hostName: host,
    tone: "success",
    eyebrow: displayName.trim() || undefined,
    title: `${name} configured`,
    heading: `${name} is configured`,
    lead: `The values were saved in ${host}. Secret values are stored encrypted and are never shown again.`,
    next: "Go back to your chat and run the tool again. You can close this window.",
  });
}

/** Persisting the submission failed after validation; nothing was written. */
export function renderConfigurationFailedPage(
  displayName: string,
  hostName?: string,
): string {
  const host = hostName ?? hostDisplayName();
  const name = displayName.trim() || "this configuration";
  return renderBrowserPage({
    hostName: host,
    tone: "error",
    eyebrow: displayName.trim() || undefined,
    title: "Configuration not saved",
    heading: "The configuration could not be saved",
    lead: `${host} could not store the values for ${name}. Nothing was stored.`,
    next: "Go back to your chat and start the configuration again. If it happens again, ask your administrator.",
  });
}

/**
 * A branded page carrying one caller-supplied sentence. Kept for call sites
 * that still pass a message rather than an outcome; prefer the dedicated
 * page functions above.
 */
export function renderNoticePage(message: string, hostName?: string): string {
  return renderBrowserPage({
    hostName,
    tone: "neutral",
    title: "Configuration",
    heading: "Configuration",
    lead: message,
  });
}

type StoredFieldDefinition = {
  key?: unknown;
  valueType?: unknown;
  required?: unknown;
  label?: unknown;
  description?: unknown;
  options?: { items?: { value?: unknown; label?: unknown }[] };
};

function localized(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const en = (value as JsonRecord).en;
    if (typeof en === "string") return en;
    const first = Object.values(value as JsonRecord).find(
      (entry) => typeof entry === "string",
    );
    if (typeof first === "string") return first;
  }
  return "";
}

export type ConfigurationFormOptions = {
  /** Verification failure shown above the form after a rejected submit. */
  errorBanner?: string;
  /** Non-secret values to prefill on a retry; secrets are never echoed. */
  prefill?: Record<string, unknown>;
  hostName?: string;
};

/**
 * The form itself, generated from the same definitions the elicitation
 * schema uses. Secret-classified fields render as password inputs; values
 * travel only in the POST body, never in the URL. No script: native
 * `required` validation, server-side errors rendered back into the form.
 */
export function renderConfigurationForm(
  pending: PendingConfiguration,
  actionPath: string,
  errors: Record<string, string> = {},
  options: ConfigurationFormOptions = {},
): string {
  const hostName = options.hostName ?? hostDisplayName();
  const { elicitable, skipped } = elicitationSchemaFromDefinitions(
    pending.definitions,
  );
  const rows = (elicitable as StoredFieldDefinition[])
    .map((definition, index) => {
      const key = definition.key as string;
      const id = `field-${index}`;
      const escapedKey = escapeHtml(key);
      const label = escapeHtml(localized(definition.label) || key);
      const description = localized(definition.description);
      const required = definition.required === true;
      const error = errors[key];
      const valueType =
        typeof definition.valueType === "string"
          ? definition.valueType
          : "string";
      const optionItems = definition.options?.items;
      const secret = isSecretDefinition(definition as never);

      const describedBy = [
        description ? `${id}-hint` : "",
        secret ? `${id}-secret` : "",
        error ? `${id}-error` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const aria =
        (describedBy ? ` aria-describedby="${describedBy}"` : "") +
        (error ? ` aria-invalid="true"` : "");

      let control: string;
      let checkbox = false;
      if (Array.isArray(optionItems) && optionItems.length > 0) {
        const prefillValue = options.prefill?.[key];
        const selectOptions = optionItems
          .filter((item) => typeof item?.value === "string")
          .map((item) => {
            const value = item.value as string;
            const text = escapeHtml(localized(item.label) || value);
            const selected = prefillValue === value ? " selected" : "";
            return `<option value="${escapeHtml(value)}"${selected}>${text}</option>`;
          })
          .join("");
        control =
          `<select id="${id}" name="${escapedKey}"${required ? " required" : ""}${aria}>` +
          `${required ? "" : `<option value="">—</option>`}${selectOptions}</select>`;
      } else if (valueType === "boolean") {
        checkbox = true;
        const checked = options.prefill?.[key] === true ? " checked" : "";
        control = `<input id="${id}" type="checkbox" name="${escapedKey}"${checked}${aria}>`;
      } else {
        const type = secret
          ? "password"
          : valueType === "integer" || valueType === "number"
            ? "number"
            : "text";
        const step = valueType === "number" ? ` step="any"` : "";
        const prefillValue = !secret && options.prefill?.[key];
        const valueAttribute =
          prefillValue !== undefined &&
          prefillValue !== null &&
          prefillValue !== false
            ? ` value="${escapeHtml(String(prefillValue))}"`
            : "";
        control =
          `<input id="${id}" type="${type}" name="${escapedKey}"${step}${valueAttribute}${required ? " required" : ""}` +
          ` autocomplete="off" spellcheck="false"${aria}>`;
      }

      const requiredMark = required
        ? `<span class="req" aria-hidden="true">*</span>`
        : "";
      const hint = description
        ? `<span class="hint" id="${id}-hint">${escapeHtml(description)}</span>`
        : "";
      const secretNote = secret
        ? `<span class="hint" id="${id}-secret">Secret — stored encrypted and never shown again.</span>`
        : "";
      const errorNote = error
        ? `<span class="error" id="${id}-error">${escapeHtml(error)}</span>`
        : "";

      if (checkbox) {
        return (
          `<div class="field"><div class="check">${control}` +
          `<label for="${id}">${label}${requiredMark}</label></div>` +
          `${hint}${errorNote}</div>`
        );
      }
      return (
        `<div class="field"><label for="${id}">${label}${requiredMark}</label>` +
        `${hint}${secretNote}${control}${errorNote}</div>`
      );
    })
    .join("");

  const requiredLegend = (elicitable as StoredFieldDefinition[]).some(
    (definition) => definition.required === true,
  )
    ? `<p class="small">Fields marked <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> with an asterisk</span> are required.</p>`
    : "";
  const banner = options.errorBanner
    ? `<div class="callout error" role="alert"><p><strong>${escapeHtml(options.errorBanner)}</strong></p>` +
      `<p>Nothing was saved; correct the values and save again.</p></div>`
    : "";
  const prefix = pending.messagePrefix
    ? `<div class="callout"><p>${escapeHtml(pending.messagePrefix)}</p></div>`
    : "";
  const skippedNote =
    skipped.length > 0
      ? `<p class="small">Not collected in this form: ${escapeHtml(skipped.join(", "))}.</p>`
      : "";
  const displayName = pending.displayName.trim();
  const errorCount = Object.keys(errors).length;
  const errorSummary =
    errorCount > 0 && !options.errorBanner
      ? `<div class="callout error" role="alert"><p>Some values need attention. Nothing was saved yet.</p></div>`
      : "";

  const bodyHtml =
    banner +
    errorSummary +
    prefix +
    `<form method="post" action="${escapeHtml(actionPath)}">${requiredLegend}${rows}` +
    `<button type="submit">Save configuration</button></form>` +
    skippedNote;

  return renderBrowserPage({
    hostName,
    tone: "neutral",
    eyebrow: displayName || undefined,
    title: displayName ? `Configure ${displayName}` : "Configuration",
    heading: displayName ? `Configure ${displayName}` : "Configuration",
    lead:
      `Entered here, these values go directly to ${hostName} — never through any chat or model. ` +
      "Secret values are stored encrypted and never shown back.",
    bodyHtml,
  });
}
