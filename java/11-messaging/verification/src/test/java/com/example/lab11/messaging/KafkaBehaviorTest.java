package com.example.lab11.messaging;
import org.junit.jupiter.api.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.clients.admin.*;
import org.apache.kafka.common.serialization.*;
import org.apache.kafka.common.*;
import org.springframework.kafka.listener.*;
import org.springframework.kafka.core.*;
import org.springframework.kafka.support.SendResult;
import java.time.*;import java.util.*;import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class KafkaBehaviorTest {
 static String bootstrap(){return "localhost:"+Integer.getInteger("review.kafka.port");}
 Map<String,Object> props(){var p=new HashMap<String,Object>();p.put("bootstrap.servers",bootstrap());p.put("key.serializer",StringSerializer.class);p.put("value.serializer",StringSerializer.class);p.put("max.block.ms",5000);p.put("request.timeout.ms",3000);p.put("delivery.timeout.ms",5000);return p;}
 String topic(){String t="review-"+UUID.randomUUID();try(var a=Admin.create(Map.of("bootstrap.servers",bootstrap()))){a.createTopics(List.of(new NewTopic(t,1,(short)1))).all().get(10,TimeUnit.SECONDS);}catch(Exception e){throw new RuntimeException(e);}return t;}
 @Test void compatibleTimeoutsAllowProducerConstruction(){
  var p=props();p.put("request.timeout.ms",1000);p.put("linger.ms",0);p.put("delivery.timeout.ms",3000);
  try(var producer=new KafkaProducer<String,String>(p)){assertThat(producer).isNotNull();}

 }
 @Test void fixedTransactionalIdDoesNotDeduplicateCommittedApplicationResends()throws Exception{
  String t=topic(),tx="review-tx-"+UUID.randomUUID();var p=props();p.put("transactional.id",tx);
  for(int i=0;i<2;i++)try(var producer=new KafkaProducer<String,String>(p)){
   producer.initTransactions();producer.beginTransaction();producer.send(new ProducerRecord<>(t,"order-1","same-event")).get(5,TimeUnit.SECONDS);producer.commitTransaction();
  }
  var cp=new HashMap<String,Object>();cp.put("bootstrap.servers",bootstrap());cp.put("key.deserializer",StringDeserializer.class);cp.put("value.deserializer",StringDeserializer.class);cp.put("isolation.level","read_committed");cp.put("enable.auto.commit",false);cp.put("auto.offset.reset","earliest");
  int found=0;try(var c=new KafkaConsumer<String,String>(cp)){var tp=new TopicPartition(t,0);c.assign(List.of(tp));c.seekToBeginning(List.of(tp));long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(found<2&&System.nanoTime()<end)found+=c.poll(Duration.ofMillis(200)).count();}
  assertThat(found).isEqualTo(2);System.out.println("CONFIRMED: two sessions with same transactional.id each commit same business event; read_committed receives two");
 }
 @Test void uniqueSpringPrefixesAllowBothInstancesToCommit(){
  String t=topic(),prefix="shared-review-"+UUID.randomUUID()+"-";
  var a=new DefaultKafkaProducerFactory<String,String>(props());a.setTransactionIdPrefix(prefix);
  var b=new DefaultKafkaProducerFactory<String,String>(props());b.setTransactionIdPrefix(prefix+"other-");
  try{
   var first=a.createProducer();first.beginTransaction();
   var second=b.createProducer();second.beginTransaction();second.send(new ProducerRecord<>(t,"k","B")).get(5,TimeUnit.SECONDS);second.commitTransaction();
   first.send(new ProducerRecord<>(t,"k","A")).get(5,TimeUnit.SECONDS);first.commitTransaction();
   second.close();first.close();
  }catch(Exception e){throw new RuntimeException(e);}finally{a.destroy();b.destroy();}
  
 }
 static Throwable root(Throwable e){while(e.getCause()!=null)e=e.getCause();return e;}
 @Test void controlDefaultDeadLetterRecovererDoesPropagateFailedFuture(){
  KafkaTemplate<String,String> template=mock(KafkaTemplate.class);
  when(template.isTransactional()).thenReturn(false);
  when(template.send(any(ProducerRecord.class))).thenReturn(CompletableFuture.failedFuture(new IllegalStateException("DLT unavailable")));
  var recoverer=new DeadLetterPublishingRecoverer(template,(r,e)->new TopicPartition(r.topic()+".DLT",-1));
  assertThatThrownBy(()->recoverer.accept(new ConsumerRecord<>("source",0,0,"k","poison"),new RuntimeException("business failed"))).isInstanceOf(org.springframework.kafka.KafkaException.class);
  verify(template).send(any(ProducerRecord.class));
  System.out.println("CONTROL: default DeadLetterPublishingRecoverer correctly propagates failed DLT future; not a finding");
 }
}
