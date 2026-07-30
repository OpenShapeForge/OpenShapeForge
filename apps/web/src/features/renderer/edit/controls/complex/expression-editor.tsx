// SPDX-License-Identifier: BUSL-1.1
"use client";

import { cn } from "@/lib/utils";
import { InputMultiline } from "@openshapeforge/ui";

type ExpressionEditorProps = React.ComponentProps<typeof InputMultiline> & {
  languageHint?: string;
};

function ExpressionEditor({
  className,
  languageHint = "Expression",
  ...props
}: ExpressionEditorProps) {
  return (
    <div className="space-y-2">
      <InputMultiline
        {...props}
        className={cn(
          "min-h-28 font-mono text-sm leading-6 tracking-tight",
          className,
        )}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        data-language-hint={languageHint}
      />
      <p className="text-xs text-muted-foreground">
        Gebruik paden uit de variabelezoeker, bijv.{" "}
        <code>{"{{nodes.<upstream>.output.<veld>}} == 'approved'"}</code>.
      </p>
    </div>
  );
}

export { ExpressionEditor };
