// SPDX-License-Identifier: BUSL-1.1
/** A published preview is a bounded raster payload, never an active or credential-bearing URL. */
export const BLUEPRINT_THUMBNAIL_MAX_BYTES = 96 * 1024;
export const BLUEPRINT_THUMBNAIL_MAX_LENGTH = 32 + 4 * Math.ceil(BLUEPRINT_THUMBNAIL_MAX_BYTES / 3);
export const BLUEPRINT_THUMBNAIL_PATTERN = '^data:image/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$';
export type BlueprintPresentationSnapshot = { thumbnail?: string; retired?: boolean };
export function isBlueprintThumbnail(value: unknown): value is string {
  if(typeof value!=='string'||value.length>BLUEPRINT_THUMBNAIL_MAX_LENGTH)return false;
  const match=new RegExp(BLUEPRINT_THUMBNAIL_PATTERN).exec(value);
  if(!match||match[2]!.length%4!==0)return false;
  let bytes:string;
  try{bytes=atob(match[2]!);}catch{return false;}
  if(!bytes.length||bytes.length>BLUEPRINT_THUMBNAIL_MAX_BYTES)return false;
  const prefix=(values:number[])=>values.every((byte,index)=>bytes.charCodeAt(index)===byte);
  switch(match[1]){
    case 'png':return bytes.length>=33&&prefix([137,80,78,71,13,10,26,10])&&bytes.slice(12,16)==='IHDR'&&bytes.slice(-8,-4)==='IEND';
    case 'jpeg':return bytes.length>=4&&prefix([255,216,255])&&bytes.charCodeAt(bytes.length-2)===255&&bytes.charCodeAt(bytes.length-1)===217;
    case 'gif':return bytes.length>=14&&(bytes.startsWith('GIF87a')||bytes.startsWith('GIF89a'))&&bytes.endsWith(';');
    case 'webp':return bytes.length>=20&&bytes.startsWith('RIFF')&&bytes.slice(8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(bytes.slice(12,16))&&(bytes.charCodeAt(4)+bytes.charCodeAt(5)*256+bytes.charCodeAt(6)*65536+bytes.charCodeAt(7)*16777216)===bytes.length-8;
  }
  return false;
}
/** Omission preserves publication settings; null clears a thumbnail and false restores availability. */
export function blueprintPresentation(input:Record<string,unknown>, previous:unknown):BlueprintPresentationSnapshot {
  const prior=previous&&typeof previous==='object'&&!Array.isArray(previous)?previous as Record<string,unknown>:{};
  const thumbnail=Object.hasOwn(input,'thumbnail')?input.thumbnail:prior.thumbnail;
  const retired=Object.hasOwn(input,'retired')?input.retired:prior.retired;
  if(thumbnail!==undefined&&thumbnail!==null&&!isBlueprintThumbnail(thumbnail))throw Error('Blueprint thumbnail must be a bounded PNG, JPEG, GIF or WebP image.');
  if(retired!==undefined&&typeof retired!=='boolean')throw Error('Blueprint retirement must be a boolean.');
  return {...(typeof thumbnail==='string'?{thumbnail}:{}),...(retired===true?{retired:true}:{})};
}
