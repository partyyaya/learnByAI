#!/usr/bin/env python3
"""Actual Redis configuration/ACL/Cluster checks inside this run's disposable container."""
import json,shlex,subprocess,sys,time
from pathlib import Path
container=sys.argv[1]
resource=Path(__file__).resolve().parent/'target/generated-resources'
results=[]
def run(*args):
 r=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=30)
 if r.returncode:raise RuntimeError(r.stdout+r.stderr)
 return r.stdout.strip()
def cli(*args,port=6379,user=None):
 auth=['--user',user,'-a','CHANGE_ME_APP' if user=='app' else 'CHANGE_ME_MONITOR','--no-auth-warning'] if user else []
 return run('exec',container,'redis-cli','--raw','-p',str(port),*auth,*map(str,args))
def check(name,actual,expected):
 if expected not in actual:raise AssertionError((name,expected,actual))
 results.append({'check':name,'output':actual});print(name+': '+actual.replace('\n',' / '))
check('Redis version',cli('INFO','server'),'redis_version:7.2')
# Validate both selectable role configurations, not just the common fragment.
base=(resource/'redis.conf').read_text()
roles=(resource/'roles.conf').read_text();split=roles.index('############ ②')
for name,role,port in [('cache',roles[:split],16400),('state',roles[split:],16401)]:
 conf=resource/(name+'-effective.conf');conf.write_text(base+'\n'+role)
 run('cp',str(conf),container+':/tmp/'+name+'.conf')
 run('exec',container,'mkdir','-p','/tmp/config-'+name)
 run('exec',container,'redis-server','/tmp/'+name+'.conf','--bind','127.0.0.1','--port',str(port),'--dir','/tmp/config-'+name,'--daemonize','yes','--logfile','/tmp/config-'+name+'.log')
 check('copyable config '+name,cli('PING',port=port),'PONG')
 cli('SHUTDOWN','NOSAVE',port=port)
# Apply the exact ACL directives from the course. Keep the admin connection until checks finish.
acl=(resource/'app.acl').read_text()
for line in acl.splitlines():
 if line.startswith('user app ') or line.startswith('user monitor '):
  args=shlex.split(line);cli('ACL','SETUSER',*args[1:])
check('app business SET',cli('SET','stock:acl','5',user='app'),'OK')
check('app actual stock Lua',cli('EVAL',(resource/'scripts/deduct-stock.lua').read_text(),'1','stock:acl','1',user='app'),'1\n4')
check('app actual token bucket Lua',cli('EVAL',(resource/'scripts/rate-token-bucket.lua').read_text(),'1','rl:tb:acl','1','1','1',user='app'),'1\n0\n0')
for command in [('CONFIG','SET','slowlog-log-slower-than','1'),('FLUSHDB',),('ACL','SETUSER','should-not-exist','on')]:
 check('app denied '+' '.join(command[:2]),cli(*command,user='app'),'NOPERM')
check('app outside namespace denied',cli('SET','outside:acl','x',user='app'),'NOPERM')
check('monitor INFO',cli('INFO','server',user='monitor'),'redis_version:')
check('monitor CONFIG GET',cli('CONFIG','GET','maxmemory',user='monitor'),'maxmemory')
check('monitor CONFIG SET denied',cli('CONFIG','SET','maxmemory','0',user='monitor'),'NOPERM')
# Run the actual HA bootstrap block after substituting only the disposable container name.
ha=(resource/'ha-start.sh').read_text().replace('docker exec redis-ha','docker exec '+container)
ha_script=resource/'ha-start.sh';ha_script.write_text(ha)
subprocess.run(['bash',str(ha_script)],check=True,capture_output=True,text=True,timeout=30)
check('HA bootstrap primary',cli('PING',port=6380),'PONG')
check('HA separate working directory',cli('CONFIG','GET','dir',port=6381),'/lab/r1')
# A real three-master Cluster, all internal ports; no extra host port mapping.
for port in [16301,16302,16303]:
 run('exec',container,'mkdir','-p','/tmp/cluster-'+str(port))
 run('exec',container,'redis-server','--port',str(port),'--bind','127.0.0.1','--cluster-enabled','yes','--cluster-config-file','nodes.conf','--cluster-node-timeout','1000','--cluster-announce-ip','127.0.0.1','--appendonly','no','--save','','--daemonize','yes','--dir','/tmp/cluster-'+str(port),'--logfile','/tmp/cluster-'+str(port)+'.log')
run('exec',container,'redis-cli','--cluster','create','127.0.0.1:16301','127.0.0.1:16302','127.0.0.1:16303','--cluster-replicas','0','--cluster-yes')
for i in range(50):
 if 'cluster_state:ok' in cli('CLUSTER','INFO',port=16301):break
 time.sleep(.1)
else:raise AssertionError('cluster not ready')
script=(resource/'scripts/rate-sliding-counter.lua').read_text()
check('sliding counter without shared tag',cli('EVAL',script,'2','rl:user:alice:10','rl:user:alice:9','100','1000','0',port=16301),'CROSSSLOT')
# -c follows MOVED, demonstrating a correctly tagged request routed to its owner.
tagged=run('exec',container,'redis-cli','-c','--raw','-p','16301','EVAL',script,'2','rl:{user:alice}:10','rl:{user:alice}:9','100','1000','0')
check('sliding counter with shared tag',tagged,'1\n99\n0')
(resource.parent/'cli-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
