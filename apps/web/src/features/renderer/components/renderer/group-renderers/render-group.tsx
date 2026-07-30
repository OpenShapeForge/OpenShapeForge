// SPDX-License-Identifier: BUSL-1.1
import { Fragment, type ReactNode } from "react";
import { Button } from "@openshapeforge/ui";
import { Card, CardContent, CardHeader } from "@/components/ui/display/card";
import {
  renderRenderableField,
} from "@/features/renderer/components/renderer/field-renderers";
import { getRendererGridColumnsClass } from "@/features/renderer/components/renderer/layout-policy";
import {
  getOptionalSectionState,
  setOptionalSectionEnabled,
} from "@/features/renderer/components/renderer/section-policy";
import { getGroupInterpretation } from "@/features/renderer/components/renderer/tab-navigation";
import type {
  RendererFormField,
  RendererFormGroup,
} from "@/features/renderer/form-definition";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";
import { cn } from "@/lib/utils";
import { CollapsibleGroup } from "./collapsible-group";
import { renderCustomGroup } from "./custom-group";
import { getGroupTitle } from "./helpers";
import { renderRelationshipUsage } from "./relationship-usage";
import type { GroupRenderContext } from "./types";

export function renderGroupFields(
  ctx: GroupRenderContext,
  group: RendererFormGroup,
  fieldKeys: readonly string[] | undefined,
) {
  if (!fieldKeys || fieldKeys.length === 0) {
    return null;
  }

  const fields = fieldKeys
    .map((fieldKey) => ctx.fieldsByKey.get(fieldKey))
    .filter((field): field is RendererFormField => Boolean(field));

  const visibleFields = fields.filter(
    (field) => ctx.resolveEffectiveFieldMode(field) !== "hidden",
  );

  if (visibleFields.length === 0) {
    return null;
  }

  const columns = group.layout?.columns ?? ctx.definition.presentation?.layout?.columns ?? 2;

  return (
    <div className={cn("grid gap-5", getRendererGridColumnsClass(columns))}>
      {visibleFields.map((field) =>
        renderRenderableField(ctx, field, [], columns, undefined))}
    </div>
  );
}

export function renderGroupChildren(
  ctx: GroupRenderContext,
  groups: readonly RendererFormGroup[] | undefined,
  level: number,
) {
  if (!groups || groups.length === 0) {
    return null;
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => renderGroup(ctx, group, level))}
    </div>
  );
}

function renderGroupBody(
  ctx: GroupRenderContext,
  group: RendererFormGroup,
  content: ReactNode,
) {
  const optional = group.section?.optional;
  const optionalState = getOptionalSectionState(ctx, optional);
  const description = translateRendererText(group.description, ctx.lang);
  const hideChildrenWhenDisabled = optional?.hideChildrenWhenDisabled ?? true;
  const enableLabel = translateRendererText(optional?.enableLabel, ctx.lang);
  const disableLabel = translateRendererText(optional?.disableLabel, ctx.lang);

  return (
    <div className="space-y-4">
      {ctx.showGroupDescriptions && description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
      {optionalState ? (
        optionalState.enabled ? (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOptionalSectionEnabled(ctx, optional!, false)}
            >
              {disableLabel || (ctx.lang === "nl" ? "Sectie verwijderen" : "Remove section")}
            </Button>
          </div>
        ) : (
          <div className="flex justify-start">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOptionalSectionEnabled(ctx, optional!, true)}
            >
              {enableLabel || (ctx.lang === "nl" ? "Sectie toevoegen" : "Add section")}
            </Button>
          </div>
        )
      ) : null}
      {optionalState && !optionalState.enabled && hideChildrenWhenDisabled ? null : content}
    </div>
  );
}

