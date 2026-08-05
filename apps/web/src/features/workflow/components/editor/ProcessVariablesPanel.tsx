// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * The definition's process variables, declared and seeded.
 *
 * Assembly. What a variable is, what a key may say, what a start value means
 * and which of them a run can read is all in
 * `examples/plugins/workflow/web/editor/process-variables.ts` and
 * `variable-suggestions.ts`, because `apps/web` has no test runner and no DOM
 * environment. What is left here is inputs and the handlers they report into.
 *
 * ## Why it lives where "select a node" used to
 *
 * Process variables belong to the definition rather than to any node, so there
 * is no selection that reveals them. The inspector column is empty exactly when
 * nothing is selected, which is also the moment an author is thinking about the
 * workflow rather than about one step of it — so that is where they go, instead
 * of behind a button or in the settings sheet, which writes through a different
 * mutation and is not versioned.
 *
 * ## Every edit goes through the undo stack
 *
 * Declaring a variable changes the definition DOCUMENT — it is written by
 * `saveWorkflowDefinitionVersion`, into a new version — so it is dirty state and
 * it is undoable, exactly like moving a node. The tags below are what make
 * typing a start value one undo rather than one per keystroke.
 *
 * ## The start value is a plain input with a datalist
 *
 * A start value is a fixed value or a `{{…}}` placeholder, and the engine
 * resolves it, so what an author needs is the list of paths that will resolve —
 * which `buildProcessVariableStartValueSuggestions` computes and a native
 * `<datalist>` shows without a picker component this repo does not have. The
 * list is deliberately narrower than a node's: nothing has run when seeding
 * happens, so no node output is in it.
 */
import { useCallback, useMemo, useState } from "react";
import { Button } from "@openshapeforge/ui";
import { Input } from "@/components/ui/forms/input";
import {
  addProcessVariable,
  buildProcessVariableStartValueSuggestions,
  checkProcessVariableKey,
  describeProcessVariables,
  moveProcessVariable,
  removeProcessVariable,
  setProcessVariableField,
  setProcessVariableStartValue,
  PROCESS_VARIABLE_VALUE_TYPES,
  type EditableCanvasGraph,
  type ProcessVariableKeyRefusal,
  type ProcessVariableSet,
  type ProcessVariableValueType,
} from "../../../../../../../examples/plugins/workflow/web/editor/index";

export type ProcessVariablesPanelProps = {
  variables: ProcessVariableSet;
  /** Read for the trigger fields a start value may reference. */
  graph: EditableCanvasGraph;
  /**
   * Every change, as an operation over the set. Applied by the editor onto the
   * undo stack, with `tag` deciding whether it continues the previous one.
   */
  onEdit: (
    change: (current: ProcessVariableSet) => ProcessVariableSet,
    tag?: { kind: string; target: string },
  ) => void;
  readOnly?: boolean;
  locale?: string;
};

/** Wording for a key the rules refused. */
const KEY_REFUSAL_MESSAGE: Record<ProcessVariableKeyRefusal, string> = {
  EMPTY: "A variable needs a key.",
  ILLEGAL:
    "A key is part of a {{process.…}} path, so it can hold only letters, digits, - and _.",
  DUPLICATE: "That key is already declared.",
};

