import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openApi } from '../src/http/documentation.js';
import { HttpApi, publicApiOptions } from '../src/http/httpServer.js';
import { Logger } from '../src/logging/logger.js';
import { Readiness } from '../src/readiness.js';
import { assembleApiRoutes } from '../src/http/apiRoutes.js';
import { buildRoutes } from '../src/http/routes.js';
import { pbxInventoryRoutes } from '../src/pbx/inventory.js';
import { pbxProvisioningRoutes } from '../src/pbx/provisioning.js';

test('OpenAPI covers every canonical application route',()=>{
  const normalize=(path:string)=>path.replace(/:[^/]+|\{[^}]+\}/g,'{}');
  const writer={} as any;
  const routes=assembleApiRoutes([...pbxInventoryRoutes({extensions:async()=>[],queues:async()=>[]},new Map(),false),...pbxProvisioningRoutes(writer,new Map(),true)],buildRoutes({} as any));
  const documented=new Set(Object.entries(openApi.paths).flatMap(([path,methods])=>Object.keys(methods).map(method=>method.toUpperCase()+' '+normalize(path))));
  for(const route of routes)assert.ok(documented.has(route.method+' '+normalize(route.pattern)),route.pattern);
});
test('Swagger assets and schema are readable while private routes stay blocked',async t=>{
  const server=new HttpApi({...publicApiOptions({logger:new Logger({level:'error'}),readiness:new Readiness(),trustedServerCidrs:['127.0.0.1/32'],trustedProxyCidrs:[],maxBodyBytes:65536,rateLimitPerMinute:300,routes:[{method:'GET',pattern:'/v1/admin/private',handler:()=>({status:200,body:{secret:'not-public'}})}]}),documentation:true});
  await server.listen(0,'127.0.0.1');t.after(()=>server.close());const base='http://127.0.0.1:'+server.address()!.port;
  const root=await fetch(base+'/',{redirect:'manual'});assert.equal(root.status,302);assert.equal(root.headers.get('location'),'/docs');
  for(const path of ['/docs','/openapi.json','/docs/swagger-ui.css','/docs/swagger-ui-bundle.js']){const r=await fetch(base+path);assert.equal(r.status,200);await r.arrayBuffer();}
  const script=await (await fetch(base+'/docs/initialize.js')).text();assert.match(script,/supportedSubmitMethods:\[\]/);assert.match(script,/validatorUrl:null/);
  assert.equal((await fetch(base+'/v1/admin/private')).status,403);
  assert.equal((await fetch(base+'/docs/../../package.json')).status,403);
});
