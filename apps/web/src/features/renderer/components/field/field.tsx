// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";

import { FieldRoot, type FieldRootProps } from "@/features/renderer/edit/field-context";
import { useRendererDefaults } from "@/features/renderer/components/renderer-defaults-context";
import { cn } from "@/lib/utils";

import { FieldControl, type FieldControlProps } from "./field-control";
import { FieldError } from "./field-error";
import {
  FieldLabel,
  HelpAffordance,
  ScreenReaderDescription,
  type Lang,
} from "./label";

type FieldDirection = "horizontal" | "vertical";

/** Figma Battery `field` matrix — which control the row showcases (documentation). */
type FieldControlKind = "input" | "textarea" | "radio";

/** Figma Battery `field` matrix — static snapshot axis (documentation). */
type FieldMatrixState = "active" | "focus" | "error" | "disabled";

type FieldProps = Omit<FieldRootProps, "children"> & {
  children: (props: FieldControlProps) => React.ReactNode;
  description?: React.ReactNode;
  /**
   * Label position relative to the control. When omitted, falls back to the
   * direction provided by the surrounding {@link RendererDefaultsProvider}
   * (set automatically by {@link Renderer} based on surface), and finally to
   * vertical for renderer-less usages.
   */
  direction?: FieldDirection;
  /** Figma Battery `orientation` — alias of {@link direction}. */
  orientation?: FieldDirection;
  /** Figma Battery `control` variant axis (for audits / Storybook matrix). */
  control?: FieldControlKind;
  /** Figma Battery `state` variant axis (for audits / Storybook matrix). */
  state?: FieldMatrixState;
  displayMode?: boolean;
  error?: React.ReactNode;
  helpText?: React.ReactNode;
  helpTitle?: string;
  lang?: Lang;
  /** When null, no label row is rendered (used with {@link RendererFieldConfig.hideLabel}). */
  label: React.ReactNode;
  labelClassName?: string;
};

/**
 * @figma node-id=261-1961 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1961
 * @figma node-id=261-1708 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1708
 * @figma node-id=261-1725 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1725
 * @figma node-id=261-1742 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1742
 * @figma node-id=261-1756 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1756
 * @figma node-id=261-1770 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1770
 * @figma node-id=261-1781 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1781
 * @figma node-id=261-1791 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1791
 * @figma node-id=261-1801 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1801
 * @figma node-id=261-1811 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1811
 * @figma node-id=261-1817 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1817
 * @figma node-id=261-1823 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1823
 * @figma node-id=261-1829 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1829
 * @figma node-id=261-1835 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1835
 * @figma node-id=261-1852 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1852
 * @figma node-id=261-1869 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1869
 * @figma node-id=261-1883 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1883
 * @figma node-id=261-1897 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1897
 * @figma node-id=261-1907 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1907
 * @figma node-id=261-1917 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1917
 * @figma node-id=261-1927 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1927
 * @figma node-id=261-1937 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1937
 * @figma node-id=261-1943 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1943
 * @figma node-id=261-1949 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1949
 * @figma node-id=261-1955 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=261-1955
 */
function Field({
  children,
  className,
  description,
  direction,
  orientation,
  control,
  state,
  displayMode,
  error,
  helpText,
  helpTitle,
  id,
  invalid,
  label,
  labelClassName,
  lang,
  required = false,
  ...props
}: FieldProps) {
  const defaults = useRendererDefaults();
  const effectiveDirection: FieldDirection =
    direction ?? orientation ?? defaults.direction ?? "vertical";
  const isHorizontal = effectiveDirection === "horizontal" && label != null;
  const hasHelpAffordance = description || helpText;

  if (isHorizontal) {
    // Horizontal layout: [label 120px] [control + help icon, error below].
    // The help icon sits next to the input (not inside the label column) so
    // it doesn't get spread to the wrong place by the 120px constraint.
    return (
      <FieldRoot
        id={id}
        className={cn("grid grid-cols-[120px_1fr] items-start gap-x-2 space-y-0", className)}
        invalid={invalid ?? Boolean(error)}
        required={required}
        data-figma-control={control}
        data-figma-state={state}
        {...props}
      >
        <FieldLabel
          className={labelClassName}
          displayMode={displayMode}
          // Help affordance is rendered next to the control, not inside the
          // label column.
        >
          {label}
        </FieldLabel>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <FieldControl>{children}</FieldControl>
            </div>
            <HelpAffordance
              description={description}
              helpText={helpText}
              helpTitle={helpTitle}
              fieldLabel={label}
              lang={lang}
            />
          </div>
          <ScreenReaderDescription description={description} />
          <FieldError>{error}</FieldError>
        </div>
      </FieldRoot>
    );
  }

  return (
    <FieldRoot
      id={id}
      className={className}
      invalid={invalid ?? Boolean(error)}
      required={required}
      data-figma-control={control}
      data-figma-state={state}
      {...props}
    >
      {label != null ? (
        <FieldLabel
          className={labelClassName}
          description={description}
          displayMode={displayMode}
          helpText={helpText}
          helpTitle={helpTitle}
          lang={lang}
        >
          {label}
        </FieldLabel>
      ) : hasHelpAffordance ? (
        // No label to anchor the help icon to — float it above the control,
        // right-aligned, so description/help still surface to the user.
        <div className="flex justify-end">
          <HelpAffordance
            description={description}
            helpText={helpText}
            helpTitle={helpTitle}
            lang={lang}
          />
          <ScreenReaderDescription description={description} />
        </div>
      ) : null}
      <FieldControl>{children}</FieldControl>
      <FieldError>{error}</FieldError>
    </FieldRoot>
  );
}

export { Field };
export type { FieldProps, FieldDirection, FieldControlKind, FieldMatrixState };
