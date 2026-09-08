import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperationsServer } from '../src/operations/server.js';
import { operationsConfig } from '../src/operations/config.js';
import { Readiness } from '../src/readiness.js';
import { AriDiagnostics } from '../src/operations/live.js';

const token = 'central-session-token-abcdefghijklmnopqrstuvwxyz';
const origin = 'https://officepulse-admin.example.test';
async function fixture(t: any) {
  let active = true, superAdmin = true, calls = 0, revoked = 0, redeemed = 0, failIdentity = false;
  const readiness = new Readiness();readiness.register('runtime-mysql','critical',true);
  const server = new OperationsServer({port:0,publicUrl:origin,identityUrl:'https://identity.example.test',apiUrl:'https://officepulse-api.example.test'}, {
    identity:{redeem:async(code,uri)=>{assert.equal(code,'code');assert.equal(uri,origin+'/ops/auth/callback');redeemed++;return token;},
      introspect:async()=>{if(failIdentity)throw new Error('secret upstream failure');return {active,user:{iUserId:1,email:'admin@example.test',displayName:'Admin',superAdmin},tenants:[{iTenantId:2,name:'Tenant',bEnabled:true}]};},
      revoke:async()=>{revoked++;active=false;}}, readiness,live:{snapshot:async()=>({available:false,message:'Not configured'})},
    inventory:{extensions:async(scope)=>{calls++;assert.deepEqual(scope.contexts,['tenant']);return [{id:'100',context:'tenant',callerId:null,transport:null,aors:null}];},queues:async()=>[]},
    scopes:new Map([['2',{contexts:['tenant'],queueNames:['tenant']}],['3',{contexts:['other'],queueNames:['other']}]]),
    runtime:{getCallSession:async()=>({id:'other-call',tenantId:'3'} as any),listCallEvents:async()=>{throw new Error('Cross-tenant events must not be read');}},
  });
  await server.listen(0,'127.0.0.1');t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  const request=(path:string,headers:Record<string,string>={},method='GET')=>fetch(base+path,{redirect:'manual',method,headers});
  const auth={cookie:'__Host-officepulse.sid='+token};
  return {request,auth,change:(v: {active?:boolean;superAdmin?:boolean;failIdentity?:boolean})=>{active=v.active??active;superAdmin=v.superAdmin??superAdmin;failIdentity=v.failIdentity??failIdentity;},counts:()=>({calls,revoked,redeemed})};
}

