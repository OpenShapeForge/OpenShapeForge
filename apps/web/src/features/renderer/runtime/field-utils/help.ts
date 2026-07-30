// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import {
  getFieldSemanticTypeDefinition,
  resolveFieldInputRender,
} from "@/lib/field-rendering/compiler-field-rendering";
import { translateRendererText } from "./text";

/**
 * Whether the field carries authored help-text-like content — i.e.
 * `field.help` or `field.description` was set in the canonical schema.
 *
 * Used as the trigger gate for the help-icon affordance: auto-derived
 * metadata (audit, classification, retention, source hint, component-specific
 * notes) is informative but not authored "help" — it should not, on its own,
 * cause a `?` icon to appear on the field. When authored help/description
 * exists, the icon shows and the dialog content includes the auto-metadata
 * alongside.
 */
export function hasAuthoredFieldHelp(field: Field, lang: string): boolean {
  const help = translateRendererText(field.help, lang);
  if (help.trim().length > 0) return true;
  const description = translateRendererText(field.description, lang);
  return description.trim().length > 0;
}

export function buildRendererFieldHelpText(field: Field, lang: string) {
  const segments: string[] = [];
  const authoredHelp = translateRendererText(field.help, lang);
  if (authoredHelp) {
    segments.push(authoredHelp);
  }

  const requirements = translateRendererText(field.hints?.requirements, lang);
  if (requirements) {
    segments.push(requirements);
  }

  const sourceHint = field.hints?.sourceHint?.trim();
  if (sourceHint) {
    segments.push(
      lang === "nl" ? `Bron: ${sourceHint}` : `Source: ${sourceHint}`,
    );
  }

  if (field.audit) {
    segments.push(
      lang === "nl"
        ? "Wijzigingen in dit veld worden gelogd."
        : "Changes to this field are audited.",
    );
  }

  if (field.classification?.sensitivity) {
    segments.push(
      lang === "nl"
        ? `Classificatie: ${field.classification.sensitivity}`
        : `Classification: ${field.classification.sensitivity}`,
    );
  }

  if (field.retention?.duration) {
    const action = field.retention.disposition?.action;
    const reason = translateRendererText(field.retention.reason, lang);
    segments.push(
      lang === "nl"
        ? `Bewaarbeleid: ${field.retention.duration} (${action}${reason ? `, ${reason}` : ""})`
        : `Retention: ${field.retention.duration} (${action}${reason ? `, ${reason}` : ""})`,
    );
  }

  const component = resolveFieldInputRender(field).component;
  if (component === "AddressAutocomplete") {
    segments.push(
      lang === "nl"
        ? "Autocomplete is nog niet gekoppeld in de web-client, dus dit veld accepteert voorlopig vrije tekst."
        : "Autocomplete is not wired yet in the web client, so this field currently accepts plain text.",
    );
  }

  if (component === "MapPicker") {
    segments.push(
      lang === "nl"
        ? "Kaartselectie is nog niet gekoppeld in de web-client, dus dit veld accepteert voorlopig vrije tekst."
        : "Map picking is not wired yet in the web client, so this field currently accepts plain text.",
    );
  }

  return segments.length > 0 ? segments.join("\n") : undefined;
}

export function getRendererFieldLanguageHint(
  field: Field,
  lang: string,
  renderProps?: Record<string, unknown>,
) {
  const explicit =
    typeof renderProps?.languageHint === "string"
      ? renderProps.languageHint
      : undefined;
  if (explicit) return explicit;

  const semanticType = getFieldSemanticTypeDefinition(field);
  return (
    translateRendererText(field.label, lang) ||
    translateRendererText(semanticType?.label, lang) ||
    field.key
  );
}
