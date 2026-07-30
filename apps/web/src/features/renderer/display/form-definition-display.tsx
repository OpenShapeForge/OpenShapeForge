// SPDX-License-Identifier: BUSL-1.1
import { Renderer } from "@/features/renderer/components/renderer";
import type { RendererFormDefinition } from "@/features/renderer/form-definition";
import { TextDisplay } from "@/features/renderer/display/text-display";

type FormDefinitionDisplayProps = {
  value: unknown;
  lang: string;
  /** Prior answers for this task (maps to `task.output`). */
  initialOutput?: Record<string, unknown> | null;
  taskId?: string;
  /** When set, the embedded form submit persists structured values to `task.output`. */
  onPersistOutput?: (output: Record<string, unknown>) => Promise<void>;
};

function isRendererFormDefinition(value: unknown): value is RendererFormDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RendererFormDefinition>;
  return (
    candidate.kind === "form" &&
    typeof candidate.schemaVersion === "number" &&
    Array.isArray(candidate.groups) &&
    Array.isArray(candidate.fields)
  );
}

function buildEmbeddedDefinition(
  definition: RendererFormDefinition,
  options?: { showSubmitBar?: boolean },
): RendererFormDefinition {
  const showSubmitBar = options?.showSubmitBar ?? false;
  // When used purely as a preview (no submit bar), always suppress the action bar
  // regardless of the inner definition's mode — this prevents embedded previews from
  // inadvertently surfacing submit buttons that have no server action wired up.
  const showActionBar = showSubmitBar;
  return {
    ...definition,
    presentation: {
      ...definition.presentation,
      surface: "embedded",
      /** Narrow rails: single column (stored definition may request more). */
      layout: {
        ...definition.presentation?.layout,
        columns: 1,
      },
      groupInterpretation: ["none"],
      chrome: {
        ...definition.presentation?.chrome,
        showActionBar,
      },
    },
  };
}

export function FormDefinitionDisplay({
  value,
  lang,
  initialOutput,
  taskId,
  onPersistOutput,
}: FormDefinitionDisplayProps) {
  if (!isRendererFormDefinition(value)) {
    return (
      <TextDisplay className="text-muted-foreground">
        {lang === "nl"
          ? "Geen renderbare formulierdefinitie beschikbaar."
          : "No renderable form definition available."}
      </TextDisplay>
    );
  }

  if (value.groups.length === 0 || value.fields.length === 0) {
    return (
      <TextDisplay className="text-muted-foreground">
        {lang === "nl"
          ? "De formulierdefinitie bevat nog geen renderbare velden."
          : "The form definition does not contain renderable fields yet."}
      </TextDisplay>
    );
  }

  const persist = Boolean(onPersistOutput && taskId);

  return (
    <div className="rounded-xl border border-border/60 bg-background/60 p-4">
      <Renderer
        definition={buildEmbeddedDefinition(value, { showSubmitBar: persist })}
        lang={lang}
        showTitle={false}
        showDescription={false}
        initialData={initialOutput ?? {}}
        onSubmit={
          persist
            ? async (submissionValues) => {
                await onPersistOutput!(submissionValues);
              }
            : undefined
        }
      />
    </div>
  );
}
