// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * One configuration field, rendered from the compiled contract.
 *
 * This file is the whole reason the integrations page does not grow when a
 * connector is added. It resolves a component through
 * `resolveFieldInputRender` — the SAME three-tier resolution the entity
 * renderer uses (explicit `render.component` → semantic type → value type) — so
 * a connector author picks controls with the field vocabulary they already
 * know, and no connector ships UI code.
 *
 * ## Why a local control set instead of the entity renderer
 *
 * `features/renderer` is built around an entity form: it wants a form
 * definition, a field context, relationship and referentiedata lookups. A
 * connector configuration field has none of those and never will — it is
 * scalars, static options and the occasional JSON blob, validated server-side
 * against the contract's own generated schema. Mounting the entity renderer
 * here would mean fabricating the context it expects. Sharing the RESOLVER
 * rather than the renderer keeps the one thing that must agree — which
 * component a field maps to — in one place.
 *
 * A component this form has no control for falls back to a text input rather
 * than rendering nothing, and says so, because a field an operator cannot fill
 * is worse than a plain one.
 */
import { resolveFieldInputRender } from "@/lib/field-rendering/compiler-field-rendering";
import { Input } from "@/components/ui/forms/input";
import { Label } from "@/features/renderer/edit/controls/basic/label";
import { NumberInput } from "@/features/renderer/edit/controls/basic/number-input";
import { Switch } from "@/features/renderer/edit/controls/basic/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/features/renderer/edit/controls/basic/select";
import { cn } from "@/lib/utils";
import { SECRET_SENTINEL, type ConnectorConfigField, type LocalizedText } from "./types";

/** The page is a client component, so it carries the resolved language down. */
export function localized(text: LocalizedText | undefined | null, lang: string): string {
  if (!text || typeof text !== "object") return "";
  return text[lang] ?? text.en ?? Object.values(text)[0] ?? "";
}

export type ConnectorFieldControlProps = {
  field: ConnectorConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
  lang: string;
  disabled?: boolean;
  /** Set when the API reported this field as blocking `NEEDS_REPAIR`. */
  invalid?: boolean;
};

function staticOptions(field: ConnectorConfigField) {
  return field.options?.type === "static" ? (field.options.items ?? []) : [];
}

export function ConnectorFieldControl({
  field,
  value,
  onChange,
  lang,
  disabled,
  invalid,
}: ConnectorFieldControlProps) {
  const label = localized(field.label, lang) || field.key;
  const description = localized(field.description, lang);
  const help = localized(field.help, lang);
  const options = staticOptions(field);
  const { component } = resolveFieldInputRender(field);
  const controlId = `connector-field-${field.key}`;

  // A stored secret reads back as a sentinel, never a value. So the control
  // shows that one is set and stays empty: anything else would either display a
  // credential or re-submit the sentinel as one.
  const isSetSecret = field.secret === true && value === SECRET_SENTINEL;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={controlId} className={cn(field.required && "after:content-['*'] after:ml-0.5 after:text-destructive")}>
        {label}
      </Label>
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}

      {renderControl()}

      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
      {invalid ? (
        <p className="text-xs text-destructive">
          {lang === "nl"
            ? "Dit veld is verplicht geworden en moet worden ingevuld."
            : "This field became required and must be supplied."}
        </p>
      ) : null}
    </div>
  );

  function renderControl() {
    if (options.length > 0) {
      return (
        <Select
          value={typeof value === "string" ? value : undefined}
          onValueChange={onChange}
          disabled={disabled}
        >
          <SelectTrigger id={controlId} aria-invalid={invalid || undefined}>
            <SelectValue placeholder={lang === "nl" ? "Kies…" : "Choose…"} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {localized(option.label, lang) || option.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    if (component === "Switch") {
      return (
        <Switch
          id={controlId}
          checked={value === true}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      );
    }

    if (component === "NumberInput") {
      return (
        <NumberInput
          id={controlId}
          value={typeof value === "number" ? String(value) : ""}
          // An empty box is absent, not zero: coercing "" to 0 would store a
          // number the operator never typed, and for a field like `take` that
          // is a working configuration that fetches nothing.
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? undefined : Number(raw));
          }}
          disabled={disabled}
          aria-invalid={invalid || undefined}
        />
      );
    }

    if (component === "JsonFieldEditor") {
      // Object-valued configuration is rare and always opaque to this form —
      // the contract declares `object` precisely when the shape belongs to the
      // remote system. A textarea over JSON is honest about that; the API
      // validates it against the contract's schema on save.
      return (
        <textarea
          id={controlId}
          className="border-input bg-card focus-ring-within min-h-24 w-full rounded-[var(--radius-field)] border px-2 py-[6px] font-mono text-sm outline-none"
          value={value === undefined || value === null ? "" : JSON.stringify(value, null, 2)}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          spellCheck={false}
        />
      );
    }

    return (
      <Input
        id={controlId}
        type={field.secret ? "password" : "text"}
        value={isSetSecret ? "" : typeof value === "string" ? value : ""}
        placeholder={
          isSetSecret ? (lang === "nl" ? "Ingesteld — vul in om te vervangen" : "Set — type to replace") : undefined
        }
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        autoComplete={field.secret ? "off" : undefined}
        aria-invalid={invalid || undefined}
      />
    );
  }
}
