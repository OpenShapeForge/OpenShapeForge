// SPDX-License-Identifier: BUSL-1.1
/**
 * Main Renderer component — the top-level entry point for rendering a form UI.
 *
 * Accepts a {@link RendererFormDefinition} and produces a complete, interactive
 * form with title, description, tab navigation (when the definition uses tab
 * groups), field groups, validation, and a submit action bar.
 *
 * Display modes (create / edit / display) are driven by the definition's `mode`
 * property. Tab state can be controlled externally or managed internally.
 *
 * @input  RendererFormDefinition, optional initialData, language, permissions
 * @output Rendered <form> element with grouped fields and submission handling
 */
"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@openshapeforge/ui";
import { TabBar } from "@/components/ui/navigation/tab-bar";
import {
  buildRendererTabHref,
  getGroupInterpretation,
  type RendererTabNavigation,
} from "@/features/renderer/components/renderer/tab-navigation";
import type { RendererFormSubmissionResult } from "@/features/renderer/components/renderer/state";
import { useRendererForm } from "@/features/renderer/components/renderer/use-renderer-form";
import {
  renderGroup,
  renderTabContent,
  type GroupRenderContext,
} from "@/features/renderer/components/renderer/group-renderers";
import type {
  RendererFormDefinition,
} from "@/features/renderer/form-definition";
import type { RendererCustomFieldRenderProps } from "@/features/renderer/components/renderer/field-renderers";
import { RendererDefaultsProvider } from "@/features/renderer/components/renderer-defaults-context";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";
import { useFormVariableSuggestions } from "@/features/renderer/runtime/use-form-variable-suggestions";
import { useEntityFieldSuggestionsVersion } from "@/features/renderer/runtime/use-entity-field-suggestions-version";
import { isFieldCollection } from "@/lib/field-contract/field-v2";
import type { Field as CompilerField } from "@/generated/compiler/field-contract";

function fieldUsesImplicitChipVariableSource(field: CompilerField): boolean {
  if (
    field.valueType === "string" &&
    !isFieldCollection(field) &&
    field.render?.props?.variableTokens === true &&
    field.render?.props?.type !== "password"
  ) {
    return true;
  }
  return (
    field.semanticType === "condition" ||
    field.render?.component === "ConditionBuilder"
  );
}

function formUsesImplicitChipVariableSource(definition: RendererFormDefinition): boolean {
  return definition.fields.some(fieldUsesImplicitChipVariableSource);
}

function withImplicitChipVariableSource(
  definition: RendererFormDefinition,
): RendererFormDefinition["variableSources"] {
  const sources = definition.variableSources ?? [];
  if (!formUsesImplicitChipVariableSource(definition)) {
    return sources;
  }
  if (sources.some((source) => source.key === "chips")) {
    return sources;
  }
  return [
    ...sources,
    {
      key: "chips",
      resolver: "chips",
    },
  ];
}

interface RendererProps {
  definition: RendererFormDefinition;
  lang?: string;
  showTitle?: boolean;
  showDescription?: boolean;
  initialData?: Record<string, unknown> | null;
  action?: (input: Record<string, unknown>) => Promise<{ id?: string } | undefined>;
  id?: string;
  grantedPermissions?: readonly string[];
  onSubmit?:
    | ((
        values: Record<string, unknown>,
      ) =>
        | void
        | RendererFormSubmissionResult
        | Promise<void | RendererFormSubmissionResult>)
    | undefined;
  activeTabId?: string;
  onTabChange?: (tabId: string) => void;
  getTabHref?: (tabId: string) => string | undefined;
  tabNavigation?: RendererTabNavigation;
  tabAriaLabel?: string;
  onChange?: (values: Record<string, unknown>) => void;
  validationMode?: "submit" | "eager";
  externalFieldErrors?: Record<string, string | undefined>;
  renderCustomField?: (props: RendererCustomFieldRenderProps) => ReactNode | null | undefined;
  /**
   * Default direction for every Field rendered through this Renderer.
   * Per-field `RendererFieldConfig.direction` overrides this. The workflow
   * inspector pane sets `"horizontal"` so its label-input pairs render
   * label-left / input-right; entity create/edit pages keep the default
   * vertical layout.
   */
  fieldDirection?: "horizontal" | "vertical";
}

