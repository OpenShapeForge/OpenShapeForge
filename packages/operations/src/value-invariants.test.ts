// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from "bun:test";
import {orderedFieldsKeyword as order,uniqueByKeyword as unique,isIanaTimeZone} from "./value-invariants.js";
test("orders exact numeric and valid calendar ranges, refusing reversals and invalid ends",()=>{
 const n={lower:"from",upper:"to",kind:"numeric" as const},d={...n,kind:"date" as const};
 expect(order.validate(n,{from:"9007199254740993.01",to:"9007199254740993.02"})).toBe(true);
 expect(order.validate(n,{from:"9007199254740993.02",to:"9007199254740993.01"})).toBe(false);
 expect(order.validate(n,{from:0,to:"0.00"})).toBe(true);
 expect(order.validate(n,{from:1})).toBe(false);
 expect(order.validate(d,{from:"2026-02-28",to:"2026-03-01"})).toBe(true);
 expect(order.validate(d,{from:"2026-03-01",to:"2026-02-28"})).toBe(false);
 expect(order.validate(d,{from:"2026-02-30",to:"2026-03-01"})).toBe(false);
});
test("repeated rows have unique identities even when their other data differs",()=>{
 expect(unique.validate({field:"id"},[{id:"a",name:"one"},{id:"a",name:"two"}])).toBe(false);
 expect(unique.validate({field:"id"},[{id:"a"},{id:"b"}])).toBe(true);
 expect(unique.validate({field:"id"},[{id:"a"},{}])).toBe(false);
 expect(unique.validate({field:"id",numeric:true},[{id:"1.00"},{id:1}])).toBe(false);
 expect(unique.validate({field:"id",numeric:true},[{id:"0"},{id:"-0.0"}])).toBe(false);
});
test("timezone validation checks real membership rather than spelling alone",()=>{
 for(const zone of ["UTC","Europe/Amsterdam","Etc/GMT+1","America/Argentina/Buenos_Aires"])expect(isIanaTimeZone(zone)).toBe(true);
 for(const zone of ["Mars/Olympus","Europe/Not_A_Place","+01:00","","../Amsterdam"])expect(isIanaTimeZone(zone)).toBe(false);
});