test('operations config is opt-in and requires canonical HTTPS application origins',()=>{
  assert.equal(operationsConfig({}),undefined);
  assert.throws(()=>operationsConfig({OPS_ENABLED:'true'}));
  assert.throws(()=>operationsConfig({OPS_ENABLED:'maybe'}));
  assert.throws(()=>operationsConfig({OPS_ENABLED:'true',OPS_PUBLIC_URL:'http://localhost:8087'}));
  const cfg=operationsConfig({OPS_ENABLED:'true',OPS_PUBLIC_URL:origin,OPS_IDENTITY_URL:'https://identity.example.test',OPS_API_URL:'https://api.example.test'});
  assert.equal(cfg?.port,8087);assert.equal(cfg?.ari,undefined);
});
test('public shell contains no PBX records; data and unknown backend proxy routes are denied',async t=>{
  const f=await fixture(t);
  const shell=await f.request('/');assert.equal(shell.status,200);assert.match(await shell.text(),/OfficePulse/);
  assert.match(shell.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  assert.equal((await f.request('/ops/api/status')).status,401);
  assert.equal((await f.request('/v1/admin/pbx/extensions?iTenantId=2',f.auth)).status,404);
  assert.equal(f.counts().calls,0);
});
test('login is browser-bound, fixed-origin and single-use',async t=>{
  const f=await fixture(t);
  const login=await f.request('/ops/auth/login',{host:'attacker.example'});
  const redirect=new URL(login.headers.get('location')!);
  assert.equal(redirect.origin,'https://identity.example.test');assert.equal(redirect.searchParams.get('redirect_uri'),origin+'/ops/auth/callback');
  const state=redirect.searchParams.get('state')!;
  assert.match(login.headers.get('set-cookie')!,/HttpOnly; Secure; SameSite=Lax/);
  const path='/ops/auth/callback?code=code&state='+state;
  assert.equal((await f.request(path)).headers.get('location'),'/?login=error');
  assert.equal(f.counts().redeemed,0);
  const response=await f.request(path,{cookie:'__Host-officepulse.state='+state});
  assert.equal(response.headers.get('location'),'/');assert.match(response.headers.get('set-cookie')!,/__Host-officepulse.sid=/);
  assert.equal((await f.request(path,{cookie:'__Host-officepulse.state='+state})).headers.get('location'),'/?login=error');
  assert.equal(f.counts().redeemed,1);
});
test('non-operator sign-in revokes the new central session',async t=>{
  const f=await fixture(t);f.change({superAdmin:false});
  const r=await f.request('/ops/auth/login');const state=new URL(r.headers.get('location')!).searchParams.get('state')!;
  const result=await f.request('/ops/auth/callback?code=code&state='+state,{cookie:'__Host-officepulse.state='+state});
  assert.equal(result.headers.get('location'),'/?login=denied');assert.equal(f.counts().revoked,1);
  assert.doesNotMatch(result.headers.get('set-cookie')!,/__Host-officepulse.sid=/);
});
test('fresh central authorization gates tenant reads, revocation and role changes',async t=>{
  const f=await fixture(t);
  const r=await f.request('/ops/api/tenants/2/extensions',f.auth);assert.equal(r.status,200);assert.equal(((await r.json()) as any).extensions[0].id,'100');
  assert.equal((await f.request('/ops/api/tenants/3/extensions',f.auth)).status,403);assert.equal(f.counts().calls,1);
  assert.equal((await f.request('/ops/api/tenants/2/calls/other-call',f.auth)).status,404);
  f.change({superAdmin:false});assert.equal((await f.request('/ops/api/status',f.auth)).status,403);
  f.change({superAdmin:true,active:false});assert.equal((await f.request('/ops/api/status',f.auth)).status,401);
});
test('Identity outage fails closed without leaking errors or reading the PBX',async t=>{
  const f=await fixture(t);f.change({failIdentity:true});
  const r=await f.request('/ops/api/tenants/2/extensions',f.auth);assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret/);assert.equal(f.counts().calls,0);
});
test('mutations are absent and logout requires same-origin CSRF proof',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/ops/api/status',f.auth,'POST')).status,405);
  assert.equal((await f.request('/ops/auth/logout',f.auth,'POST')).status,403);
  const session:any=await (await f.request('/ops/api/session',f.auth)).json();
  const headers={...f.auth,'x-csrf-token':session.csrfToken,origin:'https://attacker.example.test'};
  assert.equal((await f.request('/ops/auth/logout',headers,'POST')).status,403);
  headers.origin=origin;assert.equal((await f.request('/ops/auth/logout',headers,'POST')).status,200);assert.equal(f.counts().revoked,1);
});
test('live diagnostics use fixed GETs, whitelist response fields and distinguish unavailable from empty',async t=>{
  const seen:string[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{
    assert.equal(init.method,'GET');seen.push(url);
    const body=url.endsWith('/asterisk/info')?{system:{version:'22',secret:'do-not-return'},status:{startup_time:'2026-09-08'}}:url.endsWith('/endpoints')?[{technology:'PJSIP',resource:'100',state:'online',channel_ids:[],password:'do-not-return'}]:[];
    return new Response(JSON.stringify(body),{status:200});
  });
  const result=await new AriDiagnostics({url:'http://localhost/ari',username:'read-only',password:'test'}).snapshot();
  assert.equal(seen.length,3);assert.doesNotMatch(JSON.stringify(result),/do-not-return|password/);assert.equal((result as any).available,true);
  assert.equal((await new AriDiagnostics().snapshot() as any).available,false);
});