export function Renderer({
  definition,
  lang = "nl",
  showTitle,
  showDescription,
  initialData,
  action,
  id,
  grantedPermissions,
  onSubmit,
  activeTabId: controlledActiveTabId,
  onTabChange,
  getTabHref,
  tabNavigation,
  tabAriaLabel,
  onChange,
  validationMode,
  externalFieldErrors,
  renderCustomField,
  fieldDirection,
}: RendererProps) {
  const rendererForm = useRendererForm({
    definition,
    lang,
    initialData,
    action,
    id,
    grantedPermissions,
    validationMode,
    externalFieldErrors,
    onSubmit,
  });

  const structuredValuesSnapshot = useMemo(
    () => JSON.stringify(rendererForm.structuredValues),
    [rendererForm.structuredValues],
  );
  const initialDataSnapshot = useMemo(
    () => JSON.stringify(initialData ?? null),
    [initialData],
  );
  const isMounted = useRef(false);
  const previousInitialDataSnapshot = useRef(initialDataSnapshot);
  const lastEmittedSnapshot = useRef<string | null>(structuredValuesSnapshot);
  useEffect(() => {
    if (!onChange) {
      previousInitialDataSnapshot.current = initialDataSnapshot;
      lastEmittedSnapshot.current = structuredValuesSnapshot;
      return;
    }

    const initialDataChanged =
      previousInitialDataSnapshot.current !== initialDataSnapshot;
    previousInitialDataSnapshot.current = initialDataSnapshot;

    if (!isMounted.current) {
      isMounted.current = true;
      lastEmittedSnapshot.current = structuredValuesSnapshot;
      return;
    }

    if (initialDataChanged) {
      lastEmittedSnapshot.current = initialDataSnapshot;
      return;
    }

    if (lastEmittedSnapshot.current === structuredValuesSnapshot) {
      return;
    }

    lastEmittedSnapshot.current = structuredValuesSnapshot;
    onChange(rendererForm.structuredValues);
  }, [
    initialDataSnapshot,
    onChange,
    rendererForm.structuredValues,
    structuredValuesSnapshot,
  ]);

  const topLevelInterpretation = getGroupInterpretation(
    definition.presentation?.groupInterpretation,
    0,
  );
  const tabGroups = definition.groups;
  const usesTopLevelTabs =
    topLevelInterpretation === "tab" && tabGroups.length > 1;
  const defaultTabId = tabNavigation?.defaultTabId ?? tabGroups[0]?.id ?? "";
  const [uncontrolledActiveTabId, setUncontrolledActiveTabId] = useState(tabGroups[0]?.id ?? "");
  const activeTabId = controlledActiveTabId ?? uncontrolledActiveTabId;

  useEffect(() => {
    if (tabGroups.length === 0) {
      return;
    }

    if (!tabGroups.some((group) => group.id === activeTabId)) {
      setUncontrolledActiveTabId(tabGroups[0]?.id ?? "");
    }
  }, [activeTabId, tabGroups]);

  const submitAction = definition.actions?.find((item) => item.kind === "submit");
  const submitLabel =
    translateRendererText(submitAction?.label ?? definition.submitLabel, lang) || "Save";
  const resolvedShowTitle =
    showTitle ?? definition.presentation?.chrome?.showTitle ?? true;
  const resolvedShowDescription =
    showDescription ?? definition.presentation?.chrome?.showDescription ?? true;
  const showGroupTitles = definition.presentation?.chrome?.showGroupTitles ?? true;
  const showGroupDescriptions =
    definition.presentation?.chrome?.showGroupDescriptions ?? true;
  const showActionBar =
    definition.mode !== "display" &&
    (definition.presentation?.chrome?.showActionBar ?? true);

  const activeTabGroup =
    usesTopLevelTabs
      ? tabGroups.find((group) => group.id === activeTabId) ?? tabGroups[0]
      : null;

  const variableSources = useMemo(
    () => withImplicitChipVariableSource(definition),
    [definition],
  );

  const resolvedVariableSources = useFormVariableSuggestions(
    variableSources,
    rendererForm.structuredValues,
    lang,
  );

  // Re-render when the entity field-suggestion cache fills. The legacy
  // `suggestions.sourceField` path and the workflow trigger-condition builder
  // read suggestions synchronously via getEntityFieldSuggestions /
  // getEntityConditionFilterFields, which fetch on a cache miss; this
  // subscription surfaces the loaded data without each call site needing a hook.
  useEntityFieldSuggestionsVersion();

  const surface = definition.presentation?.surface;
  // Inspector / workspace / embedded surfaces show fields in a narrow column
  // where labels belong inline (left of the control). Default to horizontal so
  // every Form definition rendered into these surfaces is consistent without
  // each call site having to remember to pass `fieldDirection="horizontal"`.
  const effectiveFieldDirection: "horizontal" | "vertical" | undefined =
    fieldDirection ??
    (surface === "inspector" || surface === "workspace" || surface === "embedded"
      ? "horizontal"
      : undefined);

  const ctx: GroupRenderContext = {
    lang,
    surface,
    structuredValues: rendererForm.structuredValues,
    manualErrors: rendererForm.manualErrors,
    isSubmitting: rendererForm.isSubmitting,
    fieldsByKey: rendererForm.fieldsByKey,
    fieldConfigByKey: rendererForm.fieldConfigByKey,
    validationFieldsByKey: rendererForm.validationFieldsByKey,
    resolvedVariableSources,
    form: rendererForm.form,
    resolveEffectiveFieldMode: rendererForm.resolveEffectiveFieldMode,
    clearManualErrorsForPrefix: rendererForm.clearManualErrorsForPrefix,
    updateCollectionPathValue: rendererForm.updateCollectionPathValue,
    optionalSectionOverrides: rendererForm.optionalSectionOverrides,
    setOptionalSectionOverride: rendererForm.setOptionalSectionOverride,
    setManualErrors: rendererForm.setManualErrors,
    setCollectionValues: rendererForm.setCollectionValues,
    renderCustomField,
    fieldDirection: effectiveFieldDirection,
    definition,
    showGroupTitles,
    showGroupDescriptions,
  };

  const isContainedSurface =
    definition.presentation?.surface === "inspector" ||
    definition.presentation?.surface === "workspace" ||
    definition.presentation?.surface === "embedded";
  const rendersFormElement = definition.presentation?.surface !== "embedded";
  const formContent = (
    <>
      {rendererForm.form.formError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {rendererForm.form.formError}
        </p>
      ) : null}
      {usesTopLevelTabs ? (
        <>
          <TabBar
            tabs={tabGroups.map((group) => ({
              id: group.id,
              label: translateRendererText(group.title, lang) || group.id,
              href: getTabHref?.(group.id) ??
                (tabNavigation
                  ? buildRendererTabHref(group.id, tabNavigation, defaultTabId)
                  : undefined),
              prefetch: false,
              scroll: false,
            }))}
            activeTab={activeTabGroup?.id ?? tabGroups[0]?.id ?? ""}
            onTabChange={(tabId) => {
              onTabChange?.(tabId);
              if (!controlledActiveTabId) {
                setUncontrolledActiveTabId(tabId);
              }
            }}
            aria-label={tabAriaLabel ?? (lang === "nl" ? "Formuliertabbladen" : "Form tabs")}
          />
          {activeTabGroup ? renderTabContent(ctx, activeTabGroup) : null}
        </>
      ) : (
        definition.groups.map((group) => renderGroup(ctx, group, 0))
      )}

      {showActionBar ? (
        <div className="flex justify-end border-t border-border/60 pt-4">
          <Button
            type={rendersFormElement ? "submit" : "button"}
            disabled={rendererForm.isSubmitting}
            onClick={
              rendersFormElement
                ? undefined
                : (event) => {
                    void rendererForm.handleSubmit(
                      event as unknown as React.FormEvent<HTMLFormElement>,
                    );
                  }
            }
          >
            {rendererForm.isSubmitting ? "..." : submitLabel}
          </Button>
        </div>
      ) : null}
    </>
  );

  return (
    <RendererDefaultsProvider direction={effectiveFieldDirection}>
    <div
      className={
        isContainedSurface
          ? "flex w-full flex-col gap-6"
          : "flex w-full flex-col gap-8"
      }
    >
      <div className="space-y-2">
        {resolvedShowTitle ? (
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            {translateRendererText(definition.title, lang) || "Form"}
          </h1>
        ) : null}
        {resolvedShowDescription && definition.description ? (
          <p className="max-w-3xl text-sm text-muted-foreground">
            {translateRendererText(definition.description, lang)}
          </p>
        ) : null}
      </div>

      {rendersFormElement ? (
        <form
          noValidate
          className="space-y-6"
          onSubmit={rendererForm.handleSubmit}
        >
          {formContent}
        </form>
      ) : (
        <div className="space-y-6">
          {formContent}
        </div>
      )}
    </div>
    </RendererDefaultsProvider>
  );
}
