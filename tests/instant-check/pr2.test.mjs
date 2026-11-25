import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadInstantCheck as load } from './helpers/load.mjs';

test('URL guard and email gate', async () => {
 const {normalizeTarget} = await load('url.js');
 assert.equal(normalizeTarget('WWW.Acme.com/path').origin, 'https://www.acme.com');
 for (const url of ['ftp://acme.com','http://user@acme.com','acme.com:8080','127.0.0.1','[::1]','localhost','foo.local','foo.internal','foo.lan','foo.home.arpa','google.com','x.youtube.com']) assert.equal(normalizeTarget(url).ok, false, url);
 assert.equal(normalizeTarget('xn--bcher-kva.de').ok, true);
 const {checkEmail} = await load('email.js');
 assert.equal(checkEmail('person@gmail.com').ok,true);
 for (const email of ['bad','a@mailinator.com','a@sub.yopmail.com','a..b@example.com']) assert.equal(checkEmail(email).ok,false,email);
});
test('extracts page signals', async () => {
 const {extractMetrics} = await load('extract.js');
 const m = extractMetrics(`<html><head><title>A &amp; B</title><meta name="description" content="Hello"><meta name="viewport" content="x"><meta property="og:title" content="x"><link rel="canonical" href="/"><script type="application/ld+json">{"@graph":[{"@type":"LocalBusiness"}]}</script></head><body><h1>Hello <b>world</b></h1><h2>Question?</h2><p>Some text</p><img><script>hidden</script></body></html>`);
 assert.equal(m.title,'A & B'); assert.equal(m.h1_texts[0],'Hello world'); assert.equal(m.heading_outline.length,2); assert.equal(m.img_no_alt,1); assert.equal(m.schema_nodes[0]['@type'],'LocalBusiness'); assert.equal(m.has_og,true); assert.equal(m.has_canonical,true); assert(!m.visible_text.includes('hidden'));
});
test('crawl chooses links, rejects redirects, caps bytes and aborts challenges', async () => {
 const {fetchCrawl,readCapped} = await load('crawl.js');
 const calls=[]; const fetchImpl=async (url) => {calls.push(url); if(url.endsWith('/robots.txt')) return new Response('User-agent: *', {headers:{'content-type':'text/plain'}}); if(url.endsWith('/')) return new Response('<nav><a href="/other">Other</a><a href="/about">About</a><a href="/services">Services</a></nav>',{headers:{'content-type':'text/html'}}); return new Response('<h1>Page</h1>',{headers:{'content-type':'text/html'}});};
 const crawl=await fetchCrawl('https://acme.com',{fetchImpl,maxPages:2}); assert.equal(crawl.pages.length,2); assert(calls.at(-1).endsWith('/about'));
 for(const target of ['http://127.0.0.1/','https://other.com/']) { const seen=[]; const result=await fetchCrawl('https://acme.com',{fetchImpl:async u=>{seen.push(u); return u.endsWith('robots.txt') ? new Response('',{status:404}) : new Response(null,{status:302,headers:{location:target}})}}); assert.equal(result.ok,false); assert.equal(seen.length,2); }
 const capped=await readCapped(new Response('abcdefgh'),3,new AbortController().signal); assert.equal(capped.text,'abc'); assert.equal(capped.truncated,true);
 const blocked=await fetchCrawl('https://acme.com',{fetchImpl:async u=>u.endsWith('robots.txt')?new Response('',{status:404}):new Response('<title>Just a moment</title>',{headers:{'content-type':'text/html'}})}); assert.equal(blocked.blocked,true);
});
test('score matches pinned golden fixtures', async () => {
 const {scoreSite}=await load('score.js');
 for(const name of ['strong','org-only','no-schema-blocked','thin']) { const site=JSON.parse(readFileSync(new URL(`./fixtures/site-${name}.json`,import.meta.url))); const golden=JSON.parse(readFileSync(new URL(`./fixtures/golden-${name}.json`,import.meta.url))); assert.deepEqual(scoreSite(site.pages ?? site),golden.geo,name); }
});
test('prompt and mention detection', async () => {
 const {buildPrompt}=await load('probes/prompt.js'); const p=buildPrompt({service:'plumbing',city:'Austin',businessName:'Secret Acme'}); assert(!p.includes('Secret Acme'));
 const {detectMention}=await load('probes/mention.js'); const m=detectMention('Try Acme Plumbing at https://www.acme.com/contact.',{businessName:'Acme Plumbing',domain:'acme.com'}); assert.equal(m.mentioned,true); assert.deepEqual(m.matchedUrls,['https://www.acme.com/contact']);
});
for (const [name,url,cost] of [['perplexity','https://api.perplexity.ai/v1/agent',5250],['anthropic','https://api.anthropic.com/v1/messages',10600],['openai','https://api.openai.com/v1/responses',12250]]) test(`${name} request and accounting`,async()=>{
 const mod=await load(`probes/${name}.js`); let calls=0, opts; const data={usage:{input_tokens:1000,output_tokens:1000,server_tool_use:{web_search_requests:1}},output:[{type:'web_search_call'},{type:'message',content:[{type:'output_text',text:'answer'}]}],content:[{type:'text',text:'answer'}]};
 const fetchImpl=async (u,o)=>{calls++;assert.equal(u,url);opts=o;return Response.json(data)};
 assert.equal((await mod.run({prompt:'question',fetchImpl})).status,'unavailable'); assert.equal(calls,0);
 const result=await mod.run({prompt:'question',apiKey:'test-secret',fetchImpl}); assert.equal(result.status,'succeeded'); assert.equal(result.actualMicros,cost); const body=JSON.parse(opts.body); assert.equal(body.model,mod.MODEL); assert.equal(body.tools[0].type,name==='anthropic'?'web_search_20250305':'web_search'); if(name==='anthropic') {assert.equal(body.tools[0].max_uses,1);assert.equal(opts.headers['x-api-key'],'test-secret')} else {assert.equal(body.max_tool_calls,1);assert.equal(opts.headers.authorization,'Bearer test-secret')}
});
