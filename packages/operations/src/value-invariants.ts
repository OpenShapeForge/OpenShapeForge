// SPDX-License-Identifier: BUSL-1.1
import { compareExactNumeric, exactDecimal } from "./exact-numeric.js";
import { matchesBaseType } from "./field-variables.js";

const keySchema = {type:"string",pattern:"^[A-Za-z][A-Za-z0-9_]*$",not:{enum:["constructor","prototype","__proto__"]}};
const object = (value:unknown): value is Record<string,unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Registered with every canonical schema validator; errors carry no source values. */
export const orderedFieldsKeyword = {
 keyword:"x-osf-ordered-fields", type:"object" as const, schemaType:"object" as const,
 metaSchema:{type:"object",required:["lower","upper","kind"],additionalProperties:false,properties:{lower:keySchema,upper:keySchema,kind:{enum:["numeric","date"]}}},
 validate(rule:{lower:string;upper:string;kind:"numeric"|"date"},value:unknown):boolean {
  if (!object(value) || !Object.hasOwn(value,rule.lower) || !Object.hasOwn(value,rule.upper)) return false;
  const lower=value[rule.lower], upper=value[rule.upper];
  if (rule.kind === "numeric") { const compared=compareExactNumeric(lower,upper); return compared !== undefined && compared <= 0; }
  return matchesBaseType("date",lower) && matchesBaseType("date",upper) && (lower as string) <= (upper as string);
 }
};
/** A stable child identifier is unique by its value, not by the entire row. */
export const uniqueByKeyword = {
 keyword:"x-osf-unique-by",type:"array" as const,schemaType:"object" as const,
 metaSchema:{type:"object",required:["field"],additionalProperties:false,properties:{field:keySchema,numeric:{type:"boolean"}}},
 validate(rule:{field:string;numeric?:boolean},value:unknown):boolean {
  if (!Array.isArray(value)) return false;
  const seen=new Set<string>();
  for(const item of value){
   if(!object(item)||!Object.hasOwn(item,rule.field))return false;
   const identity=item[rule.field];let key:string;
   if(rule.numeric){
    const decimal=exactDecimal(identity);if(!decimal)return false;
    let digits=decimal.digits,scale=decimal.scale;
    while(scale>0&&digits%10n===0n){digits/=10n;scale--;}
    key=`${decimal.negative?"-":"+"}${digits}:${scale}`;
   }else{if(typeof identity!=="string"&&typeof identity!=="number"&&typeof identity!=="boolean")return false;key=typeof identity+":"+String(identity);}
   if(seen.has(key))return false;seen.add(key);
  }
  return true;
 }
};
/** IANA identifiers are checked by the running platform's timezone database. */
export function isIanaTimeZone(value:unknown):value is string{
 if(typeof value!=="string"||value.length>160||!/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+){0,2}$/.test(value))return false;
 try{new Intl.DateTimeFormat("en",{timeZone:value});return true;}catch{return false;}
}
export const timeZoneKeyword={keyword:"x-osf-time-zone",type:"string" as const,schemaType:"boolean" as const,validate:(enabled:boolean,value:unknown)=>!enabled||isIanaTimeZone(value)};
export const valueInvariantKeywords=[orderedFieldsKeyword,uniqueByKeyword,timeZoneKeyword] as const;
