// SPDX-License-Identifier: BUSL-1.1
import type { ComponentProps } from "react";

import { TextDisplay } from "@/features/renderer/display/text-display";

function formatBsn(value: string): string {
  const digits = value.replace(/\D/g, "");

  if (digits.length !== 9) {
    return value;
  }

  return `${digits.slice(0, 3)}.${digits.slice(3, 5)}.${digits.slice(5)}`;
}

type BsnDisplayProps = Omit<ComponentProps<typeof TextDisplay>, "children"> & {
  value: string;
};

function BsnDisplay({ value, ...props }: BsnDisplayProps) {
  return <TextDisplay {...props}>{formatBsn(value)}</TextDisplay>;
}

export { BsnDisplay, formatBsn };