export function renderGroup(
  ctx: GroupRenderContext,
  group: RendererFormGroup,
  level: number,
): ReactNode {
  const interpretation =
    group.interpretation ??
    getGroupInterpretation(
      ctx.definition.presentation?.groupInterpretation,
      level,
    );
  const title = getGroupTitle(group, ctx.lang);
  const fields = renderGroupFields(ctx, group, group.fields);
  const children = renderGroupChildren(ctx, group.groups, level + 1);
  const relationshipContent = (
    <>
      {group.relationship
        ? renderRelationshipUsage(ctx, group.relationship, `${group.id}-relationship`)
        : null}
      {group.relationships?.map((relationship, index) =>
        renderRelationshipUsage(ctx, relationship, `${group.id}-relationship-${index}`))}
    </>
  );
  const customContent = renderCustomGroup(ctx, group);
  const content = (
    <>
      {fields}
      {children}
      {relationshipContent}
      {customContent}
    </>
  );
  const body = renderGroupBody(ctx, group, content);

  if (interpretation === "info-card") {
    const description = translateRendererText(group.description, ctx.lang);
    const heading = title;

    if (!heading && !description) {
      return null;
    }

    return (
      <aside
        key={group.id}
        className="rounded-[4px] border border-[#bfc7e9] bg-[#edf0f9]/25 px-4 py-2"
      >
        {heading ? (
          <p className="text-sm font-bold leading-[22px] text-foreground">{heading}</p>
        ) : null}
        {description ? (
          <p className="text-sm leading-[22px] text-foreground/80">{description}</p>
        ) : null}
      </aside>
    );
  }

  if (!fields && !children && !group.relationship && !group.relationships?.length && !group.render) {
    return null;
  }

  if (group.section?.collapsible) {
    return (
      <CollapsibleGroup
        key={group.id}
        title={title || group.id}
        defaultExpanded={group.section.defaultExpanded ?? false}
      >
        {body}
      </CollapsibleGroup>
    );
  }

  const titleVisible = ctx.showGroupTitles && title && !group.hideGroupTitle;

  if (interpretation === "none") {
    return (
      <Fragment key={group.id}>
        {titleVisible ? (
          <div className="mb-4 space-y-1">
            <h2 className="text-lg font-medium text-foreground">{title}</h2>
          </div>
        ) : null}
        {body}
      </Fragment>
    );
  }

  if (interpretation === "card") {
    const HeadingTag = level <= 1 ? "h2" : "h3";

    return (
      <Card key={group.id}>
        {titleVisible ? (
          <CardHeader>
            <HeadingTag className="text-[15px] font-semibold tracking-[-0.2px]">{title}</HeadingTag>
          </CardHeader>
        ) : null}
        <CardContent className="space-y-6">
          {body}
        </CardContent>
      </Card>
    );
  }

  return (
    <section key={group.id} className="space-y-4">
      {titleVisible ? (
        <div className="space-y-1">
          <h2 className="text-lg font-medium text-foreground">{title}</h2>
        </div>
      ) : null}
      {body}
    </section>
  );
}

export function renderTabContent(
  ctx: GroupRenderContext,
  group: RendererFormGroup,
) {
  const description = translateRendererText(group.description, ctx.lang);
  const fields = renderGroupFields(ctx, group, group.fields);
  const children = renderGroupChildren(ctx, group.groups, 1);
  const relationshipContent = (
    <>
      {group.relationship
        ? renderRelationshipUsage(ctx, group.relationship, `${group.id}-relationship`)
        : null}
      {group.relationships?.map((relationship, index) =>
        renderRelationshipUsage(ctx, relationship, `${group.id}-relationship-${index}`))}
    </>
  );
  const customContent = renderCustomGroup(ctx, group);
  const directGroupContent = (
    <>
      {fields}
      {children}
      {relationshipContent}
      {customContent}
    </>
  );
  const isRelationshipOnlyTab =
    !group.groups?.length &&
    !(group.fields?.length) &&
    Boolean(group.relationship) &&
    !(group.relationships?.length) &&
    !group.render;
  const isCustomOnlyTab =
    !group.groups?.length &&
    !(group.fields?.length) &&
    !group.relationship &&
    !(group.relationships?.length) &&
    Boolean(group.render);
  const shouldRenderStandaloneDescription =
    Boolean(description) && (isRelationshipOnlyTab || isCustomOnlyTab);

  return (
    <div className="space-y-6">
      {ctx.showGroupDescriptions && shouldRenderStandaloneDescription ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
      {isRelationshipOnlyTab
        ? renderRelationshipUsage(ctx, group.relationship!, `${group.id}-relationship-tab`)
        : isCustomOnlyTab
          ? renderCustomGroup(ctx, group)
          : renderGroupBody(ctx, group, directGroupContent)}
    </div>
  );
}
