// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { validateTimelineIncludes } from "./index.js";
import type {
  CompiledDetailView,
  CompiledRelationship,
  CompiledViewContext,
  CompiledViewGroup,
} from "../types.js";

function makeDetailGroup(group: Partial<CompiledViewGroup> & { id: string }): CompiledViewGroup {
  return { ...group };
}

function makeDetailContext(items: CompiledViewGroup[]): CompiledViewContext {
  const detail: CompiledDetailView = {
    name: "detail",
    kind: "page",
    type: "detail",
    header: { render: { component: "header" }, title: "" },
    groups: { render: { component: "tabs" }, items },
  };

  return {
    page: { component: "page" },
    routes: {},
    presentations: { detail },
    detail,
  };
}

const relationships: CompiledRelationship[] = [
  { key: "contactMoments", kind: "hasMany", target: "ContactMoment" },
  { key: "cases", kind: "hasMany", target: "Case" },
];

describe("validateTimelineIncludes", () => {
  it("accepts `self` and known relationship keys", () => {
    const views = {
      core: makeDetailContext([
        makeDetailGroup({
          id: "timeline",
          render: { component: "timeline" },
          timeline: {
            include: [
              "self",
              { relationship: "contactMoments" },
              { relationship: "cases" },
            ],
          },
        }),
      ]),
    };

    expect(() => validateTimelineIncludes("Relation", relationships, views)).not.toThrow();
  });

  it("rejects an include referencing an unknown relationship", () => {
    const views = {
      core: makeDetailContext([
        makeDetailGroup({
          id: "timeline",
          render: { component: "timeline" },
          timeline: {
            include: [{ relationship: "nope" }],
          },
        }),
      ]),
    };

    expect(() => validateTimelineIncludes("Relation", relationships, views)).toThrow(
      /Timeline include relationship "nope" on group "timeline".*is not defined on Relation/,
    );
  });

  it("recurses into nested groups", () => {
    const views = {
      core: makeDetailContext([
        makeDetailGroup({
          id: "overview",
          groups: [
            makeDetailGroup({
              id: "nested-timeline",
              render: { component: "timeline" },
              timeline: { include: [{ relationship: "missing" }] },
            }),
          ],
        }),
      ]),
    };

    expect(() => validateTimelineIncludes("Relation", relationships, views)).toThrow(
      /Timeline include relationship "missing"/,
    );
  });
});
