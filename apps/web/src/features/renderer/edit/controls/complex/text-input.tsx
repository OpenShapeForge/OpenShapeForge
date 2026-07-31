// SPDX-License-Identifier: BUSL-1.1
"use client";

import { PlainTextInputControl } from "./text-input/plain-control";
import { TokenizedTextInputControl } from "./text-input/tokenized-control";
import type { TextInputProps } from "./text-input/types";
import { VariableSelectTextInputControl } from "./text-input/variable-select-control";

export type { TextInputBehavior, TextInputVariant } from "./text-input/types";
export { TextInputExpressionDisplay } from "./text-input/expression-display";

export function TextInput({
  behavior = "plain",
  ...props
}: TextInputProps) {
  if (behavior === "variable-select") {
    return <VariableSelectTextInputControl {...props} />;
  }

  if (behavior === "variable-token") {
    return <TokenizedTextInputControl {...props} />;
  }

  return <PlainTextInputControl {...props} />;
}
