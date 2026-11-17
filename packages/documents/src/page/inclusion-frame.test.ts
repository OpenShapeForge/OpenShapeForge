// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { buildPagedDocument, layoutPagedSections, type PagedSectionLayout } from "./html.js";
import type { PageBlock, PageLayouts, PagedDocumentInput } from "./types.js";

const design: PagedDocumentInput["design"] = {
  page: { width: 720, height: 913 },
  colors: { foreground: "#0f1218" },
  textStyles: { body: { fontFamily: "DM Sans", fontSize: 14, lineHeight: 20, fontWeight: 400, color: "foreground" } },
  assets: {},
};

type Region = PageBlock["region"];
/** A text block of the document, or of the inclusion `scope`; its id is also its text. */
const text = (id: string, region: Region = "body", layoutKey?: string, scope?: string): PageBlock =>
  ({ id, definitionKey: "TextBlock", values: { markdown: id }, region, ...(layoutKey ? { layoutKey } : {}), ...(scope ? { scope } : {}) });
const within = (scope: string) => (id: string, region: Region = "body", layoutKey?: string) => text(id, region, layoutKey, scope);
const section = (id: string, values: Record<string, unknown>, scope?: string): PageBlock =>
  ({ id, definitionKey: "SectionBreak", values, region: "body", ...(scope ? { scope } : {}) });

/** A host that leaves its default section for the named A5 section `report` before anything is included. */
const host = (included: readonly PageBlock[], reportSettings: Record<string, unknown> = {}): PageBlock[] => [
  text("default-head", "header"), text("default-foot", "footer"),
  text("intro"),
  section("report", { layout: "report", name: "Report", format: "a5", ...reportSettings }),
  text("report-head", "header", "report"), text("report-foot", "footer", "report"),
  text("before"),
  ...included,
  text("after"),
];

const ids = (blocks: readonly PageBlock[]) => blocks.map((entry) => entry.id);
/** Each section as its first body block, header and footer. */
const frames = (sections: readonly PagedSectionLayout[]) => sections.map((entry) => [entry.body[0]?.id, ids(entry.header), ids(entry.footer)]);
const layout = (blocks: readonly PageBlock[], layouts: PageLayouts) => layoutPagedSections(blocks, design, layouts);

