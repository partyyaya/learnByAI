#!/usr/bin/env python3
"""Extract current lesson examples; only add imports/getters and small domain fixtures."""
from pathlib import Path
import re, shutil
ROOT=Path(__file__).resolve().parent
COURSE=ROOT.parent
blocks=[]
for path in sorted(COURSE.glob('*.md')):
 for m in re.finditer(r'^```([^\n]*)\n(.*?)^```',path.read_text(),re.M|re.S):
  blocks.append((path.name,m.group(1),m.group(2)))
def get(ch,needle,lang='java'):
 found=[s for f,l,s in blocks if f.startswith(ch) and l==lang and needle in s]
 assert len(found)==1,(ch,needle,len(found))
 return found[0]
out=ROOT/'target/generated-sources/lessons'
shutil.rmtree(out,ignore_errors=True)
def emit(name,source,imports='',package='com.example.lab11.messaging'):
 source=re.sub(r'^package [\w.]+;\n','',source,flags=re.M)
 p=out/Path(package.replace('.','/'))/(name+'.java');p.parent.mkdir(parents=True,exist_ok=True)
 p.write_text('package '+package+';\n'+imports+'\n'+source)
# Maven sourceDirectory points to generated examples, not a frozen copy of the implementations.
pom=get('00','<artifactId>lab11</artifactId>','xml').replace('<artifactId>lab11</artifactId>','<artifactId>messaging-verification</artifactId>')
pom=pom.replace('</dependencies>','''  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-redis</artifactId></dependency>
  </dependencies>''')
pom=pom.replace('</project>','''  <build><sourceDirectory>target/generated-sources/lessons</sourceDirectory></build>
</project>''')
(ROOT/'pom.xml').write_text(pom)
common='''import org.springframework.stereotype.*;import org.springframework.transaction.annotation.*;
import org.springframework.beans.factory.annotation.*;import java.time.*;import java.util.*;
import org.springframework.scheduling.annotation.Scheduled;import org.springframework.data.domain.PageRequest;'''
jpa='import jakarta.persistence.*;import java.time.Instant;'
emit('OutboxMessage',get('02','public class OutboxMessage').replace('// getters...', '''public String getId(){return id;} public String getEventType(){return eventType;}
public String getPayload(){return payload;} public int getAttempts(){return attempts;}'''),jpa)
emit('Order',get('02','public class Order {'),jpa)
emit('OrderRepository','public interface OrderRepository extends JpaRepository<Order,String> {}','import org.springframework.data.jpa.repository.JpaRepository;')
emit('OutboxOrderService',get('02','public class OutboxOrderService'),common+'\nimport com.fasterxml.jackson.core.JsonProcessingException;import com.fasterxml.jackson.databind.ObjectMapper;import com.example.lab11.events.OrderCreatedEvent;')
emit('ProcessedMessage',get('03','public class ProcessedMessage'),jpa)
emit('OrderCreatedEvent',get('02','public record OrderCreatedEvent'),package='com.example.lab11.events')
emit('OutboxRepository',get('02','public interface OutboxRepository'),'''import java.time.Instant;import java.util.List;import jakarta.persistence.LockModeType;import jakarta.persistence.QueryHint;
import org.springframework.data.jpa.repository.*;import org.springframework.data.domain.*;import org.springframework.data.repository.query.Param;''')
emit('ProcessedMessageRepository','public interface ProcessedMessageRepository extends JpaRepository<ProcessedMessage,ProcessedMessage.Key> {\n'+get('03','int claim(@Param("id")')+'\n}', 'import org.springframework.data.jpa.repository.*;import org.springframework.data.repository.query.Param;')
for ch,name in [('02','ConfirmedRabbitSender'),('02','OutboxMetrics'),('03','DedupClaims'),('06','OrderTopology'),('06','MailGateway'),('06','MailDeliveryService'),('06','RabbitRetryRouter'),('06','ConfirmMailConsumer'),('07','OrderEventPublisher'),('10','KafkaReliabilityConfig'),('10','RabbitReliabilityConfig'),('11','RabbitKafkaBridge')]:
 emit(name,get(ch,'public '+('interface ' if name=='MailGateway' else 'class ')+name))
s=get('03','public class CreditWorker');a=s.index('@Service\npublic class CreditConsumer')
emit('CreditWorker',s[:a],common);emit('CreditConsumer',s[a:],common)
s=get('02','public class OutboxPump');a=s.index('@Component\npublic class OutboxPump')
emit('OutboxPoller',s[:a],common);emit('OutboxPump',s[a:],common)
emit('ReliablePublisher',get('05','public class ReliablePublisher'),common)
# Optional cache facade wraps the exact method; no implementation substitution.
emit('CachedCreditConsumer','''public class CachedCreditConsumer {
private final CreditWorker worker;private final StringRedisTemplate redis;
private final org.slf4j.Logger log=org.slf4j.LoggerFactory.getLogger(getClass());
public CachedCreditConsumer(CreditWorker worker,StringRedisTemplate redis){this.worker=worker;this.redis=redis;}
'''+get('03','String key = "dedup:credit:"')+'\n}',common+'\nimport org.springframework.data.redis.core.StringRedisTemplate;')
# Domain tables are tiny test fixtures; messaging code above comes from Markdown.
emit('Account','''@Entity @Table(name="account") public class Account {
@Id public String id;public long balance;public Account(){} }''',jpa)
emit('AccountRepository','''public interface AccountRepository extends JpaRepository<Account,String> {
@Modifying @Query("update Account a set a.balance=a.balance+:n where a.id=:id")
void increment(@Param("id")String id,@Param("n")long n);
}''','import org.springframework.data.jpa.repository.*;import org.springframework.data.repository.query.Param;')
# Alert YAML is the actual lesson block.
(ROOT/'target/alerts.yml').write_text(get('10','groups:','yaml'))
print('Generated',len(list(out.rglob('*.java'))),'lesson classes and target/alerts.yml')
