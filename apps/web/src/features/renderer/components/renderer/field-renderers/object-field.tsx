// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";

import type { Field as CompilerField } from "../../../../../generated/compiler/field-contract";
import { cn } from "../../../../../lib/utils";
import { ObjectField } from "../object-field";
import {
  getRendererFullWidthSpanClass,
  getRendererGridColumnsClass,
} from "../layout-policy";
import {
  buildRendererFieldHelpText,
  hasAuthoredFieldHelp,
  translateRendererText,
} from "../../../runtime/field-utils";
import {
  getValueAtPath,
  type RendererPathPart,
} from "../../../runtime/path-utils";
import { getRenderableFieldNodeKey } from "./shared";
import type { FieldRenderContext } from "./types";

export type RenderObjectChildField = (
  ctx: FieldRenderContext,
  field: CompilerField,
  parentPath?: readonly RendererPathPart[],
  columns?: 1 | 2 | 3 | 4,
  collectionRootPath?: readonly RendererPathPart[],
) => ReactNode;

export function renderObjectFieldWithRenderer(
  ctx: FieldRenderContext,
  field: CompilerField,
  path: readonly RendererPathPart[],
  columns: 1 | 2 | 3 | 4,
  renderRenderableField: RenderObjectChildField,
  collectionRootPath?: readonly RendererPathPart[],
) {
  if (ctx.resolveEffectiveFieldMode(field) === "hidden") {
    return null;
  }

  const nodeKey = getRenderableFieldNodeKey(field, path);
  const label = translateRendererText(field.label, ctx.lang);
  const description = translateRendererText(field.description, ctx.lang);
  const helpText = hasAuthoredFieldHelp(field, ctx.lang)
    ? buildRendererFieldHelpText(field, ctx.lang)
    : undefined;
  const objectValue = getValueAtPath(ctx.structuredValues, path);
  const objectScope =
    objectValue && typeof objectValue === "object" && !Array.isArray(objectValue)
      ? (objectValue as Record<string, unknown>)
      : undefined;
  const visibleChildren = (field.children ?? []).filter(
    (child) =>
      ctx.resolveEffectiveFieldMode(child, objectScope ?? null) !== "hidden",
  );
  const childNodes = visibleChildren
    .map((child) =>
      renderRenderableField(ctx, child, path, columns, collectionRootPath),
    )
    .filter(Boolean);

  if (!childNodes || childNodes.length === 0) {
    return null;
  }

  if (childNodes.length === 1) {
    return childNodes[0];
  }

  const grid = (
    <div className={cn("grid gap-5", getRendererGridColumnsClass(columns))}>
      {childNodes}
    </div>
  );

  if (label) {
    return (
      <ObjectField
        key={nodeKey}
        id={nodeKey}
        label={label}
        description={description || undefined}
        helpText={helpText}
        lang={ctx.lang === "en" ? "en" : "nl"}
        className={getRendererFullWidthSpanClass(columns)}
        bodyClassName="pt-3"
        initialExpanded={visibleChildren.length < 10}
      >
        {grid}
      </ObjectField>
    );
  }

  return (
    <section
      key={nodeKey}
      className={cn("space-y-4", getRendererFullWidthSpanClass(columns))}
    >
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
      {grid}
    </section>
  );
}
