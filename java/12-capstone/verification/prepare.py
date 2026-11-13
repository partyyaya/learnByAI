#!/usr/bin/env python3
"""Extract revised Markdown examples; wrappers supply only domain test fixtures."""
from pathlib import Path
import re,shutil,json
ROOT=Path(__file__).resolve().parent
COURSE=ROOT.parent
blocks=[]
for p in sorted(COURSE.glob('*.md')):
 for m in re.finditer(r'^```([^\n]*)\n(.*?)^```',p.read_text(),re.M|re.S):
  blocks.append((p.name,m.group(1),m.group(2),p.read_text()[:m.start()][-800:]))
def get(ch,needle,lang='java'):
 found=[s for f,l,s,b in blocks if f.startswith(ch) and l==lang and needle in s]
 assert found,(ch,needle)
 return found[-1]
def braced(s,start):
 # Used on known methods/loops, whose strings have balanced braces.
 a=s.index('{',start);depth=1;i=a+1
 while depth:
  depth+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[start:i]
out=ROOT/'target/generated-sources/lessons';shutil.rmtree(out,ignore_errors=True)
def emit(name,s,pkg=None):
 if pkg:s='package '+pkg+';\nimport java.util.*;import org.springframework.jdbc.core.JdbcTemplate;\n'+s
 package=re.search(r'^package ([\w.]+);',s,re.M)[1]
 path=out/Path(package.replace('.','/'))/(name+'.java');path.parent.mkdir(parents=True,exist_ok=True);path.write_text(s)
selected=['ProductCache','ProductStatus','RedisGuard','ProblemType','ShopException','ShopProperties','Event','EventTypes','NotificationHandler','SimulatedMailer','RabbitTopology','GlobalExceptionHandler','ConstraintViolations']
for name in selected:
 found=[s for f,l,s,b in blocks if l=='java' and re.search(r'^package com\.example\.shop[\w.]*;',s,re.M) and re.search(r'^(?:public )?(?:final )?(?:class|enum|record|interface) '+name+r'\b',s,re.M)]
 assert found,name
 emit(name,found[-1])
emit('EventHandler', get('07','public interface EventHandler'),pkg='com.example.shop.shared.events')
for ch,name in [('04','ReservationAccess'),('07','CountedReservationAccess')]:
 s=get(ch,'private List<Held> held');held=braced(s,s.index('private List<Held> held'));rec=re.search(r'    record Held\([^\n]+',s)[0]
 emit(name,'public class '+name+' { private final JdbcTemplate jdbc; public '+name+'(JdbcTemplate jdbc){this.jdbc=jdbc;}\n'+rec+'\n'+held+'\npublic List<Held> lock(long orderId){return held(orderId,"\'HELD\', \'CONFIRMED\'");}\n}',pkg='review')
s=get('04','class PlaceOrderService');loop=braced(s,s.index('for (int attempt'))
emit('RetryFixture','''package review;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.dao.DataIntegrityViolationException;
import com.example.shop.shared.error.ConstraintViolations;
import java.util.*;import java.util.function.Supplier;
public class RetryFixture {
static final int ORDER_NO_ATTEMPTS=3;
final TransactionTemplate tx;final Supplier<Integer> action;
public RetryFixture(TransactionTemplate tx,Supplier<Integer> action){this.tx=tx;this.action=action;}
Integer placeInTransaction(long buyerId,String idempotencyKey,List<Object> lines){return action.get();}
public Integer run(){long buyerId=1;String idempotencyKey="key";List<Object> lines=List.of();
'''+loop+'\n}}')
# Use the lesson's own dependencies, with only verification build settings added.
pom=get('00','<artifactId>shop</artifactId>','xml').replace('<artifactId>shop</artifactId>','<artifactId>capstone-verification</artifactId>')
# Later chapters add these dependencies to the initial chapter-00 POM.
pom=pom.replace('</dependencies>', '''<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-validation</artifactId></dependency>
<dependency><groupId>org.flywaydb</groupId><artifactId>flyway-core</artifactId></dependency>
<dependency><groupId>org.flywaydb</groupId><artifactId>flyway-mysql</artifactId></dependency>
</dependencies>''')
pom=re.sub(r'<build>.*?</build>','',pom,flags=re.S)
pom=pom.replace('</project>','<build><sourceDirectory>target/generated-sources/lessons</sourceDirectory></build>\n</project>')
(ROOT/'pom.xml').write_text(pom)
sql=[s for f,l,s,b in blocks if f.startswith('02') and l=='sql' and 'CREATE TABLE' in s]
assert sum(len(re.findall(r'CREATE TABLE ',s)) for s in sql)==19
(ROOT/'target/schema.sql').write_text('\n'.join(sql))
for n in [26,27,28]:
 found=[s for f,l,s,b in blocks if f.startswith('09') and l=='sql' and re.search(r'\*\*`[^`]*V'+str(n)+r'__[^`]+`\*\*\s*$',b)]
 assert len(found)==1,(n,len(found))
 (ROOT/f'target/V{n}.sql').write_text(found[0])
for name,needle in [('alerts.yml','groups:'),('alerts_test.yml','rule_files:')]:
 (ROOT/'target'/name).write_text(get('09',needle,'yaml'))
(ROOT/'target/prometheus.yml').write_text(get('09','scrape_configs:','yaml'))
print('Extracted',len(list(out.rglob('*.java'))),'classes, 19-table schema, migrations and Prometheus YAML')

import shutil
shutil.copyfile(ROOT/'stalled_test.yml',ROOT/'target/stalled_test.yml')
