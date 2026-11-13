#!/usr/bin/env python3
"""Compile current chapter-14 examples and run focused regression checks."""
import argparse,json,subprocess,sys,shutil,xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--offline',action='store_true');args=parser.parse_args()
subprocess.run([sys.executable,str(ROOT/'prepare.py')],cwd=ROOT,check=True)
target=ROOT/'target'
shutil.rmtree(target/'surefire-reports',ignore_errors=True)
command=['mvn']+(['-o'] if args.offline else [])+['-q','test']
with (target/'verification.log').open('w') as log:
 result=subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
if result.returncode:
 print((target/'verification.log').read_text()[-16000:]);sys.exit(result.returncode)
summary={key:0 for key in ['tests','failures','errors','skipped']}
for report in (target/'surefire-reports').glob('TEST-*.xml'):
 suite=ET.parse(report).getroot()
 for key in summary:summary[key]+=int(suite.attrib[key])
assert summary['tests']>0,'No tests executed'
(target/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print('JUnit: '+json.dumps(summary),flush=True)
print('Logs: '+str(target/'verification.log'),flush=True)
