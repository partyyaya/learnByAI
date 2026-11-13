package com.example.lab11.messaging;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.kafka.KafkaAutoConfiguration;
import org.springframework.boot.autoconfigure.amqp.RabbitAutoConfiguration;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.core.*;
import org.springframework.kafka.core.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.*;
import org.apache.kafka.common.serialization.*;
import org.springframework.kafka.support.SendResult;
import org.springframework.kafka.support.serializer.DelegatingByTypeSerializer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import com.example.lab11.events.OrderCreatedEvent;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class WiringTest {
 @Test void kafkaUsesOneManagedFactoryAndOneUsableTemplate(){
  new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(KafkaAutoConfiguration.class)).withUserConfiguration(KafkaReliabilityConfig.class)
   .withPropertyValues("spring.kafka.producer.value-serializer=org.springframework.kafka.support.serializer.JsonSerializer")
   .run(c->{assertThat(c).hasNotFailed();assertThat(c.getBeansOfType(KafkaTemplate.class)).containsOnlyKeys("kafkaTemplate");assertThat(c.getBeansOfType(ProducerFactory.class)).containsOnlyKeys("kafkaProducerFactory");
    var factory=c.getBean(DefaultKafkaProducerFactory.class);assertThat(factory.getValueSerializer()).isInstanceOf(DelegatingByTypeSerializer.class);
    Serializer<Object> serializer=factory.getValueSerializer();serializer.configure(factory.getConfigurationProperties(),false);
    byte[] raw="raw-binary".getBytes(UTF_8);assertThat(serializer.serialize("t",raw)).isEqualTo(raw);
    assertThat(new String(serializer.serialize("t",new OrderCreatedEvent("E","O")),UTF_8)).isEqualTo("{\"eventId\":\"E\",\"orderId\":\"O\"}");
   });
 }
 @Test void bootActuallyAppliesTraceInterceptor(){
  new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(KafkaAutoConfiguration.class)).withUserConfiguration(KafkaReliabilityConfig.class).run(c->{
   assertThat(c).hasNotFailed();var factory=c.getBean(org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory.class);var container=factory.createContainer("probe");
   assertThat(org.springframework.test.util.ReflectionTestUtils.getField(container,"recordInterceptor")).isSameAs(c.getBean("traceInterceptor"));
  });
 }
 @Test void rabbitCustomTemplatePreservesMandatoryAndOriginalTrace(){
  new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(RabbitAutoConfiguration.class)).withUserConfiguration(RabbitReliabilityConfig.class)
   .withBean(org.springframework.amqp.support.converter.MessageConverter.class,()->new org.springframework.amqp.support.converter.Jackson2JsonMessageConverter())
   .withPropertyValues("spring.rabbitmq.template.mandatory=true","spring.rabbitmq.publisher-returns=true","spring.rabbitmq.publisher-confirm-type=correlated")
   .run(c->{assertThat(c).hasNotFailed();var t=c.getBean(RabbitTemplate.class);var p=new MessageProperties();p.setHeader("X-Trace-Id","original");var message=new Message(new byte[0],p);assertThat(t.isMandatoryFor(message)).isTrue();
    var processors=(Collection<org.springframework.amqp.core.MessagePostProcessor>)org.springframework.test.util.ReflectionTestUtils.getField(t,"beforePublishPostProcessors");
    org.slf4j.MDC.put("traceId","new");try{for(var processor:processors)message=processor.postProcessMessage(message);assertThat(message.getMessageProperties().getHeaders()).containsEntry("X-Trace-Id","original");}finally{org.slf4j.MDC.clear();}
   });
 }
 @Test void gaugesReadLatestValuesFromSameObjects(){var registry=new SimpleMeterRegistry();try{
  var metrics=new OutboxMetrics(registry);metrics.refresh(50,1,2);assertThat(registry.get("outbox.pending").gauge().value()).isEqualTo(50);metrics.refresh(0,3,0);assertThat(registry.get("outbox.pending").gauge().value()).isZero();assertThat(registry.get("outbox.failed").gauge().value()).isEqualTo(3);assertThat(registry.get("outbox.unroutable").gauge().value()).isZero();
 }finally{registry.close();}}
 @Test void recovererPreservesReplayCountAndDoesNotDuplicateTraceHeader(){
  var template=mock(KafkaTemplate.class);var sent=new AtomicReference<ProducerRecord<Object,Object>>();
  when(template.send(any(ProducerRecord.class))).thenAnswer(inv->{ProducerRecord<Object,Object> r=inv.getArgument(0);sent.set(r);return CompletableFuture.completedFuture(new SendResult<>(r,new RecordMetadata(new TopicPartition(r.topic(),0),0,0,0,0,0)));});
  var rec=new ConsumerRecord<Object,Object>("source",0,0,"k",new OrderCreatedEvent("E","O"));rec.headers().add("X-Replay-Count","2".getBytes(UTF_8));rec.headers().add("X-Trace-Id","trace".getBytes(UTF_8));
  var recoverer=new KafkaReliabilityConfig().recoverer(template);recoverer.setVerifyPartition(false);recoverer.accept(rec,new RuntimeException("failed"));
  assertThat(new String(sent.get().headers().lastHeader("X-Replay-Count").value(),UTF_8)).isEqualTo("2");assertThat(sent.get().headers().headers("X-Trace-Id")).hasSize(1);
 }
 @Test void recovererInitializesMissingReplayCount(){
  var template=mock(KafkaTemplate.class);var sent=new AtomicReference<ProducerRecord<Object,Object>>();
  when(template.send(any(ProducerRecord.class))).thenAnswer(inv->{ProducerRecord<Object,Object> r=inv.getArgument(0);sent.set(r);return CompletableFuture.completedFuture(new SendResult<>(r,new RecordMetadata(new TopicPartition(r.topic(),0),0,0,0,0,0)));});
  var recoverer=new KafkaReliabilityConfig().recoverer(template);recoverer.setVerifyPartition(false);recoverer.accept(new ConsumerRecord<>("source",0,0,"k","poison"),new RuntimeException("failure"));assertThat(new String(sent.get().headers().lastHeader("X-Replay-Count").value(),UTF_8)).isEqualTo("0");
 }
 @Test void recovererPropagatesDltSendFailure(){
  var template=mock(KafkaTemplate.class);when(template.send(any(ProducerRecord.class))).thenReturn(CompletableFuture.failedFuture(new IllegalStateException("DLT unavailable")));
  var recoverer=new KafkaReliabilityConfig().recoverer(template);recoverer.setVerifyPartition(false);assertThatThrownBy(()->recoverer.accept(new ConsumerRecord<>("source",0,0,"k","poison"),new RuntimeException("failure"))).isInstanceOf(org.springframework.kafka.KafkaException.class);
 }
 @Test void traceIsRemovedAfterRecord(){var interceptor=new KafkaReliabilityConfig().traceInterceptor();var r=new ConsumerRecord<Object,Object>("t",0,0,"k","v");r.headers().add("X-Trace-Id","trace1".getBytes(UTF_8));interceptor.intercept(r,null);assertThat(org.slf4j.MDC.get("traceId")).isEqualTo("trace1");interceptor.afterRecord(r,null);assertThat(org.slf4j.MDC.get("traceId")).isNull();}
 @Test void fixedRateDoesNotOverlapOneSynchronousTaskEvenWithPool()throws Exception{
  var scheduler=new org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler();scheduler.setPoolSize(4);scheduler.initialize();var active=new AtomicInteger();var maximum=new AtomicInteger();var done=new CountDownLatch(5);
  var f=scheduler.scheduleAtFixedRate(()->{int n=active.incrementAndGet();maximum.accumulateAndGet(n,Math::max);try{Thread.sleep(20);}catch(InterruptedException e){Thread.currentThread().interrupt();}finally{active.decrementAndGet();done.countDown();}},java.time.Duration.ofMillis(2));
  try{assertThat(done.await(3,TimeUnit.SECONDS)).isTrue();assertThat(maximum.get()).isEqualTo(1);}finally{f.cancel(true);scheduler.shutdown();}
 }
}
