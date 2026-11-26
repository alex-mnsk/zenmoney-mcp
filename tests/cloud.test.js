import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin='https://zenmoney.test',callback='https://chatgpt.com/oauth/test-callback';
const account='11111111-1111-4111-8111-111111111111';
const data={serverTimestamp:100,account:[{id:account,user:1,title:'Synthetic',type:'cash',instrument:1,inBalance:true}],instrument:[{id:1,shortTitle:'BYN'}],transaction:[{id:'expense',date:'2026-10-28',income:0,outcome:10,outcomeAccount:account,incomeAccount:account,outcomeInstrument:1,incomeInstrument:1}]};

test('Cloudflare worker: owner-only GitHub OAuth, CIMD, scopes, MCP and persistent write guard',async()=>{
  let githubId='12345678',writes=0,writeFailure=false;
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,scriptPath:'.wrangler/build/worker.js',compatibilityDate:'2026-10-23',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
    kvNamespaces:['OAUTH_KV'],durableObjects:{FINANCE:{className:'FinanceState',useSQLite:true}},
    bindings:{PUBLIC_ORIGIN:origin,GITHUB_CLIENT_ID:'synthetic-client',GITHUB_CLIENT_SECRET:'synthetic-secret',OWNER_GITHUB_ID:'12345678',ZENMONEY_TOKEN:'synthetic-zen-token',ENABLE_WRITES:'true'},
    outboundService:async req=>{
      const url=new URL(req.url);
      if(url.href==='https://chatgpt.com/oauth/client.json') return Response.json({client_id:url.href,client_name:'ChatGPT test',redirect_uris:[callback],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
      if(url.href==='https://github.com/login/oauth/access_token') return Response.json({access_token:'synthetic-github-token'});
      if(url.href==='https://api.github.com/user') return Response.json({id:Number(githubId)});
      if(url.href==='https://api.zenmoney.ru/v8/diff/') {
        const body=await req.json();
        assert.equal(req.headers.get('authorization'),'Bearer synthetic-zen-token');
        if(body.transaction) {writes++;if(writeFailure) return new Response('Synthetic upstream failure',{status:503});}
        return Response.json({...data,transaction:body.transaction??data.transaction});
      }
      throw new Error('Unexpected outbound request in isolated test: '+url.origin+url.pathname);
    }
  }));
  const fetch=(p,init)=>mf.dispatchFetch(origin+p,{...init,redirect:'manual'});
  const cookie=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const authorize=async(scope)=>{
    const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
    const params=new URLSearchParams({client_id:'https://chatgpt.com/oauth/client.json',redirect_uri:callback,response_type:'code',scope,code_challenge:challenge,code_challenge_method:'S256',state:'client-state',resource:origin+'/mcp'});
    let r=await fetch('/authorize?'+params);assert.equal(r.status,200);
    const html=await r.text();assert.ok(html.includes('ZenMoney'));assert.match(r.headers.get('content-security-policy'),/https:\/\/github.com/);
    const handle=html.match(/name="handle" value="([^"]+)"/)[1],consentCookie=cookie(r);
    const consent={method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded',cookie:consentCookie},body:new URLSearchParams({handle,decision:'approve'}).toString()};
    assert.equal((await fetch('/authorize',{...consent,headers:{...consent.headers,origin:'https://evil.test'}})).status,403);
    const unbound=await fetch('/authorize',{...consent,headers:{origin,'content-type':'application/x-www-form-urlencoded'}});assert.equal(unbound.status,400);
    r=await fetch('/authorize',consent);assert.equal(r.status,302);const github=new URL(r.headers.get('location')),upstreamCookie=cookie(r);
    const back='/github/callback?'+new URLSearchParams({state:github.searchParams.get('state'),code:'synthetic-code'});
    r=await fetch(back,{headers:{cookie:upstreamCookie}});assert.equal(r.status,302);
    const target=new URL(r.headers.get('location'));assert.equal(target.searchParams.get('state'),'client-state');
    if(githubId!=='12345678') {assert.equal(target.searchParams.get('error'),'access_denied');return null;}
    const tokenBody={grant_type:'authorization_code',code:target.searchParams.get('code'),client_id:'https://chatgpt.com/oauth/client.json',code_verifier:verifier,redirect_uri:callback,resource:origin+'/mcp'};
    const token=body=>fetch('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString()});
    assert.equal((await token({...tokenBody,code_verifier:randomBytes(32).toString('base64url')})).status,400);
    r=await token(tokenBody);assert.equal(r.status,200);const tokens=await r.json();
    return {...tokens,tokenBody};
  };
  const rpc=async(token,method,params={})=>{
    const r=await fetch('/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    assert.equal(r.status,200);return r.json();
  };
  try {
    const unauthorized=await fetch('/mcp');assert.equal(unauthorized.status,401);
    assert.equal(unauthorized.headers.get('cache-control'),'no-store');
    assert.ok(!(await unauthorized.text()).includes('synthetic'));
    const meta=await (await fetch('/.well-known/oauth-authorization-server')).json();assert.equal(meta.client_id_metadata_document_supported,true);assert.ok(meta.code_challenge_methods_supported.includes('S256'));
    assert.equal((await fetch('/mcp',{headers:{authorization:'Bearer invalid-test-token'}})).status,401);
    const badAuth=new URLSearchParams({client_id:'https://chatgpt.com/oauth/client.json',redirect_uri:'https://evil.test/callback',response_type:'code',scope:'finance:read',code_challenge:'synthetic-challenge',code_challenge_method:'S256',resource:origin+'/mcp'});
    assert.equal((await fetch('/authorize?'+badAuth)).status,400);
    badAuth.set('redirect_uri',callback);badAuth.set('code_challenge_method','plain');assert.equal((await fetch('/authorize?'+badAuth)).status,400);
    githubId='999';await authorize('finance:read');githubId='12345678';
    const read=await authorize('finance:read offline_access');
    const tools=await rpc(read.access_token,'tools/list');assert.equal(tools.result.tools.length,3);
    const forbidden=await rpc(read.access_token,'tools/call',{name:'zenmoney_prepare_expense',arguments:{account_id:account,date:'2026-10-28',amount:5}});assert.ok(forbidden.error||forbidden.result?.isError);
    const report=await rpc(read.access_token,'tools/call',{name:'zenmoney_expense_report',arguments:{start:'2026-10-01',end:'2026-10-31'}});assert.equal(report.result.structuredContent.currencies[0].total,'10');
    const write=await authorize('finance:read finance:write offline_access');assert.equal((await rpc(write.access_token,'tools/list')).result.tools.length,5);
    const prepare=async()=>rpc(write.access_token,'tools/call',{name:'zenmoney_prepare_expense',arguments:{account_id:account,date:'2026-10-28',amount:5}});
    const draft=(await prepare()).result.structuredContent.draft_id;assert.equal(writes,0);
    const commit=id=>rpc(write.access_token,'tools/call',{name:'zenmoney_commit_expense',arguments:{draft_id:id,confirmed:true}});
    assert.equal((await commit(draft)).result.structuredContent.status,'confirmed');assert.equal(writes,1);
    assert.equal((await commit(draft)).result.structuredContent.status,'confirmed');assert.equal(writes,1);
    const unknown=(await prepare()).result.structuredContent.draft_id;writeFailure=true;
    assert.equal((await commit(unknown)).result.isError,true);assert.equal(writes,2);
    assert.equal((await commit(unknown)).result.structuredContent.status,'unknown');assert.equal(writes,2);
    const refreshBody={grant_type:'refresh_token',client_id:'https://chatgpt.com/oauth/client.json',refresh_token:write.refresh_token,resource:origin+'/mcp'};
    const kv=await mf.getKVNamespace('OAUTH_KV');
    const grantKey='grant:'+write.refresh_token.split(':').slice(0,2).join(':');
    const grant=await kv.get(grantKey,'json');
    const lifetime=90*86400;
    assert.equal(write.expires_in,900);
    assert.ok(Math.abs(grant.expiresAt-Math.floor(Date.now()/1000)-lifetime)<10);
    // Model an active connection nearing expiry without waiting for 90 days.
    grant.expiresAt=Math.floor(Date.now()/1000)+600;
    await kv.put(grantKey,JSON.stringify(grant),{expiration:grant.expiresAt});
    const refreshed=await fetch('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(refreshBody).toString()});assert.equal(refreshed.status,200);
    const newTokens=await refreshed.json();
    assert.equal(newTokens.expires_in,900);assert.notEqual(newTokens.refresh_token,write.refresh_token);
    const renewed=await kv.get(grantKey,'json');
    assert.ok(Math.abs(renewed.expiresAt-Math.floor(Date.now()/1000)-lifetime)<10);
    assert.equal((await kv.list({prefix:grantKey})).keys[0].expiration,renewed.expiresAt);
    assert.equal((await rpc(newTokens.access_token,'tools/list')).result.tools.length,5);
    renewed.expiresAt=Math.floor(Date.now()/1000)-1;
    await kv.put(grantKey,JSON.stringify(renewed));
    const expired=await fetch('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...refreshBody,refresh_token:newTokens.refresh_token}).toString()});
    assert.equal(expired.status,400);assert.equal((await expired.json()).error,'invalid_grant');
    const replay=await fetch('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(write.tokenBody).toString()});assert.equal(replay.status,400);
  } finally {await mf.dispose();}
});
