import express from 'express';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { rateLimit } from 'express-rate-limit';
import { PersonalOAuth } from './auth.js';
import { ZenMoney } from './zenmoney.js';
import { FileWriteStore } from './local-store.js';
import { makeServer } from './tools.js';
export { makeServer } from './tools.js';

export function makeApp({service,baseUrl,password,redirects}) {
  const base=new URL(baseUrl),resource=new URL('/mcp',base);
  if(base.protocol!=='https:' && !['localhost','127.0.0.1'].includes(base.hostname)) throw new Error('PUBLIC_URL must use HTTPS');
  if(base.pathname!=='/'||base.search||base.hash) throw new Error('PUBLIC_URL must be an origin, without path/query/fragment');
  if(!password || password.length<32) throw new Error('OWNER_PASSWORD must have at least 32 characters');
  if(!redirects.length || redirects.some(u=>{const p=new URL(u);return p.protocol!=='https:'||p.hash;})) throw new Error('Configure exact HTTPS OAUTH_REDIRECT_URIS from ChatGPT');
  const app=express();app.disable('x-powered-by');
  app.use((req,res,next)=>{
    if(req.headers.origin && req.headers.origin!==base.origin) return res.status(403).send('Origin denied');
    res.set('Cache-Control','no-store');next();
  });
  app.use(express.urlencoded({extended:false,limit:'8kb'}));
  const provider=new PersonalOAuth({app,resource,password,redirects});
  app.use(mcpAuthRouter({provider,issuerUrl:base,resourceServerUrl:resource,scopesSupported:['zenmoney']}));
  app.get('/health',(_req,res)=>res.json({status:'ok'}));
  app.use('/mcp',rateLimit({windowMs:60000,limit:60}),requireBearerAuth({verifier:provider,requiredScopes:['zenmoney'],expectedResource:resource,resourceMetadataUrl:new URL('/.well-known/oauth-protected-resource/mcp',base).href}),express.json({limit:'64kb'}));
  app.post('/mcp',async(req,res)=>{
    const server=makeServer(service),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void server.close();});
    try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch {if(!res.headersSent) res.status(500).json({error:'MCP request failed'});}
  });
  app.all('/mcp',(_req,res)=>res.status(405).end());
  app.use((_err,_req,res,_next)=>res.status(400).json({error:'Invalid request'}));
  return {app,provider};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const service=new ZenMoney({token:process.env.ZENMONEY_TOKEN,writes:process.env.ENABLE_WRITES==='true',store:new FileWriteStore(process.env.WRITE_JOURNAL??'.data/writes.json')});
  if(!service.token) throw new Error('Set ZENMONEY_TOKEN in the local environment');
  if(process.argv.includes('--stdio')) await makeServer(service).connect(new StdioServerTransport());
  else {
    const {app}=makeApp({service,baseUrl:process.env.PUBLIC_URL??'http://localhost:8787',password:process.env.OWNER_PASSWORD,redirects:(process.env.OAUTH_REDIRECT_URIS??'').split(',').filter(Boolean)});
    app.listen(Number(process.env.PORT??8787),process.env.HOST??'127.0.0.1',()=>console.error('ZenMoney MCP listening'));
  }
}
