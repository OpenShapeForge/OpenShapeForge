// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type {
  ComponentCatalog,
  Field,
  OsfTypeDefinition,
} from "../types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { composeComponentCatalog, loadComponentCatalog } from "../component-catalog.js";
import { resolveModelFields, resolveRender } from "./model.js";

const catalog: ComponentCatalog = {
  schemaVersion: 1,
  kind: "componentCatalog",
  defaults: { string: { component: "FieldSingleLine" } },
  viewDefaults: {},
  components: {},
};

describe("choice resolution", () => {
  const osfTypes: Record<string, OsfTypeDefinition> = {
    accountId: { kind: "entityId", entity: "Account", label: { en: "Account" }, baseType: "string", validation: { format: "uuid" }, optionSource: { type: "entity", source: "Account", valueField: "id" } },
    referenceDataCode: { label: { en: "Code" }, baseType: "string" },
  };

  test("an inline identifier value picks from the alias's optionSource; the entity's own primary key does not", () => {
    const [id, holder] = resolveModelFields([
      { key: "id", osfType: "accountId" },
      { key: "meta", osfType: "object", children: [{ key: "ownerId", osfType: "accountId" }] },
    ], catalog, osfTypes);
    expect(id!.options).toBeUndefined();
    expect(holder!.children![0]!.options).toEqual({ type: "entity", source: "Account", valueField: "id" });
    const [authored] = resolveModelFields([
      { key: "meta", osfType: "object", children: [{ key: "ownerId", osfType: "accountId", options: { type: "static", items: [{ value: "x", label: { en: "X" } }] } }] },
    ], catalog, osfTypes);
    expect(authored!.children![0]!.options).toMatchObject({ type: "static" });
  });

  test("the select component's render prop is the same referentiedata group, folded into options", () => {
    const [folded, agreeing] = resolveModelFields([
      { key: "status", osfType: "referenceDataCode", render: { component: "FieldSingleRelatedRecord", props: { referentieGroep: "STATUS" } } },
      { key: "kind", osfType: "referenceDataCode", options: { type: "referentiedata", referentieGroep: "KIND" }, render: { component: "FieldSingleRelatedRecord", props: { referentieGroep: "KIND" } } },
    ], catalog, osfTypes);
    expect(folded!.options).toEqual({ type: "referentiedata", referentieGroep: "STATUS" });
    expect(agreeing!.options).toEqual({ type: "referentiedata", referentieGroep: "KIND" });
    expect(() => resolveModelFields([
      { key: "kind", osfType: "referenceDataCode", options: { type: "referentiedata", referentieGroep: "KIND" }, render: { component: "FieldSingleRelatedRecord", props: { referentieGroep: "OTHER" } } },
    ], catalog, osfTypes)).toThrow("kind: render.props.referentieGroep OTHER contradicts options.referentieGroep KIND.");
  });
});

