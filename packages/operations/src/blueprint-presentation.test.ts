// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {blueprintPresentation,isBlueprintThumbnail,BLUEPRINT_THUMBNAIL_MAX_BYTES} from './blueprint-presentation.js';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCHsAAAAASUVORK5CYII=';
test('published raster metadata is bounded and cannot embed active URLs or SVG',()=>{
 expect(isBlueprintThumbnail(png)).toBe(true);
 for(const invalid of ['https://user:secret@example.test/image.png','javascript:alert(1)','/assets/picture.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,PHN2Zz4=','data:image/png;base64,iVBORw0KGgo=',`data:image/png;base64,${Buffer.alloc(BLUEPRINT_THUMBNAIL_MAX_BYTES+1).toString('base64')}`])expect(()=>blueprintPresentation({thumbnail:invalid},{})).toThrow('bounded');
});
test('publication preserves image and retirement unless explicitly changed',()=>{
 const original={thumbnail:png,retired:true};
 expect(blueprintPresentation({},original)).toEqual(original);
 expect(blueprintPresentation({thumbnail:null,retired:false},original)).toEqual({});
 expect(()=>blueprintPresentation({retired:'false'},{})).toThrow('boolean');
 expect(blueprintPresentation({thumbnail:png,retired:true},{})).toEqual(original);
});
