package com.example.lab11.messaging;

import com.example.lab11.events.OrderCreatedEvent;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.kafka.KafkaAutoConfiguration;
import org.apache.kafka.clients.admin.*;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.*;
import org.apache.kafka.common.serialization.*;
import org.springframework.kafka.core.*;
import org.springframework.kafka.listener.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.*;

class KafkaPipelineTest {
 String bootstrap(){return "localhost:"+Integer.getInteger("review.kafka.port");}
 String topics(){String t="pipeline-"+UUID.randomUUID();try(var a=Admin.create(Map.of("bootstrap.servers",bootstrap()))){a.createTopics(List.of(new NewTopic(t,1,(short)1),new NewTopic(t+".DLT",1,(short)1))).all().get(10,TimeUnit.SECONDS);}catch(Exception e){throw new RuntimeException(e);}return t;}
 ConsumerRecord<String,byte[]> receive(String topic){
  var p=new HashMap<String,Object>();p.put("bootstrap.servers",bootstrap());p.put("enable.auto.commit",false);p.put("key.deserializer",StringDeserializer.class);p.put("value.deserializer",ByteArrayDeserializer.class);
  try(var c=new KafkaConsumer<String,byte[]>(p)){var tp=new TopicPartition(topic,0);c.assign(List.of(tp));c.seekToBeginning(List.of(tp));long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);while(System.nanoTime()<deadline){var records=c.poll(Duration.ofMillis(100));if(!records.isEmpty())return records.iterator().next();}throw new AssertionError("no record in "+topic);}
 }
 ApplicationContextRunner context(){return new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(KafkaAutoConfiguration.class)).withUserConfiguration(KafkaReliabilityConfig.class)
  .withPropertyValues("spring.kafka.bootstrap-servers="+bootstrap(),"spring.kafka.producer.acks=all","spring.kafka.producer.properties.max.block.ms=3000", "spring.kafka.producer.properties.request.timeout.ms=1000","spring.kafka.producer.properties.delivery.timeout.ms=3000",
   "spring.kafka.consumer.enable-auto-commit=false","spring.kafka.consumer.auto-offset-reset=earliest","spring.kafka.consumer.key-deserializer=org.apache.kafka.common.serialization.StringDeserializer",
   "spring.kafka.consumer.value-deserializer=org.springframework.kafka.support.serializer.ErrorHandlingDeserializer","spring.kafka.consumer.properties.spring.deserializer.value.delegate.class=org.springframework.kafka.support.serializer.JsonDeserializer",
   "spring.kafka.consumer.properties.spring.json.trusted.packages=com.example.lab11.events","spring.kafka.consumer.properties.spring.json.value.default.type=com.example.lab11.events.OrderCreatedEvent");}
 @Test void oneTemplateSendsDtoAndRawBytesToRealBroker(){
  String t=topics();context().run(c->{assertThat(c).hasNotFailed();KafkaTemplate<Object,Object> kafka=c.getBean(KafkaTemplate.class);
   kafka.send(t,"O1",new OrderCreatedEvent("E1","O1")).get(5,TimeUnit.SECONDS);var dto=receive(t);assertThat(new com.fasterxml.jackson.databind.ObjectMapper().readValue(dto.value(),OrderCreatedEvent.class)).isEqualTo(new OrderCreatedEvent("E1","O1"));
   byte[] raw="invalid-json-as-bytes".getBytes(UTF_8);kafka.send(t+".DLT","O1",raw).get(5,TimeUnit.SECONDS);assertThat(receive(t+".DLT").value()).isEqualTo(raw);
  });
 }
 @Test void deserializationFailureIsPublishedToDltAsOriginalBytes(){
  String t=topics();context().run(c->{assertThat(c).hasNotFailed();KafkaTemplate<Object,Object> kafka=c.getBean(KafkaTemplate.class);byte[] raw="{broken-json".getBytes(UTF_8);kafka.send(t,"O1",raw).get(5,TimeUnit.SECONDS);
   var f=c.getBean(org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory.class);var container=f.createContainer(t);container.getContainerProperties().setGroupId("deser-"+UUID.randomUUID());var calls=new AtomicInteger();container.setupMessageListener((MessageListener<Object,Object>)r->calls.incrementAndGet());container.start();
   try{var dead=receive(t+".DLT");assertThat(dead.value()).isEqualTo(raw);assertThat(new String(dead.headers().lastHeader("X-Replay-Count").value(),UTF_8)).isEqualTo("0");assertThat(calls.get()).isZero();}finally{container.stop();}
  });
 }
}
