import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
test('instant check has no forbidden provider or external imports',()=>{
 const root=resolve('functions/api/_shared/instant-check');
 function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(resolve(dir,e.name)):[resolve(dir,e.name)])}
 const files=walk(root); for(const p of ['functions/api/instant-check.js','src/components/InstantCheckForm.astro']) if(existsSync(p)) files.push(resolve(p));
 for(const file of files){const text=readFileSync(file,'utf8');assert.doesNotMatch(text,/dataforseo|data for seo/i,file); for(const m of text.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)){const target=resolve(dirname(file),m[1]);assert(target.startsWith(root+'/'),`${file}: ${m[1]}`)}}
});
