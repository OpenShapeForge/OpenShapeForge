// SPDX-License-Identifier: BUSL-1.1
import {test, expect} from "bun:test";
import {formatMoneyDisplay} from "./money-display.js";
test("rounds and scales the display of exact decimals without changing the value",()=>{
 const value="1234567.895";
 expect(formatMoneyDisplay(value,{decimalPlaces:2})).toBe("€1,234,567.90");
 expect(formatMoneyDisplay(value,{decimalPlaces:2,scale:"thousands"})).toBe("€1,234.57 thousand");
 expect(formatMoneyDisplay(value,{decimalPlaces:2,scale:"millions"})).toBe("€1.23 million");
 expect(value).toBe("1234567.895");
 expect(formatMoneyDisplay("900719925474099312345.99",{decimalPlaces:2})).toBe("€900,719,925,474,099,312,345.99");
});
test("preserves locale, currency minor units, signs and rounding boundaries",()=>{
 expect(formatMoneyDisplay("-0.015",{decimalPlaces:2})).toBe("-€0.02");
 expect(formatMoneyDisplay("-0.001",{decimalPlaces:2})).toBe("€0.00");
 expect(formatMoneyDisplay("999.995",{decimalPlaces:2})).toBe("€1,000.00");
 expect(formatMoneyDisplay("1234.56",{locale:"nl-NL",decimalPlaces:0})).toBe("€ 1.235");
 expect(formatMoneyDisplay("1.2345",{currency:"BHD"})).toContain("1.235");
 expect(formatMoneyDisplay("1234",{currency:"JPY"})).toContain("1,234");
});
test("refuses malformed values and invalid display settings",()=>{
 for(const value of ["1e3","+1","NaN","","01.2","1,2"])expect(()=>formatMoneyDisplay(value)).toThrow();
 for(const decimalPlaces of [-1,1.5,21])expect(()=>formatMoneyDisplay("1",{decimalPlaces})).toThrow();
});