describe("the frame of an included template with pages of its own", () => {
  const cover = within("cover");

  test("a cover of another size takes its own pages inside a named host section, which resumes with its own frame", () => {
    const sections = layout(host([cover("cover-head", "header"), cover("cover-foot", "footer"), cover("cover-body")]), { "": {}, cover: { format: "a4" } });
    expect(frames(sections)).toEqual([
      ["intro", ["default-head"], ["default-foot"]],
      ["before", ["report-head"], ["report-foot"]],
      ["cover-body", ["cover-head"], ["cover-foot"]],
      ["after", ["report-head"], ["report-foot"]],
    ]);
    const [, before, own, after] = sections;
    expect(own!.scope).toBe("cover");
    expect(own!.settings.page).toEqual({ width: 794, height: 1123 });
    expect(own!.sectionId).toBeUndefined();
    // The host is back in the section it left: the same identity, name, size and settings, not its default section.
    expect(after).toEqual({ ...before!, body: after!.body });
    expect(after).toMatchObject({ sectionId: "report", sectionName: "Report", settings: { layout: "report", page: { width: 559, height: 794 } } });
    expect(after!.scope).toBeUndefined();
  });

  test("a cover that supplies only a footer keeps the header of the host section that includes it", () => {
    const sections = layout(host([cover("cover-foot", "footer"), cover("cover-body")]), { "": {}, cover: {} });
    // The header is that of the active named section, not of the host's default section.
    expect(frames(sections)[2]).toEqual(["cover-body", ["report-head"], ["cover-foot"]]);
  });

  test("a cover that supplies only a header keeps the footer of the host section that includes it", () => {
    const sections = layout(host([cover("cover-head", "header"), cover("cover-body")]), { "": {}, cover: {} });
    expect(frames(sections)[2]).toEqual(["cover-body", ["cover-head"], ["report-foot"]]);
  });

  test("a supplied region replaces the host's and is never added to it", () => {
    const html = buildPagedDocument({ title: "t", locale: "en", design, fonts: [], layouts: { "": {}, cover: {} },
      blocks: host([cover("cover-foot", "footer"), cover("cover-body")]) }).sections[2]!.html;
    expect(html).toContain("cover-body");
    expect(html).toContain("report-head");
    expect(html).toContain("cover-foot");
    expect(html).not.toContain("report-foot");
    expect(html).not.toContain("default-head");
  });

  test("a region switched off is blank: neither inherited nor the cover's own", () => {
    const included = [cover("cover-head", "header"), cover("cover-body")];
    expect(frames(layout(host(included), { "": {}, cover: { headerEnabled: false } }))[2]).toEqual(["cover-body", [], ["report-foot"]]);
    expect(frames(layout(host(included), { "": {}, cover: { footerEnabled: false } }))[2]).toEqual(["cover-body", ["cover-head"], []]);
    // Switched on is not a second way to supply a region: without blocks of its own the cover still inherits.
    expect(frames(layout(host(included), { "": {}, cover: { footerEnabled: true } }))[2]).toEqual(["cover-body", ["cover-head"], ["report-foot"]]);
  });

  test("a region the host section switched off is inherited blank", () => {
    const sections = layout(host([cover("cover-body")], { headerEnabled: false }), { "": {}, cover: {} });
    expect(frames(sections).slice(1)).toEqual([["before", [], ["report-foot"]], ["cover-body", [], ["report-foot"]], ["after", [], ["report-foot"]]]);
  });

  test("a host section without a frame of its own lends none, not the host's default frame", () => {
    const sections = layout([text("default-head", "header"), text("intro"), section("bare", { layout: "bare" }), text("before"), cover("cover-body"), text("after")], { "": {}, cover: {} });
    expect(frames(sections)).toEqual([["intro", ["default-head"], []], ["before", [], []], ["cover-body", [], []], ["after", [], []]]);
  });

  test("nested covers stack their frames and every level resumes with the frame it had", () => {
    const outer = within("outer"), inner = within("outer/inner");
    const sections = layout(host([
      outer("outer-head", "header"), outer("outer-body"),
      inner("inner-foot", "footer"), inner("inner-body"),
      outer("outer-rest"),
    ]), { "": {}, outer: {}, "outer/inner": { format: "a4" } });
    expect(frames(sections).slice(1)).toEqual([
      ["before", ["report-head"], ["report-foot"]],
      ["outer-body", ["outer-head"], ["report-foot"]],
      ["inner-body", ["outer-head"], ["inner-foot"]],
      ["outer-rest", ["outer-head"], ["report-foot"]],
      ["after", ["report-head"], ["report-foot"]],
    ]);
    expect(sections.map((entry) => entry.scope)).toEqual([undefined, undefined, "outer", "outer/inner", "outer", undefined]);
    expect(sections.map((entry) => entry.sectionId)).toEqual([undefined, "report", undefined, undefined, undefined, "report"]);
    expect(sections[3]!.settings.page).toEqual({ width: 794, height: 1123 });
    expect(sections[5]!.settings).toEqual(sections[1]!.settings);
  });

  test("a section a cover opens itself inherits through the cover's host, and the cover's own regions stay with their layout", () => {
    const sections = layout(host([
      cover("cover-head", "header"), cover("cover-body"),
      section("back", { layout: "back" }, "cover"), cover("back-foot", "footer", "back"), cover("back-body"),
    ]), { "": {}, cover: {} });
    expect(frames(sections).slice(2, 4)).toEqual([["cover-body", ["cover-head"], ["report-foot"]], ["back-body", ["report-head"], ["back-foot"]]]);
  });

  test("a continuous inclusion flows its body only and never supplies a frame, at any depth", () => {
    const clause = within("clause"), coverClause = within("cover/clause"), nested = within("clause/cover");
    const sections = layout(host([
      clause("clause-head", "header"), clause("clause-foot", "footer"), clause("clause-body"),
      cover("cover-body"), coverClause("cover-clause-head", "header"), coverClause("cover-clause-body"),
      // A cover included by a continuous template inherits from the section that template flows in.
      nested("nested-foot", "footer"), nested("nested-body"),
    ]), { "": {}, cover: {}, "clause/cover": {} });
    expect(sections.map((entry) => [ids(entry.body), ids(entry.header), ids(entry.footer)]).slice(1)).toEqual([
      [["before", "clause-body"], ["report-head"], ["report-foot"]],
      [["cover-body", "cover-clause-body"], ["report-head"], ["report-foot"]],
      [["nested-body"], ["report-head"], ["nested-foot"]],
      [["after"], ["report-head"], ["report-foot"]],
    ]);
  });

  test("regions follow their explicit layout key wherever their rows are stored, and laying out changes nothing it reads", () => {
    const body = [text("intro"), section("report", { layout: "report", name: "Report", format: "a5" }), text("before"), cover("cover-body"), text("after")];
    const regions = [text("report-foot", "footer", "report"), cover("cover-head", "header"), text("default-head", "header"), text("report-head", "header", "report"), text("default-foot", "footer")];
    const layouts = { "": {}, cover: {} };
    const expected = [
      ["intro", ["default-head"], ["default-foot"]],
      ["before", ["report-head"], ["report-foot"]],
      ["cover-body", ["cover-head"], ["report-foot"]],
      ["after", ["report-head"], ["report-foot"]],
    ];
    const first = [...regions, ...body], last = [...body, ...[...regions].reverse()];
    const snapshot = JSON.stringify([first, layouts]);
    const laidOut = layout(first, layouts);
    expect(frames(laidOut)).toEqual(expected);
    expect(frames(layout(last, layouts))).toEqual(expected);
    // Rendering is a read: the same input yields the same sections and section identities, and is left as it was.
    expect(layout(first, layouts)).toEqual(laidOut);
    expect(laidOut.map((entry) => entry.sectionId)).toEqual([undefined, "report", undefined, "report"]);
    expect(JSON.stringify([first, layouts])).toBe(snapshot);
  });
});

