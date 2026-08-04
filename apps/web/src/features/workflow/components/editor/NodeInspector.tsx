// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * The selected node's config, edited.
 *
 * There is no form engine here and there must not be one. `features/renderer`
 * already draws a `Field[]` — visibility rules, validation, options,
 * collections, nested objects, every control the authoring schema can name —
 * and `WorkflowNodeType.configFields` already IS that `Field[]`. All that was
 * missing between them is a `RendererFormDefinition` wrapper, which
 * `buildWorkflowNodeConfigForm` produces in the plugin's web half where it can
 * be tested.
 *
 * The assignment below is load-bearing beyond satisfying the compiler: the
 * adapter declares its result structurally, because the plugin's web project
 * cannot resolve `apps/web`'s `@/*` alias, and this line is what pins that
 * structure to the real type. A definition that stops satisfying
 * `RendererFormDefinition` fails `typecheck:web` here rather than at run time.
 *
 * ## Changes are live, not submitted
 *
 * `onChange` rather than a Submit button, because the canvas is the document:
 * a node's config has to move with the graph it belongs to, and a second
 * commit point would let a user save a graph while their edits to one node sat
 * unapplied in a panel. The form definition therefore asks for no action bar.
 */
import { useCallback, useMemo } from "react";
import { Renderer } from "@/features/renderer/components/renderer";
import type { RendererFormDefinition } from "@/features/renderer/form-definition";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import type { Field } from "@/generated/compiler/field-contract";
import { Input } from "@/components/ui/forms/input";
import {
  buildWorkflowNodeConfigForm,
  type WorkflowVariableSuggestion,
} from "../../../../../../../examples/plugins/workflow/web/editor/index";

export type WorkflowNodeInspectorProps = {
  nodeId: string;
  /** The stored node type, for the subtitle and the definition id. */
  nodeType: string;
  /** The reader's name for the type, resolved by the caller from the catalog. */
  typeLabel: string;
  label: string;
  config: Record<string, unknown>;
  /** The catalog's `configFields` for this node type, as it served them. */
  configFields: unknown;
  /**
   * What this node can see, from the graph walk in the plugin's web half.
   *
   * Threaded into `params.suggestions`, which is the contract
   * `workflowGraphVariables` declares: it is a protocol adapter that returns
   * whatever it is handed, because the server's copy cannot see a canvas.
   */
  variableSuggestions?: readonly WorkflowVariableSuggestion[];
  onLabelChange: (label: string) => void;
  onConfigChange: (config: Record<string, unknown>) => void;
  readOnly?: boolean;
  /** Locale for field labels. English unless a caller says otherwise. */
  lang?: string;
};

export function WorkflowNodeInspector({
  nodeId,
  nodeType,
  typeLabel,
  label,
  config,
  configFields,
  variableSuggestions,
  onLabelChange,
  onConfigChange,
  readOnly = false,
  lang = "en",
}: WorkflowNodeInspectorProps) {
  // The second pin, and the reason the walk's result type is declared
  // structurally rather than imported: this assignment is what holds a
  // suggestion to `VariableSuggestion`, so a shape that drifts fails
  // `typecheck:web` here.
  const suggestions: VariableSuggestion[] = useMemo(
    () => [...(variableSuggestions ?? [])],
    [variableSuggestions],
  );

  // The pin. `buildWorkflowNodeConfigForm` declares its result structurally
  // and this annotation is what holds it to the renderer's own type.
  const definition: RendererFormDefinition | null = useMemo(
    () =>
      buildWorkflowNodeConfigForm<Field>({
        nodeType,
        configFields,
        variableSuggestions: suggestions,
      }),
    [nodeType, configFields, suggestions],
  );

  const handleChange = useCallback(
    (values: Record<string, unknown>) => {
      if (readOnly) return;
      // A new object every time, never a mutation of the one that arrived: the
      // save path tells "the caller replaced this" from "the caller handed it
      // back" by reference, so editing in place would make the edit invisible.
      onConfigChange({ ...values });
    },
    [onConfigChange, readOnly],
  );

  return (
    <section className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{typeLabel}</h2>
        {/* The id, because it is what every server-side validation finding
            names — a panel that showed only the label would leave a reader
            unable to connect an issue to what they are looking at. */}
        <p className="font-mono text-xs text-muted-foreground">{nodeId}</p>
      </header>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Name</span>
        <Input
          value={label}
          disabled={readOnly}
          onChange={(event) => onLabelChange(event.currentTarget.value)}
        />
      </label>

      {definition ? (
        <Renderer
          // Remounted per node rather than reused: the renderer seeds its form
          // state from `initialData` on mount, so a shared instance would carry
          // one node's values onto the next node selected.
          key={nodeId}
          definition={readOnly ? { ...definition, mode: "display" } : definition}
          lang={lang}
          initialData={config}
          onChange={handleChange}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          This node type has nothing to configure.
        </p>
      )}
    </section>
  );
}
