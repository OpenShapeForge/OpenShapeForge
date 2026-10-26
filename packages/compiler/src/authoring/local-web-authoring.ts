// SPDX-License-Identifier: BUSL-1.1
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,relative,basename,resolve} from 'node:path';
import {loadActivePlatformCompile,resolveActiveAuthoringDir} from '../active-manifest.js';
import {loadEntity} from './loader.js';
import {collectAuthoringInspection} from './inspection.js';
import {resolvedWebInterfaceSchema} from './web-interface-schema.js';

/** Explicit local build input. Never invoked by normal generation. */
export async function collectLocalWebAuthoring(repoRoot:string,entityIds:string[],targetDir:string,sourceRoots:{prepared:string;original:string}[]=[]){
 if(process.env.CI||process.env.GITHUB_ACTIONS||process.env.RELEASE_SHA)throw new Error('Local authoring sources are forbidden in CI/release builds.');
 const targetRoot=resolve(repoRoot,targetDir);
 if(relative(repoRoot,targetRoot).startsWith('..'))throw new Error('Authoring target must be inside the host.');
 const targets=new Map<string,string>();
 if(existsSync(targetRoot))for(const file of readdirSync(targetRoot,{recursive:true}) as string[]){if(!file.endsWith('.yaml'))continue;const key=basename(file);if(targets.has(key))throw new Error(`Ambiguous authoring target: ${key}`);targets.set(key,join(targetRoot,file));}
 const active=await loadActivePlatformCompile(repoRoot);
 const authoringDir=resolveActiveAuthoringDir(repoRoot);
 const authoring:Record<string,{path:string;web:unknown;targetPath:string;sourceYaml:string;subtype?:{base:string;baseSlug:string;hidden:string[]}}>={};
 for(const entityId of [...entityIds].sort()){
  const source=active.entities.find(e=>e.contract.entity.name===entityId);if(!source)continue;
  const entity=loadEntity(authoringDir,source.slug).coreEntity;
  if(!entity.interfaces?.web)continue;
  const target=targets.get(basename(source.path));
  authoring[entityId]={path:source.path,web:entity.interfaces.web,targetPath:target?relative(repoRoot,target):`${targetDir}/design-mode/${basename(source.path)}`,sourceYaml:target?readFileSync(target,'utf8'):'kind: entityPatch\n',...(entity.subtype?{subtype:{base:entity.subtype.base,baseSlug:entity.subtype.baseSlug,hidden:entity.subtype.hidden}}:{})};
 }
 const catalog=Bun.YAML.parse(readFileSync(join(authoringDir,'catalogs/components.yaml'),'utf8')) as {components?:Record<string,{kind?:string;description?:string}>};
 const components=Object.entries(catalog.components??{}).filter(([,c])=>c.kind==='field').map(([name,c])=>({name,description:c.description??''}));
 return {authoring,schema:resolvedWebInterfaceSchema(),components,inspection:collectAuthoringInspection(repoRoot,undefined,sourceRoots)};
}