describe("a header or footer must belong to a layout the document has", () => {
  const cover = within("cover");

  test("the host's default frame is declared even when every page is printed by a paginated inclusion", () => {
    // The host holds nothing but the inclusion: no host page is emitted, yet its default frame is what the
    // inclusion inherits for the region it leaves out. It is not an orphan.
    const blocks = [text("host-head", "header"), text("host-foot", "footer"), cover("cover-body"), cover("cover-foot", "footer")];
    const laidOut = layout(blocks, { "": {}, cover: { format: "a5" } });
    expect(frames(laidOut)).toEqual([["cover-body", ["host-head"], ["cover-foot"]]]);
    // The same holds for an inclusion's own default frame when its only body content is a nested paginated inclusion.
    const inner = within("cover/inner");
    const nested = [cover("cover-head", "header"), inner("inner-body")];
    expect(frames(layout(nested, { "": {}, cover: { format: "a5" }, "cover/inner": { format: "a4" } }))).toEqual([["inner-body", ["cover-head"], []]]);
  });

  test("a layout nobody declares is refused, in the host and in an inclusion", () => {
    const layouts: PageLayouts = { "": {}, cover: { format: "a5" } };
    expect(() => layout([text("ghost-head", "header", "ghost"), text("body")], layouts)).toThrow("does not select");
    expect(() => layout([text("body"), cover("cover-body"), cover("ghost-foot", "footer", "ghost")], layouts)).toThrow("does not select");
    // A named layout of the host is not a layout of the inclusion, and the reverse.
    const report = [text("intro"), section("report", { layout: "report" }), text("report-head", "header", "report"), text("before"), cover("cover-body")];
    expect(layout(report, layouts)).toHaveLength(3);
    expect(() => layout([...report, cover("stray", "header", "report")], layouts)).toThrow("does not select");
  });
});
