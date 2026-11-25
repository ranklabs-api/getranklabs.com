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

test('full endpoint only contacts allowed hosts and no email service', async () => {
 const { createFakeD1 } = await import('./helpers/fake-d1.mjs');
 const { load } = await import('./helpers/load.mjs');
 const { handleInstantCheck } = await load('api/instant-check.js');
 const fake = createFakeD1(); fake.sqlite.exec('UPDATE instant_check_control SET kill_switch=0');
 const env = { INSTANT_CHECK_ENABLED:'true', PERFORMANCE_DB:fake.db, INSTANT_CHECK_TURNSTILE_SECRET:'test-secret', INSTANT_CHECK_IP_SALT:'test-salt-long-enough', INSTANT_CHECK_PERPLEXITY_API_KEY:'test-key', INSTANT_CHECK_ANTHROPIC_API_KEY:'test-key' };
 const hosts = new Set();
 const fetchImpl = async url => { const host = new URL(url).hostname; hosts.add(host);
  if(host==='challenges.cloudflare.com') return Response.json({success:true,action:'instant_check',hostname:'getranklabs.com'});
  if(host==='api.perplexity.ai') return Response.json({output:[{type:'message',content:[{type:'output_text',text:'Example'}]}],usage:{input_tokens:1,output_tokens:1}});
  if(host==='api.anthropic.com') return Response.json({content:[{type:'text',text:'Example'}],usage:{input_tokens:1,output_tokens:1,server_tool_use:{web_search_requests:1}}});
  return new Response(String(url).endsWith('/robots.txt')?'':'<html><title>Example</title><h1>Example</h1></html>',{headers:{'content-type':String(url).endsWith('/robots.txt')?'text/plain':'text/html'}});
 };
 const request = new Request('https://getranklabs.com/api/instant-check',{method:'POST',headers:{'content-type':'application/json','Origin':'https://getranklabs.com','CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({website:'example.com',business_name:'Example',service:'plumbing',city:'Austin',email:'person@example.org','cf-turnstile-response':'token'})});
 const response = await handleInstantCheck(request,env,{fetchImpl,now:Date.parse('2026-11-25T12:00:00Z')});
 assert.equal((await response.json()).status,'completed');
 for(const host of hosts) { assert.ok(['example.com','www.example.com','challenges.cloudflare.com','api.perplexity.ai','api.anthropic.com','api.openai.com'].includes(host),host); assert.doesNotMatch(host,/resend|smtp|mailchannels|email/i); }
});
