import { randomBytes, timingSafeEqual } from 'node:crypto';
import { InvalidGrantError, InvalidTokenError, InvalidTargetError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { rateLimit } from 'express-rate-limit';
const random=()=>randomBytes(32).toString('base64url');
const now=()=>Math.floor(Date.now()/1000);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export class PersonalOAuth {
  constructor({app, resource, password, redirects}) {
    this.resource=resource;this.password=password;this.redirects=redirects;
    this.clients=new Map();this.flows=new Map();this.codes=new Map();this.tokens=new Map();this.refresh=new Map();
    this.clientsStore={getClient:id=>this.clients.get(id),registerClient:c=>{
      if(this.clients.size>=100) throw new InvalidClientMetadataError('Registration limit reached; restart server');
      if(c.token_endpoint_auth_method!=='none' || !c.redirect_uris?.length || c.redirect_uris.some(u=>!redirects.includes(u))) throw new InvalidClientMetadataError('Use a public client and configured exact redirect URIs');
      const client={...c,client_id:random(),client_id_issued_at:now()};this.clients.set(client.client_id,client);return client;
    }};
    app.post('/owner/approve',rateLimit({windowMs:900000,limit:10}), (req,res)=>{
      res.set('Cache-Control','no-store');
      const f=this.flows.get(req.body.flow);
      if(!f || f.expires<now()) return res.status(400).send('Authorization expired. Reconnect.');
      const supplied=Buffer.from(String(req.body.password??'')), expected=Buffer.from(password);
      if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return res.status(403).send('Access denied');
      this.flows.delete(req.body.flow);
      const code=random();this.codes.set(code,{...f,expires:now()+120});
      const target=new URL(f.params.redirectUri);target.searchParams.set('code',code);
      if(f.params.state) target.searchParams.set('state',f.params.state);
      res.redirect(303,target.href);
    });
    this.timer=setInterval(()=>{for(const map of [this.flows,this.codes,this.tokens,this.refresh]) for(const [k,v] of map) if((v.expires??v.expiresAt)<now()) map.delete(k);},60000);this.timer.unref();
  }
  checkResource(resource) {if(resource && resource.href!==this.resource.href) throw new InvalidTargetError('Wrong resource');}
  async authorize(client,params,res) {
    this.checkResource(params.resource);
    if(this.flows.size>100) throw new InvalidGrantError('Too many pending authorizations');
    const id=random();this.flows.set(id,{clientId:client.client_id,params,expires:now()+300});
    res.set({'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'no-referrer'});
    res.send(`<html lang="ru"><meta charset="utf-8"><title>ZenMoney: личный доступ</title><h1>Подключить личный ZenMoney</h1><p>Клиент: ${esc(client.client_name??client.client_id)}</p><p>Адрес возврата: ${esc(params.redirectUri)}</p><p>Доступ к финансовым данным и подготовке расходов. Запись зависит от настройки сервера и требует согласия в чате.</p><form method="post" action="/owner/approve"><input type="hidden" name="flow" value="${id}"><label>Личный пароль сервера <input type="password" name="password" autocomplete="current-password" required></label><button>Разрешить доступ</button></form></html>`);
  }
  code(client,id) {const c=this.codes.get(id);if(!c||c.clientId!==client.client_id||c.expires<now()) throw new InvalidGrantError('Invalid code');return c;}
  async challengeForAuthorizationCode(client,id) {return this.code(client,id).params.codeChallenge;}
  issue(clientId) {
    const access_token=random(),refresh_token=random(),scopes=['zenmoney'];
    this.tokens.set(access_token,{token:access_token,clientId,scopes,expiresAt:now()+3600,resource:this.resource});
    this.refresh.set(refresh_token,{clientId,expires:now()+86400*7});
    return {access_token,refresh_token,token_type:'Bearer',expires_in:3600,scope:'zenmoney'};
  }
  async exchangeAuthorizationCode(client,id,_verifier,redirectUri,resource) {
    this.checkResource(resource);const c=this.code(client,id);
    if(redirectUri!==c.params.redirectUri) throw new InvalidGrantError('Redirect mismatch');
    this.codes.delete(id);return this.issue(client.client_id);
  }
  async exchangeRefreshToken(client,token,_scopes,resource) {
    this.checkResource(resource);const r=this.refresh.get(token);
    if(!r||r.clientId!==client.client_id||r.expires<now()) throw new InvalidGrantError('Invalid refresh token');
    this.refresh.delete(token);return this.issue(client.client_id);
  }
  async verifyAccessToken(token) {const t=this.tokens.get(token);if(!t||t.expiresAt<now()) throw new InvalidTokenError('Invalid token');return t;}
  async revokeToken(client,request) {for(const map of [this.tokens,this.refresh]) if(map.get(request.token)?.clientId===client.client_id) map.delete(request.token);}
}