export function ProcessVariablesPanel({
  variables,
  graph,
  onEdit,
  readOnly = false,
  locale = "en",
}: ProcessVariablesPanelProps) {
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const views = useMemo(
    () => describeProcessVariables(variables, { locale }),
    [variables, locale],
  );

  const handleAdd = useCallback(() => {
    const checked = checkProcessVariableKey({
      key: newKey,
      taken: views.map((view) => view.key),
    });
    if (!checked.ok) {
      setError(KEY_REFUSAL_MESSAGE[checked.refusal]);
      return;
    }
    setError(null);
    setNewKey("");
    // No tag: declaring a variable happens once, so it is always its own undo.
    onEdit((current) => addProcessVariable(current, { key: checked.key, locale }).set);
  }, [locale, newKey, onEdit, views]);

  return (
    <section className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Process variables</h2>
        <p className="text-xs text-muted-foreground">
          State a run carries from start to finish. Every node can read one as{" "}
          <code>{"{{process.key}}"}</code>, and the set is closed — a run has
          exactly what is declared here.
        </p>
      </header>

      {views.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None declared. Select a node to configure it, or add a variable below.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {views.map((view, index) => (
            <li key={view.key} className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                {/* The key, not an input: renaming would leave every
                    {{process.key}} in every node's config pointing at nothing,
                    so it is a delete and an add. */}
                <code className="mr-auto text-xs font-medium">{view.key}</code>
                <Button
                  variant="ghost"
                  type="button"
                  aria-label={`Move ${view.key} earlier`}
                  title="Earlier. Order is seeding order: a start value can read the variables above it."
                  disabled={readOnly || index === 0}
                  onClick={() =>
                    onEdit((current) =>
                      moveProcessVariable(current, { key: view.key, direction: "up" }),
                    )
                  }
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  aria-label={`Move ${view.key} later`}
                  disabled={readOnly || index === views.length - 1}
                  onClick={() =>
                    onEdit((current) =>
                      moveProcessVariable(current, { key: view.key, direction: "down" }),
                    )
                  }
                >
                  ↓
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  aria-label={`Remove ${view.key}`}
                  disabled={readOnly}
                  onClick={() => onEdit((current) => removeProcessVariable(current, view.key))}
                >
                  Remove
                </Button>
              </div>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Name</span>
                <Input
                  value={view.label === view.key ? "" : view.label}
                  placeholder={view.key}
                  disabled={readOnly}
                  onChange={(event) =>
                    onEdit(
                      (current) =>
                        setProcessVariableField(current, {
                          key: view.key,
                          property: "label",
                          value: event.target.value,
                          locale,
                        }),
                      // Tagged by the variable it is about, so typing a name is
                      // one undo rather than one per letter.
                      { kind: "variable-label", target: view.key },
                    )
                  }
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Type</span>
                <select
                  value={view.valueType}
                  disabled={readOnly}
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                  onChange={(event) =>
                    onEdit((current) =>
                      setProcessVariableField(current, {
                        key: view.key,
                        property: "valueType",
                        value: event.target.value as ProcessVariableValueType,
                      }),
                    )
                  }
                >
                  {PROCESS_VARIABLE_VALUE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>

              <StartValueField
                variables={variables}
                graph={graph}
                variableKey={view.key}
                value={view.startValue}
                opaque={view.startValueIsOpaque}
                readOnly={readOnly}
                locale={locale}
                onEdit={onEdit}
              />
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-2 border-t border-border pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          handleAdd();
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">New variable key</span>
          <Input
            value={newKey}
            disabled={readOnly}
            placeholder="totalAmount"
            aria-label="New process variable key"
            onChange={(event) => {
              setNewKey(event.target.value);
              setError(null);
            }}
          />
        </label>
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
        <Button type="submit" disabled={readOnly}>
          Declare variable
        </Button>
      </form>
    </section>
  );
}

/**
 * A variable's start value, and the paths that will actually resolve into it.
 *
 * The suggestion list is recomputed per field because it depends on the key:
 * seeding runs in document order, so a variable may read the ones above it and
 * not the ones below.
 */
function StartValueField({
  variables,
  graph,
  variableKey,
  value,
  opaque,
  readOnly,
  locale,
  onEdit,
}: {
  variables: ProcessVariableSet;
  graph: EditableCanvasGraph;
  variableKey: string;
  value: string;
  /** The stored initializer is not text, so it is shown rather than edited. */
  opaque: boolean;
  readOnly: boolean;
  locale: string;
  onEdit: ProcessVariablesPanelProps["onEdit"];
}) {
  const listId = `process-variable-start-${variableKey}`;
  const suggestions = useMemo(
    () =>
      buildProcessVariableStartValueSuggestions({
        graph,
        processVariables: variables.fields,
        key: variableKey,
        locale,
      }),
    [graph, locale, variableKey, variables.fields],
  );

  if (opaque) {
    return (
      <p className="text-xs text-muted-foreground">
        This variable is seeded with a stored value that is not text. Editing it
        here would rewrite it, so it is left as it is.
      </p>
    );
  }

  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">Start value</span>
      <Input
        value={value}
        list={listId}
        disabled={readOnly}
        placeholder="A fixed value, or {{input.something}}"
        onChange={(event) =>
          onEdit(
            (current) =>
              setProcessVariableStartValue(current, {
                key: variableKey,
                value: event.target.value,
              }),
            { kind: "variable-start", target: variableKey },
          )
        }
      />
      <datalist id={listId}>
        {suggestions.map((suggestion) => (
          <option key={suggestion.path} value={suggestion.insertText}>
            {suggestion.label}
          </option>
        ))}
      </datalist>
    </label>
  );
}
