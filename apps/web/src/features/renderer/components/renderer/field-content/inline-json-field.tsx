// SPDX-License-Identifier: BUSL-1.1
import { useEffect, useState, type ReactNode } from "react";
import { Button, InputMultiline } from "@openshapeforge/ui";
import type { FieldControlProps } from "@/features/renderer/components/field";
import type { Field } from "@/generated/compiler/field-contract";

function stringifyJsonValue(value: unknown) {
  if (value === undefined) {
    return "";
  }

  return JSON.stringify(value, null, 2);
}

export function InlineJsonField({
  field,
  value,
  controlProps,
  onChange,
  onBlur,
  isSubmitting,
  lang,
}: {
  field: Field;
  value: unknown;
  controlProps: FieldControlProps;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  isSubmitting: boolean;
  lang: string;
}): ReactNode {
  const [text, setText] = useState(() => stringifyJsonValue(value));
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setText(stringifyJsonValue(value));
    setError(undefined);
  }, [value]);

  function commit(nextText: string) {
    if (nextText.trim().length === 0) {
      onChange(undefined);
      setError(undefined);
      onBlur();
      return;
    }

    try {
      onChange(JSON.parse(nextText));
      setError(undefined);
      onBlur();
    } catch {
      setError(lang === "nl" ? "Ongeldige JSON." : "Invalid JSON.");
    }
  }

  return (
    <div className="space-y-2">
      <InputMultiline
        id={controlProps.id}
        aria-describedby={controlProps["aria-describedby"]}
        aria-invalid={error ? true : controlProps["aria-invalid"]}
        name={field.key}
        disabled={isSubmitting}
        readOnly={false}
        rows={
          typeof field.render?.props?.rows === "number"
            ? field.render.props.rows
            : 10
        }
        className="font-mono text-xs"
        value={text}
        onChange={(event) => {
          setText(event.currentTarget.value);
          if (error) {
            setError(undefined);
          }
        }}
        onBlur={() => commit(text)}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => commit(text)}
        >
          {lang === "nl" ? "JSON toepassen" : "Apply JSON"}
        </Button>
      </div>
    </div>
  );
}
