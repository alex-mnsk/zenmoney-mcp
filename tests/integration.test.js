import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ZenMoney } from '../src/zenmoney.js';
import { FileWriteStore } from '../src/local-store.js';
import { makeApp } from '../src/server.js';

const aid='11111111-1111-4111-8111-111111111111', tag='22222222-2222-4222-8222-222222222222';
function fixture() {
  const tx=(id,outcome,extra={})=>({id,date:'2026-10-20',outcome,income:0,outcomeAccount:aid,incomeAccount:aid,outcomeInstrument:1,incomeInstrument:1,tag:[tag],...extra});
  return {serverTimestamp:100,account:[{id:aid,user:1,instrument:1,title:'Synthetic account',balance:42,inBalance:true,archive:false,type:'cash'},{id:'off',inBalance:false}],
    instrument:[{id:1,shortTitle:'BYN'},{id:2,shortTitle:'USD'}],tag:[{id:tag,title:'Synthetic category'}],
    transaction:[tx('a',0.1),tx('b',0.2),tx('transfer',500,{income:10,incomeAccount:'other'}),tx('deleted',100,{deleted:true}),tx('hold',20,{hold:true}),tx('usd',3,{outcomeInstrument:2}),tx('off',30,{outcomeAccount:'off'}),tx('outside',50,{date:'2026-09-01'}),tx('multi',2,{tag:[tag,'other']})]};
}
function mockService(options={}) {
  const calls=[];const data=fixture();
  const fetcher=async(url,request)=>{const body=JSON.parse(request.body);calls.push({url,body,headers:request.headers});return new Response(JSON.stringify({...data,transaction:body.transaction??data.transaction}),{status:200});};
  return {service:new ZenMoney({token:'synthetic-secret',fetcher,...options,store:new FileWriteStore(options.journal)}),calls};
}
const filter={start:'2026-10-01',end:'2026-10-31'};
test('expense report uses decimal arithmetic, partitions tags and separates currencies',async()=>{
  const {service,calls}=mockService();const r=await service.report(filter);
  assert.equal(r.currencies.find(x=>x.currency==='BYN').total,'2.3');
  assert.equal(r.currencies.find(x=>x.currency==='USD').total,'3');
  assert.equal(r.excludedTransfers,1);assert.equal(r.excludedOffBalance,1);
  assert.equal(r.currencies[0].categories.reduce((s,c)=>s+Number(c.amount),0),2.3);
  assert.deepEqual(calls[0].body,{currentClientTimestamp:calls[0].body.currentClientTimestamp,serverTimestamp:0});
  assert.equal(calls[0].url,'https://api.zenmoney.ru/v8/diff/');
  assert.equal((await service.report({...filter,include_hold:true})).currencies[0].total,'22.3');
});
test('transactions paginate, preserve missing values, filter deleted and validate range',async()=>{
  const {service}=mockService();const a=await service.transactions({...filter,limit:2});
  assert.equal(a.total,6);assert.equal(a.transactions.length,2);assert.equal(a.next_offset,2);
  assert.equal((await service.transactions({...filter,offset:6})).next_offset,null);
  await assert.rejects(service.report({start:'2026-11-01',end:'2026-10-01'}));
});
test('empty accounts and explicit Diff deletion records are handled',async()=>{
  const fetcher=async()=>new Response(JSON.stringify({serverTimestamp:101}));
  const empty=new ZenMoney({token:'synthetic',fetcher});assert.deepEqual((await empty.references()).accounts,[]);
  const d=fixture();d.deletion=[{object:'transaction',id:'a'}];
  const deleted=new ZenMoney({token:'synthetic',fetcher:async()=>new Response(JSON.stringify(d))});
  assert.equal((await deleted.report(filter)).currencies[0].total,'2.2');
});
test('stdio launches with real entry point and exposes write annotations only when enabled',async()=>{
  const client=new Client({name:'stdio-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:['src/server.js','--stdio'],env:{...process.env,ZENMONEY_TOKEN:'synthetic-no-network',ENABLE_WRITES:'true'},stderr:'pipe'});
  try {
    await client.connect(transport);const {tools}=await client.listTools();assert.equal(tools.length,5);
    assert.equal(tools.find(t=>t.name==='zenmoney_commit_expense').annotations.readOnlyHint,false);
    assert.equal(tools.find(t=>t.name==='zenmoney_commit_expense').annotations.destructiveHint,true);
  } finally {await client.close();}
});
test('writes disabled by default; preview does not write; durable journal prevents duplicates',async()=>{
  await assert.rejects(mockService().service.prepareExpense({}));
  const dir=await mkdtemp(path.join(tmpdir(),'zenmoney-test-'));
  try {
    const journal=path.join(dir,'journal.json'),{service,calls}=mockService({writes:true,journal});
    const draft=await service.prepareExpense({account_id:aid,category_id:tag,date:'2026-10-28',amount:10});
    assert.equal(calls.length,1);assert.ok(!calls[0].body.transaction);
    await assert.rejects(service.commitExpense(draft.draft_id,false));
    const done=await service.commitExpense(draft.draft_id,true);assert.equal(done.status,'confirmed');
    assert.equal(calls.length,2);assert.equal(calls[1].body.transaction[0].id,draft.draft_id);
    assert.equal((await service.commitExpense(draft.draft_id,true)).status,'confirmed');assert.equal(calls.length,2);
    const fresh=mockService({writes:true,journal});await fresh.service.commitExpense(draft.draft_id,true);assert.equal(fresh.calls.length,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('ambiguous network write is journaled and never resent',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'zenmoney-test-'));
  try {
    const {service,calls}=mockService({writes:true,journal:path.join(dir,'j.json')});
    const draft=await service.prepareExpense({account_id:aid,date:'2026-10-28',amount:10});
    service.fetcher=async()=>{throw new Error('network');};
    await assert.rejects(service.commitExpense(draft.draft_id,true),/outcome may be unknown/);
    assert.equal((await service.commitExpense(draft.draft_id,true)).status,'unknown');assert.equal(calls.length,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('HTTP OAuth PKCE + authenticated MCP tool calls end to end',async()=>{
  const {service}=mockService();const password='synthetic-test-password-'.repeat(3),redirect='https://chatgpt.com/connector_platform/oauth/callback';
  const {app,provider}=makeApp({service,baseUrl:'http://localhost:8787',password,redirects:[redirect]});
  const http=app.listen(0,'127.0.0.1');await new Promise(r=>http.once('listening',r));
  const base=`http://127.0.0.1:${http.address().port}`;
  const post=(p,body)=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body),redirect:'manual'});
  let client;
  try {
    let r=await fetch(base+'/mcp',{method:'POST'});assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate'),/resource_metadata/);
    const discovery=await (await fetch(base+'/.well-known/oauth-authorization-server')).json();assert.ok(discovery.code_challenge_methods_supported.includes('S256'));
    const register=async uri=>fetch(base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Test',redirect_uris:[uri],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
    assert.equal((await register('https://evil.example/callback')).status,400);
    r=await register(redirect);assert.equal(r.status,201);const registered=await r.json();
    const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
    const params=new URLSearchParams({client_id:registered.client_id,redirect_uri:redirect,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',state:'test-state',scope:'zenmoney',resource:'http://localhost:8787/mcp'});
    r=await fetch(base+'/authorize?'+params);const html=await r.text();const flow=html.match(/name="flow" value="([^"]+)"/)[1];
    assert.equal((await post('/owner/approve',{flow,password:'wrong'})).status,403);
    r=await post('/owner/approve',{flow,password});assert.equal(r.status,303);
    const target=new URL(r.headers.get('location'));assert.equal(target.searchParams.get('state'),'test-state');
    const tokenBody={grant_type:'authorization_code',client_id:registered.client_id,redirect_uri:redirect,code:target.searchParams.get('code'),code_verifier:verifier,resource:'http://localhost:8787/mcp'};
    assert.equal((await post('/token',{...tokenBody,code_verifier:randomBytes(32).toString('base64url')})).status,400);
    r=await post('/token',tokenBody);assert.equal(r.status,200);const tokens=await r.json();
    assert.equal((await post('/token',tokenBody)).status,400);
    client=new Client({name:'test',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}}));
    const list=await client.listTools();assert.equal(list.tools.length,3);assert.ok(list.tools.every(t=>t.annotations.readOnlyHint));
    const report=await client.callTool({name:'zenmoney_expense_report',arguments:filter});assert.equal(report.structuredContent.currencies[0].total,'2.3');
    const invalid=await client.callTool({name:'zenmoney_expense_report',arguments:{start:'2026-02-30',end:'2026-10-28'}});assert.equal(invalid.isError,true);
    assert.equal((await fetch(base+'/health',{headers:{Origin:'https://evil.example'}})).status,403);
    const refresh={grant_type:'refresh_token',client_id:registered.client_id,refresh_token:tokens.refresh_token,resource:'http://localhost:8787/mcp'};
    r=await post('/token',refresh);assert.equal(r.status,200);assert.equal((await post('/token',refresh)).status,400);
    await provider.revokeToken(registered,{token:tokens.access_token});await assert.rejects(provider.verifyAccessToken(tokens.access_token));
  } finally {if(client) await client.close();clearInterval(provider.timer);http.closeAllConnections();await new Promise(r=>http.close(r));}
});
