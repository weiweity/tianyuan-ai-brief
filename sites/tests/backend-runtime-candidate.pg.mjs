import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const bin=process.env.PG_BIN || execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const run=(name,args)=>execFileSync(path.join(bin,name),args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
assert.match(run('postgres',['--version']),/PostgreSQL\) 15\./,'PostgreSQL 15 binaries required');
const dir=mkdtempSync(path.join(tmpdir(),'backend-contract-test-'));
const args=['-h',dir,'-p','55439','-d','postgres','-v','ON_ERROR_STOP=1'];
const sql=q=>run('psql',[...args,'-Atc',q]);
let started=false;
let child, done;
try {
 run('initdb',['-D',path.join(dir,'data'),'-A','trust','--no-locale']);
 run('pg_ctl',['-D',path.join(dir,'data'),'-l',path.join(dir,'server.log'),'-o',`-k ${dir} -p 55439 -h ''`,'-w','start']);started=true;
 assert.equal(Math.floor(Number(sql('SHOW server_version_num'))/10000),15,'PostgreSQL 15 server required');
 const base='business-docs/01-客服Agent项目/30-开发-进行中/';
 let installation='';
 for(const file of ['schema.v1.17.sql']) installation+=run('psql',[...args,'-f',base+file]);
 writeFileSync(path.join(dir,'install.log'),installation);
 assert.equal(sql("SELECT prosecdef AND proowner='cs_ai_definer'::regrole AND proconfig=ARRAY['search_path=pg_catalog, public, pg_temp'] FROM pg_proc WHERE oid='public.trg_release_source_set_complete()'::regprocedure").trim(),'t');
 assert.equal(sql("SELECT has_table_privilege('app_content_admin','public.release_source_bindings','SELECT')").trim(),'f');
 const output=run('psql',[...args,'-f','sites/tests/backend-runtime-candidate.behavior.sql']);
 writeFileSync(path.join(dir,'behavior.log'),output);assert.match(output,/PASS auth replay/);
 assert.equal(Number(sql("select count(*) from pg_proc where pronamespace='public'::regnamespace and position('backend_review.lock_content' in prosrc)>0")),12);
 // Prove a second content entry cannot enter while the first transaction owns the gate.
 child=spawn(path.join(bin,'psql'),[...args,'-c',"SET application_name='synthetic-lock-holder'; BEGIN; SELECT backend_review.lock_content(); SELECT pg_sleep(5); COMMIT;"],{stdio:'ignore'});
 // Resolve failures immediately; validation or cleanup may await the child later.
 done=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('close',(code,signal)=>resolve({code,signal}));});
 let holding=false;
 const deadline=Date.now()+3000;
 while(Date.now()<deadline){
  if(sql("select count(*) from pg_stat_activity where application_name='synthetic-lock-holder' and wait_event='PgSleep'").trim()==='1'){holding=true;break;}
  await new Promise(r=>setTimeout(r,10));
 }
 assert.ok(holding,'holder acquired transaction gate');
 assert.throws(
  ()=>sql("SET lock_timeout='100ms'; SELECT public.claim_content_import_validation('synthetic-racer',60);"),
  (error)=>{
   const text=`${error.stderr||''}${error.message||''}`;
   assert.match(text,/lock timeout/);
   return true;
  }
 );
 const result=await done;
 assert.equal(result.error,undefined);
 assert.equal(result.code,0,`holder failed: ${JSON.stringify(result)}`);
 sql("SELECT public.claim_content_import_validation('synthetic-after-release',60);");
 console.log('PASS PG15 install, auth/review behavior, role ACL and two-connection content serialization');
 console.log(`Evidence: ${dir}`);
} finally {
 if(child && child.exitCode===null && child.signalCode===null) child.kill('SIGTERM');
 if(done) await done;
 if(started)run('pg_ctl',['-D',path.join(dir,'data'),'-m','fast','-w','stop']);
}
