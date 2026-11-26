import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { DurableObject } from 'cloudflare:workers';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { makeServer } from './tools.js';
import { ZenMoney } from './zenmoney.js';
import { signInHandler } from './cloud/sign-in.js';

const REFRESH_TOKEN_IDLE_TTL=90*24*60*60;

const methods=['references','transactions','report','prepareExpense','commitExpense'];
const mcpHandler={
  async fetch(request,env,ctx) {
    if(!/^\d+$/.test(env.OWNER_GITHUB_ID??'') || ctx.props?.githubId!==env.OWNER_GITHUB_ID) return new Response('Access denied',{status:403});
    const scopes=ctx.auth?.scope??[];
    if(!scopes.includes('finance:read')) return new Response('Insufficient scope',{status:403});
    if(new URL(request.url).pathname!=='/mcp') return new Response('Not found',{status:404});
    if(!env.ZENMONEY_TOKEN) return new Response('ZenMoney connection is not configured',{status:503});
    const stub=env.FINANCE.get(env.FINANCE.idFromName(env.OWNER_GITHUB_ID));
    const service={writes:env.ENABLE_WRITES==='true'};
    for(const method of methods) service[method]=async(...args)=>{
      const response=await stub.fetch('https://finance.internal/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)});
      if(!response.ok) throw new Error('ZenMoney operation unavailable');
      return response.json();
    };
    const server=makeServer(service,{scopes});
    const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,maxRequestBodySize:65536});
    await server.connect(transport);
    try{return await transport.handleRequest(request);}finally{await server.close();}
  }
};

export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url);
    if(!env.PUBLIC_ORIGIN || url.origin!==env.PUBLIC_ORIGIN || url.protocol!=='https:') return new Response('Service setup is incomplete',{status:503});
    const provider=new OAuthProvider({
      apiRoute:'/mcp',apiHandler:mcpHandler,defaultHandler:signInHandler,
      authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',
      scopesSupported:['finance:read',...(env.ENABLE_WRITES==='true'?['finance:write']:[]),'offline_access'],requiredScopes:['finance:read'],
      accessTokenTTL:900,refreshTokenTTL:REFRESH_TOKEN_IDLE_TTL,
      refreshTokenIdleTTL:REFRESH_TOKEN_IDLE_TTL,clientIdMetadataDocumentEnabled:true,
      onError:({status,code,headers})=>Response.json({error:code},{status,headers}),
      resourceMetadata:{resource:`${env.PUBLIC_ORIGIN}/mcp`,authorization_servers:[env.PUBLIC_ORIGIN],resource_name:'Private ZenMoney finance'}
    });
    try {
      const response=await provider.fetch(request,env,ctx);
      response.headers.set('cache-control','no-store');response.headers.set('x-content-type-options','nosniff');response.headers.set('referrer-policy','same-origin');
      return response;
    } catch {return new Response('Service temporarily unavailable',{status:503,headers:{'cache-control':'no-store'}});}
  }
};

// One SQLite-backed object per owner gives consistent persistent write attempts
// across Worker instances. KV's eventual consistency is unsuitable for this log.
export class FinanceState extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);this.ctx=ctx;this.env=env;
    const store={
      getAttempt:id=>ctx.storage.get('attempt:'+id),
      putAttempt:(id,value)=>ctx.storage.put('attempt:'+id,value),
      getDraft:id=>ctx.storage.get('draft:'+id),
      putDraft:async(id,value)=>{
        await ctx.storage.put('draft:'+id,value);
        const alarm=await ctx.storage.getAlarm();if(!alarm||alarm>value.expires) await ctx.storage.setAlarm(value.expires);
      },
      deleteDraft:id=>ctx.storage.delete('draft:'+id)
    };
    this.service=new ZenMoney({token:env.ZENMONEY_TOKEN,writes:env.ENABLE_WRITES==='true',store});
  }
  async fetch(request) {
    const method=new URL(request.url).pathname.slice(1);
    if(request.method!=='POST'||!methods.includes(method)) return new Response('Not found',{status:404});
    try {
      const args=await request.json();
      const result=await this.service[method](...args);
      return Response.json(result,{headers:{'cache-control':'no-store'}});
    } catch {return new Response('Operation failed. Write outcome may be unknown; inspect the transaction ID.',{status:502});}
  }
  async alarm() {
    const drafts=await this.ctx.storage.list({prefix:'draft:'});let next=Infinity;
    for(const [key,draft] of drafts) {
      if(draft.expires<=Date.now()) await this.ctx.storage.delete(key);
      else next=Math.min(next,draft.expires);
    }
    if(Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }
}
