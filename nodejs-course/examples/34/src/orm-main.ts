import { checkOrmReady } from './orm/readiness.js';
import { once } from 'node:events';
import { createOrmApplication } from './orm/application.js';
import { createOrmDataSource } from './orm/data-source.js';
import { runtimeConfig } from './runtime-config.js';
import { createObservability } from './observability.js';
let blocked=false;process.stdout.on('drain',()=>{blocked=false;});process.stdout.on('error',()=>{blocked=true;});const observation=createObservability(line=>{if(blocked)return false;blocked=!process.stdout.write(line+'\n');return true;});
(async()=>{const config=runtimeConfig(process.env);const source=createOrmDataSource(config.databaseUrl);const app=await createOrmApplication({source,auth:{origin:config.origin},observability:observation,timeoutMs:config.timeoutMs});
 try{await checkOrmReady(source);app.listen(config.port,config.host);await once(app,'listening');observation.listening((app.address() as {port:number}).port);let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void app.lifecycle.shutdown().catch(()=>{observation.failed('shutdown_failed');process.exit(1);});};process.on('SIGTERM',stop);process.on('SIGINT',stop);}
 catch(error){await app.lifecycle.shutdown();throw error;}
})().catch(()=>{observation.failed('startup_failed');process.exitCode=1;});
