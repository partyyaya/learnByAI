#!/usr/bin/env python3
"""Run current Markdown examples against disposable local Docker services."""
import argparse, json, subprocess, sys, time, uuid, shutil
from pathlib import Path
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parent
TARGET=ROOT/'target'
owned=[]
def command(args, **kwargs):
 return subprocess.run(args,check=True,text=True,**kwargs)
def output(args,timeout=60):
 return command(args,capture_output=True,timeout=timeout).stdout.strip()
def start(kind,image,port,env,host_port=None):
 name='java12-verify-'+kind+'-'+uuid.uuid4().hex[:10]
 owned.append(name)
 args=['docker','run','--rm','-d','--name',name,'--label','learnbyai.verification=java12','-p',f'127.0.0.1:{host_port or ""}:{port}']
 if kind=='rabbit':args+=['-p','127.0.0.1::15692']
 for k,v in env.items():args+=['-e',k+'='+str(v)]
 output(args+[image],timeout=180)
 mapped=int(output(['docker','port',name,str(port)+'/tcp']).split(':')[-1])
 print(f'{kind}: {name} localhost:{mapped}',flush=True)
 return name,mapped
def ready(name,args):
 deadline=time.monotonic()+120
 while time.monotonic()<deadline:
  try:
   subprocess.run(['docker','exec',name,*args],check=True,capture_output=True,timeout=15)
   return
  except (subprocess.CalledProcessError,subprocess.TimeoutExpired):time.sleep(1)
 raise RuntimeError('service readiness timeout: '+name)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--offline',action='store_true',help='Use cached Maven dependencies only');args=parser.parse_args()
 TARGET.mkdir(exist_ok=True)
 command([sys.executable,str(ROOT/'prepare.py')],cwd=ROOT)
 shutil.rmtree(TARGET/'surefire-reports',ignore_errors=True)
 ports={}
 try:
  rabbit,ports['rabbit']=start('rabbit','rabbitmq:3.13-management',5672,{'RABBITMQ_DEFAULT_USER':'lab','RABBITMQ_DEFAULT_PASS':'lab'})
  mysql,ports['mysql']=start('mysql','mysql:8.0',3306,{'MYSQL_ROOT_PASSWORD':'root','MYSQL_DATABASE':'review','MYSQL_USER':'lab','MYSQL_PASSWORD':'lab'})
  redis,ports['redis']=start('redis','redis:7.2',6379,{})
  (TARGET/'containers.json').write_text(json.dumps({'names':owned,'ports':ports},indent=2))
  ready(mysql,['mysql','-h127.0.0.1','-ulab','-plab','review','-e','SELECT 1'])
  ready(rabbit,['rabbitmq-diagnostics','-q','ping'])
  ready(redis,['redis-cli','ping'])
  output(['docker','exec',rabbit,'rabbitmq-plugins','enable','rabbitmq_prometheus'])
  ports['rabbit.metrics']=int(output(['docker','port',rabbit,'15692/tcp']).split(':')[-1])
  output(['docker','exec',rabbit,'rabbitmqctl','eval','application:set_env(rabbit, dead_letter_worker_publisher_confirm_timeout, 1000).'])
  # Fresh DDL is extracted from chapter 02. No user database is contacted.
  command(['docker','exec','-i',mysql,'mysql','-ulab','-plab','review'],input=(TARGET/'schema.sql').read_text())
  command(['docker','exec','-i',mysql,'mysql','-ulab','-plab','review'],input='ALTER TABLE inventory_reservations ADD counted BOOLEAN NOT NULL DEFAULT TRUE;')
  print('Services ready; running Maven tests',flush=True)
  mvn=['mvn']+(['-o'] if args.offline else [])+['-q','-f',str(ROOT/'pom.xml')]
  mvn += [f'-Dreview.{kind}.port={port}' for kind,port in ports.items()]+['test']
  with (TARGET/'verification.log').open('w') as log:
   result=subprocess.run(mvn,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
  if result.returncode:
   print((TARGET/'verification.log').read_text()[-16000:]);raise RuntimeError('Maven tests failed; see target/verification.log')
  summary={key:0 for key in ['tests','failures','errors','skipped']}
  for report in (TARGET/'surefire-reports').glob('TEST-*.xml'):
   suite=ET.parse(report).getroot()
   for key in summary:summary[key]+=int(suite.attrib[key])
  print('JUnit: '+json.dumps(summary),flush=True)
  (TARGET/'summary.json').write_text(json.dumps(summary,indent=2))
  command(['docker','run','--rm','--entrypoint','/bin/promtool','-v',f'{TARGET}:/rules:ro','prom/prometheus:v3.5.0','check','rules','/rules/alerts.yml'])
  for filename in ['alerts_test.yml','stalled_test.yml']:
   command(['docker','run','--rm','--entrypoint','/bin/promtool','-v',f'{TARGET}:/rules:ro','-w','/rules','prom/prometheus:v3.5.0','test','rules',filename])
  print('Verification passed.',flush=True)
 except BaseException:
  for name in owned:
   result=subprocess.run(['docker','logs','--tail','80',name],text=True,capture_output=True)
   (TARGET/(name+'.log')).write_text(result.stdout+result.stderr)
  raise
 finally:
  for name in reversed(owned):
   subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  print('Removed this run\'s disposable containers.',flush=True)
if __name__=='__main__':main()