describe("semantic renderer mapping", () => {
  test("retains authored and semantic collection bounds after normalization", () => {
    const osfTypes: Record<string, OsfTypeDefinition> = {
      boundedTags: {
        label: { en: "Tags" },
        baseType: "string",
        cardinality: { min: 1, max: 3 },
      },
    };

    const [semantic, authored] = resolveModelFields([
      { key: "tags", osfType: "boundedTags" },
      {
        key: "steps",
        osfType: "object",
        cardinality: { min: 2, max: "unbounded" },
        item: { key: "step", osfType: "object" },
      },
    ], catalog, osfTypes);

    expect(semantic).toMatchObject({
      cardinality: "collection",
      cardinalityBounds: { min: 1, max: 3 },
    });
    expect(authored).toMatchObject({
      cardinality: "collection",
      cardinalityBounds: { min: 2, max: "unbounded" },
    });
  });

  test("resolves input component and props centrally while preserving field options", () => {
    const osfTypes: Record<string, OsfTypeDefinition> = {
      referenceDataCode: {
        label: { en: "Reference value", nl: "Referentiewaarde" },
        baseType: "string",
        render: { display: "FieldSingleLine", input: "FieldSingleRelatedRecord" },
        props: { clearable: false },
      },
    };
    const fields: Field[] = [{
      key: "status",
      osfType: "referenceDataCode",
      options: { type: "referentiedata", referentieGroep: "DOCUMENTVERSIONSTATUS" },
    }];

    expect(resolveModelFields(fields, catalog, osfTypes)[0]).toMatchObject({
      key: "status",
      render: { component: "FieldSingleRelatedRecord", props: { clearable: false } },
      options: { type: "referentiedata", referentieGroep: "DOCUMENTVERSIONSTATUS" },
    });
  });

  test("uses the semantic display renderer for a read-only companion field", () => {
    const osfTypes: Record<string, OsfTypeDefinition> = {
      fileStorageLocation: {
        label: { en: "File", nl: "Bestand" },
        baseType: "string",
        render: { display: "FieldSingleLine", input: "FileUpload" },
        props: {
          fileNameField: "fileName",
          mimeTypeField: "mimeType",
          checksumField: "checksum",
        },
      },
    };

    expect(resolveModelFields([{
      key: "storageLocation",
      osfType: "fileStorageLocation",
      readOnly: true,
    }], catalog, osfTypes)[0]?.render).toEqual({
      component: "FieldSingleLine",
      props: {
        fileNameField: "fileName",
        mimeTypeField: "mimeType",
        checksumField: "checksum",
      },
    });
  });
});

test("inherits semantic choices recursively while explicit options win", () => {
  const options = { type: "static" as const, items: [{ value: "first", label: { en: "First" } }] };
  const fields = resolveModelFields([
    { key: "choice", osfType: "choice" },
    { key: "override", osfType: "choice", options: { type: "static", items: [] } },
    { key: "nested", osfType: "object", children: [{ key: "choice", osfType: "choice" }] },
    { key: "items", osfType: "string", cardinality: "collection", item: { key: "choice", osfType: "choice" } },
  ], catalog, { choice: { label: { en: "Choice" }, baseType: "string", options } });
  expect(fields[0]!.options).toEqual(options);
  expect(fields[1]!.options?.items).toEqual([]);
  expect(fields[2]!.children?.[0]?.options).toEqual(options);
  expect(fields[3]!.item?.options).toEqual(options);
});


test("model compilation retains the canonical field authoring profile",()=>{
 const authoring={profile:"templateParameter",locked:true,visibleProperties:["moneyDisplay"]};
 const fields=resolveModelFields([{key:"parameters",osfType:"string",authoring}],catalog,{});
 expect(fields[0]!.authoring).toEqual(authoring);
 expect(fields[0]!.authoring).not.toBe(authoring);
});

test("YAML presentation defaults compose with semantic and field options without losing false",()=>{
 const configured={...catalog,defaults:{string:{component:"FieldSingleLine",props:{layout:"front",emailAction:true}}}};
 const semantic={label:{en:"E-mail"},baseType:"string",render:{display:"FieldSingleLine",input:"FieldSingleLine"},props:{layout:"front",emailAction:false}} as OsfTypeDefinition;
 const field={key:"email",osfType:"email",baseType:"string",render:{component:"FieldEmail",props:{layout:"none"}}} as Field;
 const projected=resolveRender(field,configured,semantic);
 expect(projected).toEqual({component:"FieldEmail",props:{layout:"none",emailAction:false}});
 const {render:_,...withoutRender}=field;
 expect(resolveRender(withoutRender,configured,semantic).props).toEqual({layout:"front",emailAction:false});
 expect(configured.defaults.string.props.layout).toBe("front");
});

