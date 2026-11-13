package com.example.lab11.messaging;
import org.junit.jupiter.api.Test;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.clients.admin.*;
import org.apache.kafka.common.*;
import org.apache.kafka.common.serialization.*;
import org.springframework.kafka.listener.*;
import org.springframework.kafka.core.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;

class AckModeTest {
 @Test void timeAndCountCommitOnlyProcessedOffsets()throws Exception{
  String bootstrap="localhost:"+Integer.getInteger("review.kafka.port");
  for(var mode:List.of(ContainerProperties.AckMode.TIME,ContainerProperties.AckMode.COUNT,ContainerProperties.AckMode.COUNT_TIME)){
   String topic="ack-review-"+UUID.randomUUID(),group="group-"+UUID.randomUUID();var tp=new TopicPartition(topic,0);
   try(var admin=Admin.create(Map.of("bootstrap.servers",bootstrap))){
    admin.createTopics(List.of(new NewTopic(topic,1,(short)1))).all().get(10,TimeUnit.SECONDS);
    try(var p=new KafkaProducer<String,String>(Map.of("bootstrap.servers",bootstrap,"key.serializer",StringSerializer.class,"value.serializer",StringSerializer.class))){
     p.send(new ProducerRecord<>(topic,"k","first")).get(5,TimeUnit.SECONDS);p.send(new ProducerRecord<>(topic,"k","blocked")).get(5,TimeUnit.SECONDS);
    }
    var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
    var factory=new DefaultKafkaConsumerFactory<String,String>(Map.of("bootstrap.servers",bootstrap,"group.id",group,"enable.auto.commit",false,"auto.offset.reset","earliest","key.deserializer",StringDeserializer.class,"value.deserializer",StringDeserializer.class));
    var props=new ContainerProperties(topic);props.setGroupId(group);props.setAckMode(mode);props.setAckCount(1);props.setAckTime(1);props.setPollTimeout(50);
    props.setMessageListener((MessageListener<String,String>)record->{if(record.offset()==1){entered.countDown();try{release.await(5,TimeUnit.SECONDS);}catch(InterruptedException e){throw new RuntimeException(e);}}});
    var container=new KafkaMessageListenerContainer<>(factory,props);container.start();
    try{
     assertThat(entered.await(8,TimeUnit.SECONDS)).isTrue();
     var before=admin.listConsumerGroupOffsets(group).partitionsToOffsetAndMetadata().get(5,TimeUnit.SECONDS).get(tp);
     assertThat(before==null || before.offset()<=1).isTrue();release.countDown();
     long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);long offset=-1;
     while(System.nanoTime()<end){var committed=admin.listConsumerGroupOffsets(group).partitionsToOffsetAndMetadata().get(5,TimeUnit.SECONDS).get(tp);offset=committed==null?-1:committed.offset();if(offset==2)break;Thread.sleep(20);}
     assertThat(offset).isEqualTo(2);
    }finally{release.countDown();container.stop();}
   }
  }
  System.out.println("CONFIRMED: TIME/COUNT/COUNT_TIME never commit blocked record; all commit only after it completes");
 }
}
