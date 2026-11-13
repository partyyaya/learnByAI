#!/usr/bin/env python3
"""Extract chapter 14 verbatim; change only Maven verification build settings."""
from pathlib import Path
import re,shutil
ROOT=Path(__file__).resolve().parent
CHAPTER=ROOT.parents[1]/'14-common-apis-and-libraries.md'
s=CHAPTER.read_text()
blocks=list(re.finditer(r'^```([^\n]*)\n(.*?)^```',s,re.M|re.S))
target=ROOT/'target';target.mkdir(exist_ok=True)
out=target/'generated-sources/lessons';shutil.rmtree(out,ignore_errors=True)
classes=[]
for m in blocks:
 if m[1]!='java':continue
 source=m[2]
 name=re.search(r'^public class (\w+)',source,re.M)[1]
 package=re.search(r'^package ([\w.]+);',source,re.M)[1]
 p=out/Path(package.replace('.','/'))/(name+'.java');p.parent.mkdir(parents=True,exist_ok=True);p.write_text(source)
 classes.append(name)
assert len(classes)==len(set(classes))
pom=next(m[2] for m in blocks if m[1]=='xml' and '<artifactId>toolbox-lab</artifactId>' in m[2])
pom=pom.replace('  <dependencies>\n    <dependency>\n      <groupId>org.apache.commons</groupId>', '''  <dependencies>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.11.4</version><scope>test</scope></dependency>
    <dependency>
      <groupId>org.apache.commons</groupId>''',1)
pom=pom.replace('<build>','<build>\n    <sourceDirectory>target/generated-sources/lessons</sourceDirectory>',1)
pom=pom.replace('<plugins>','''<plugins>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.5.2</version></plugin>''',1)
(ROOT/'pom.xml').write_text(pom)
(target/'classes.txt').write_text('\n'.join(classes)+'\n')
print('Extracted '+str(len(classes))+' complete Java examples from '+CHAPTER.name,flush=True)