describe("the component catalog", () => {
 const real=loadComponentCatalog(join(import.meta.dir,"..","..","..","config","authoring"));
 const text={key:"name",osfType:"string",baseType:"string"} as Field;

 test("a field takes the design system's field under its Figma name, with front as the Figma default", () => {
  expect(resolveRender(text,real)).toEqual({component:"FieldSingleLine"});
  expect(real.components.FieldSingleLine!.props).toEqual(expect.arrayContaining(["layout","labelWidth"]));
  expect(real.components.FieldSingleLine!.figma!.props.layout!.default).toBe("front");
 });

 test("rejects a name the catalog does not declare, the old names included", () => {
  for (const name of ["Input","TextDisplay","ReferenceSelect","Switch","DateTimePicker","FieldRating","FieldMultipleFiles"]) {
   expect(()=>resolveRender({...text,render:{component:name}},real)).toThrow(`name: unknown presentation component ${name}.`);
  }
 });

 test("rejects a dropped styling prop", () => {
  for (const prop of ["labelBand","inputTone","viewSurface","spacing","viewSizing","frontLabelWidth"]) {
   expect(()=>resolveRender({...text,render:{component:"FieldSingleLine",props:{[prop]:"x"}}},real)).toThrow(`name: FieldSingleLine does not declare presentation props ${prop}.`);
  }
 });

 test("takes Figma's layout and label width values and nothing else", () => {
  expect(resolveRender({...text,render:{component:"FieldSingleLine",props:{layout:"above",labelWidth:"256"}}},real).props).toEqual({layout:"above",labelWidth:"256"});
  expect(()=>resolveRender({...text,render:{component:"FieldSingleLine",props:{labelWidth:200}}},real)).toThrow('name: FieldSingleLine labelWidth is one of "128", "256", "384", not 200.');
  expect(()=>resolveRender({...text,render:{component:"IconPicker",props:{layout:"left"}}},real)).toThrow('name: IconPicker layout is one of "above", "front", "none", not "left".');
 });

 test("never takes Figma's run-time state", () => {
  expect(()=>resolveRender({...text,render:{component:"FieldSingleLine",props:{state:"error"}}},real)).toThrow("name: FieldSingleLine takes no state; the renderer derives Figma's state at run time.");
 });

 test("a boolean that must have a value takes the two-state field", () => {
  const flag={key:"active",osfType:"boolean",baseType:"boolean"} as Field;
  expect(resolveRender(flag,real).component).toBe("FieldNullableBoolean");
  expect(resolveRender({...flag,required:true},real)).toEqual({component:"FieldBoolean",props:{trueText:{en:"Yes",nl:"Ja"},falseText:{en:"No",nl:"Nee"}}});
 });

 test("accepts a plugin's declared extension and checks its props", () => {
  const authored=parseYaml(readFileSync(join(import.meta.dir,"..","..","..","config","authoring","catalogs","components.yaml"),"utf8")) as ComponentCatalog;
  const extended=composeComponentCatalog({...authored,
   components:{...authored.components,WeeklyAvailability:{kind:"extension",description:"A plugin's weekly availability editor.",props:["layout","labelWidth","weekStart"]}}} as ComponentCatalog);
  expect(resolveRender({...text,render:{component:"WeeklyAvailability",props:{weekStart:"monday",labelWidth:"384"}}},extended)).toEqual({component:"WeeklyAvailability",props:{weekStart:"monday",labelWidth:"384"}});
  expect(()=>resolveRender({...text,render:{component:"WeeklyAvailability",props:{days:7}}},extended)).toThrow("name: WeeklyAvailability does not declare presentation props days.");
 });

 test("a hand-written component may not take a design-system field's name, and fields names only Figma's", () => {
  const authored=parseYaml(readFileSync(join(import.meta.dir,"..","..","..","config","authoring","catalogs","components.yaml"),"utf8")) as ComponentCatalog;
  expect(()=>composeComponentCatalog({...authored,components:{...authored.components,FieldSingleLine:{kind:"field",description:"x",props:[]}}})).toThrow("FieldSingleLine is a design-system field");
  expect(()=>composeComponentCatalog({...authored,fields:{...authored.fields,FieldRating:{}}})).toThrow("fields.FieldRating is no design-system field");
 });

 test("inherited defaults apply only where the chosen component takes them", () => {
  const semantic={label:{en:"Rate"},baseType:"number",props:{unit:"%",rows:3}} as OsfTypeDefinition;
  expect(resolveRender({key:"rate",osfType:"rate",baseType:"number",render:{component:"FieldPercentage"}} as Field,real,semantic).props).toEqual({unit:"%"});
 });
});
