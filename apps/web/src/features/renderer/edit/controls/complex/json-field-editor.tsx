// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useState } from "react";
import { Button } from "@openshapeforge/ui";
import { Field as FieldFrame } from "@/features/renderer/components/field";
import { InputMultiline } from "@openshapeforge/ui";

export type JsonFieldEditorProps = {
  label: string;
  lang: "nl" | "en";
  value: unknown;
  onChange: (value: unknown) => void;
  description?: string;
  rows?: number;
};

function stringifyJsonValue(value: unknown) {
  if (value === undefined) {
    return "";
  }

  return JSON.stringify(value, null, 2);
}

function JsonFieldEditor({
  label,
  lang,
  value,
  onChange,
  description,
  rows = 8,
}: JsonFieldEditorProps) {
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
      return;
    }

    try {
      onChange(JSON.parse(nextText));
      setError(undefined);
    } catch {
      setError(lang === "nl" ? "Ongeldige JSON." : "Invalid JSON.");
    }
  }

  return (
    <FieldFrame label={label} description={description} error={error}>
      {(controlProps) => (
        <div className="space-y-2">
          <InputMultiline
            {...controlProps}
            rows={rows}
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
          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" onClick={() => commit(text)}>
              {lang === "nl" ? "JSON toepassen" : "Apply JSON"}
            </Button>
          </div>
        </div>
      )}
    </FieldFrame>
  );
}

export { JsonFieldEditor };
