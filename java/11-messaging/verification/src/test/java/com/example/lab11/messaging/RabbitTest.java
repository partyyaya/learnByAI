package com.example.lab11.messaging;

import com.example.lab11.events.OrderCreatedEvent;
import org.junit.jupiter.api.*;
import org.springframework.amqp.rabbit.connection.*;
import org.springframework.amqp.rabbit.core.*;
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer;
import org.springframework.amqp.core.*;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.TopicPartition;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class RabbitTest {
 static CachingConnectionFactory cf;RabbitTemplate rabbit;RabbitAdmin admin;ConfirmedRabbitSender sender;
 @BeforeAll static void connect(){cf=new CachingConnectionFactory("localhost",Integer.getInteger("review.rabbit.port"));cf.setUsername("lab");cf.setPassword("lab");cf.setPublisherConfirmType(CachingConnectionFactory.ConfirmType.CORRELATED);cf.setPublisherReturns(true);}
 @AfterAll static void close(){cf.destroy();}
 @BeforeEach void setup(){rabbit=new RabbitTemplate(cf);rabbit.setMandatory(true);admin=new RabbitAdmin(cf);sender=new ConfirmedRabbitSender(rabbit);}
 static void await(java.util.function.BooleanSupplier f){long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);while(!f.getAsBoolean()&&System.nanoTime()<end)try{Thread.sleep(10);}catch(InterruptedException e){Thread.currentThread().interrupt();throw new RuntimeException(e);}assertThat(f.getAsBoolean()).isTrue();}
 Message receive(String q){var got=new AtomicReference<Message>();await(()->{Message m=rabbit.receive(q);if(m!=null)got.set(m);return got.get()!=null;});return got.get();}
 Message message(String id){var p=new MessageProperties();p.setMessageId(id);p.setContentType("application/json");return new Message(("{\"eventId\":\""+id+"\",\"orderId\":\"O1\"}").getBytes(UTF_8),p);}
 void topology(){var t=new OrderTopology();for(Exchange x:List.of(t.orderExchange(),t.orderDlx(),t.orderRetryX()))admin.declareExchange(x);
  for(org.springframework.amqp.core.Queue q:List.of(t.mailQueue(),t.retry5s(),t.retry1m(),t.retry10m(),t.parkingQueue())){
   var args=new HashMap<String,Object>(q.getArguments());if(args.containsKey("x-message-ttl"))args.put("x-message-ttl",100);
   admin.declareQueue(new org.springframework.amqp.core.Queue(q.getName(),q.isDurable(),q.isExclusive(),q.isAutoDelete(),args));admin.purgeQueue(q.getName());
  }
  for(Binding b:List.of(t.mailBinding(),t.retry5sBinding(),t.retry1mBinding(),t.retry10mBinding(),t.parkingBinding()))admin.declareBinding(b);
 }
 @Test void ackWithReturnIsRejected(){String x="verify.unrouted.x";admin.declareExchange(new DirectExchange(x));assertThatThrownBy(()->sender.sendJson("E-unroute",x,"missing","{}")).isInstanceOf(ConfirmedRabbitSender.UnroutableMessageException.class);}
 @Test void nackIsRejected(){String q="verify.full.q";admin.declareQueue(QueueBuilder.durable(q).maxLength(1).overflow(QueueBuilder.Overflow.rejectPublish).build());admin.purgeQueue(q);sender.sendJson("E-full-1","",q,"{}");assertThatThrownBy(()->sender.sendJson("E-full-2","",q,"{}")).isInstanceOf(org.springframework.amqp.AmqpException.class);}
 @Test void rawJsonIsNotDoubleEncodedAndStableMessageIdReachesTypedConsumer(){
  String q="verify.raw.q";admin.declareQueue(new org.springframework.amqp.core.Queue(q));sender.sendJson("E-raw","",q,"{\"eventId\":\"E-raw\",\"orderId\":\"O1\"}");var raw=receive(q);
  assertThat(raw.getMessageProperties().getMessageId()).isEqualTo("E-raw");assertThat(new String(raw.getBody(),UTF_8)).startsWith("{");raw.getMessageProperties().setInferredArgumentType(OrderCreatedEvent.class);
  assertThat(new OrderTopology().jsonMessageConverter().fromMessage(raw)).isEqualTo(new OrderCreatedEvent("E-raw","O1"));
 }
 @Test void unexpectedRejectParksAndDoesNotLoopThroughRetry(){
  topology();sender.sendMessage(OrderTopology.X,"order.created",message("E-reject"));
  rabbit.execute(channel->{var m=channel.basicGet(OrderTopology.MAIL,false);assertThat(m).isNotNull();channel.basicNack(m.getEnvelope().getDeliveryTag(),false,false);return null;});
  assertThat(receive(OrderTopology.PARKING).getMessageProperties().getMessageId()).isEqualTo("E-reject");assertThat(admin.getQueueInfo("order.retry.5s.q").getMessageCount()).isZero();
 }
 @Test void retryReturnsOnlyToMailQueue(){
  topology();String other="verify.warehouse.q";var q=new org.springframework.amqp.core.Queue(other);admin.declareQueue(q);admin.declareBinding(BindingBuilder.bind(q).to(new TopicExchange(OrderTopology.X)).with("order.created.#"));
  try{sender.sendMessage(OrderTopology.X,"order.created",message("E-isolate"));receive(other);var raw=receive(OrderTopology.MAIL);new RabbitRetryRouter(sender).forward(raw,new IllegalStateException("temporary"));
   assertThat(receive(OrderTopology.MAIL).getMessageProperties().getMessageId()).isEqualTo("E-isolate");assertThat(admin.getQueueInfo(other).getMessageCount()).isZero();
  }finally{admin.deleteQueue(other);}
 }
 @Test void initialAttemptPlusThreeRetriesThenParking(){
  topology();var mail=mock(MailDeliveryService.class);doThrow(new IllegalStateException("temporary")).when(mail).sendOnce(any());var consumer=new ConfirmMailConsumer(mail,new RabbitRetryRouter(sender));var event=new OrderCreatedEvent("E-limit","O1");
  sender.sendMessage(OrderTopology.X,"order.created",message("E-limit"));for(int i=0;i<4;i++){Message raw=receive(OrderTopology.MAIL);Object count=raw.getMessageProperties().getHeaders().get(RabbitRetryRouter.RETRY_COUNT);assertThat(count==null?0:((Number)count).intValue()).isEqualTo(i);consumer.onOrderCreated(event,raw);}
  assertThat(receive(OrderTopology.PARKING).getMessageProperties().getMessageId()).isEqualTo("E-limit");verify(mail,times(4)).sendOnce(event);assertThat(admin.getQueueInfo(OrderTopology.MAIL).getMessageCount()).isZero();
 }
 @Test void invalidInputParksWithoutCallingProvider(){topology();var mail=mock(MailDeliveryService.class);new ConfirmMailConsumer(mail,new RabbitRetryRouter(sender)).onOrderCreated(new OrderCreatedEvent("wrong-id","O1"),message("actual-id"));assertThat(receive(OrderTopology.PARKING).getMessageProperties().getMessageId()).isEqualTo("actual-id");verifyNoInteractions(mail);}
 @Test void invalidRetryHeaderCannotResetLimit(){topology();Message raw=message("bad-header");raw.getMessageProperties().setHeader(RabbitRetryRouter.RETRY_COUNT,"0");new RabbitRetryRouter(sender).forward(raw,new IllegalStateException());assertThat(receive(OrderTopology.PARKING).getMessageProperties().getMessageId()).isEqualTo("bad-header");}
 @Test void unroutableRetryPropagatesAndContainerParksOriginal(){
  topology();admin.removeBinding(new OrderTopology().retry5sBinding());var mail=mock(MailDeliveryService.class);doThrow(new IllegalStateException("temporary")).when(mail).sendOnce(any());var consumer=new ConfirmMailConsumer(mail,new RabbitRetryRouter(sender));
  var c=new SimpleMessageListenerContainer(cf);c.setQueueNames(OrderTopology.MAIL);c.setDefaultRequeueRejected(false);c.setMessageListener((MessageListener)raw->consumer.onOrderCreated(new OrderCreatedEvent("E-forward-fail","O1"),raw));c.start();
  try{sender.sendMessage(OrderTopology.X,"order.created",message("E-forward-fail"));assertThat(receive(OrderTopology.PARKING).getMessageProperties().getMessageId()).isEqualTo("E-forward-fail");assertThat(admin.getQueueInfo("order.retry.5s.q").getMessageCount()).isZero();}finally{c.stop();admin.declareBinding(new OrderTopology().retry5sBinding());}
 }
 @Test void retryPreservesIdentityTraceAndDropsPerMessageExpiration(){topology();var raw=message("trace");raw.getMessageProperties().setHeader("X-Trace-Id","same-trace");raw.getMessageProperties().setExpiration("1");new RabbitRetryRouter(sender).forward(raw,new IllegalStateException());var returned=receive(OrderTopology.MAIL);assertThat(returned.getMessageProperties().getMessageId()).isEqualTo("trace");assertThat(returned.getMessageProperties().getHeader("X-Trace-Id").toString()).isEqualTo("same-trace");}
 void bridgeQueue(String q){admin.declareExchange(new DirectExchange("verify.bridge.dlx"));admin.declareQueue(new org.springframework.amqp.core.Queue("verify.bridge.parking"));admin.declareBinding(BindingBuilder.bind(new org.springframework.amqp.core.Queue("verify.bridge.parking")).to(new DirectExchange("verify.bridge.dlx")).with("park"));admin.purgeQueue("verify.bridge.parking");admin.declareQueue(QueueBuilder.durable(q).quorum().deadLetterExchange("verify.bridge.dlx").deadLetterRoutingKey("park").withArgument("x-dead-letter-strategy","at-least-once").overflow(QueueBuilder.Overflow.rejectPublish).build());}
 @Test void bridgeWaitsForTargetAndPreservesOriginalOnFutureFailure()throws Exception{
  String q="verify.bridge.q";bridgeQueue(q);KafkaTemplate<Object,Object> kafka=mock(KafkaTemplate.class);var pending=new CompletableFuture<SendResult<Object,Object>>();var called=new CountDownLatch(1);
  when(kafka.send(any(ProducerRecord.class))).thenAnswer(inv->{called.countDown();return pending;});var listener=new RabbitKafkaBridge(kafka);var container=new SimpleMessageListenerContainer(cf);container.setQueueNames(q);container.setDefaultRequeueRejected(false);container.setMessageListener(listener);container.start();
  try{var p=new MessageProperties();p.setMessageId("E-bridge");sender.sendMessage("",q,new Message("O1:event".getBytes(UTF_8),p));assertThat(called.await(5,TimeUnit.SECONDS)).isTrue();assertThat(pending.isDone()).isFalse();pending.completeExceptionally(new IllegalStateException("Kafka unavailable"));assertThat(receive("verify.bridge.parking").getMessageProperties().getMessageId()).isEqualTo("E-bridge");}finally{container.stop();}
 }
 @Test void bridgeMethodCannotReturnBeforeTargetFutureCompletes()throws Exception{
  KafkaTemplate<Object,Object> kafka=mock(KafkaTemplate.class);var pending=new CompletableFuture<SendResult<Object,Object>>();var called=new CountDownLatch(1);var record=new AtomicReference<ProducerRecord<Object,Object>>();
  when(kafka.send(any(ProducerRecord.class))).thenAnswer(inv->{record.set(inv.getArgument(0));called.countDown();return pending;});var p=new MessageProperties();p.setMessageId("E-await");p.setHeader("X-Trace-Id","trace");var executor=Executors.newSingleThreadExecutor();
  try{Future<?> handled=executor.submit(()->new RabbitKafkaBridge(kafka).onMessage(new Message("O1:event".getBytes(UTF_8),p),null));assertThat(called.await(5,TimeUnit.SECONDS)).isTrue();assertThat(handled.isDone()).isFalse();assertThat(new String(record.get().headers().lastHeader("eventId").value(),UTF_8)).isEqualTo("E-await");pending.complete(new SendResult<>(record.get(),new RecordMetadata(new TopicPartition("order.bridge.v1",0),0,0,0,0,0)));handled.get(5,TimeUnit.SECONDS);}finally{executor.shutdownNow();}
 }
}
