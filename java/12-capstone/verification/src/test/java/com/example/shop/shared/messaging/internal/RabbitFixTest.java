package com.example.shop.shared.messaging.internal;
import org.junit.jupiter.api.*;import org.springframework.amqp.core.*;import org.springframework.amqp.rabbit.connection.*;import org.springframework.amqp.rabbit.core.*;import com.example.shop.shared.config.ShopProperties;import com.example.shop.shared.events.*;
import java.util.*;import java.time.Duration;import java.util.concurrent.TimeUnit;import static org.assertj.core.api.Assertions.*;import static org.awaitility.Awaitility.*;
class RabbitFixTest {
 static CachingConnectionFactory cf;static RabbitTemplate rabbit;static RabbitAdmin admin;
 @BeforeAll static void connect(){cf=new CachingConnectionFactory("127.0.0.1",Integer.getInteger("review.rabbit.port"));cf.setUsername("lab");cf.setPassword("lab");cf.setPublisherConfirmType(CachingConnectionFactory.ConfirmType.CORRELATED);cf.setPublisherReturns(true);rabbit=new RabbitTemplate(cf);rabbit.setMandatory(true);admin=new RabbitAdmin(cf);}
 @AfterAll static void close(){cf.destroy();}
 @Test void confirmedRetrySurvivesMissingReturnBindingAndRecovers()throws Exception{
  EventHandler handler=new EventHandler(){public String consumer(){return "review.worker";}public Set<String> eventTypes(){return Set.of("event");}public void handle(Event e){}};
  var delay=Duration.ofMillis(200);var m=new ShopProperties.Messaging(Duration.ofMillis(100),100,Duration.ofSeconds(5),Duration.ofSeconds(5),true,true,List.of(delay),Duration.ofDays(3),Duration.ofDays(7));
  var d=new RabbitTopology().shopTopology(List.of(handler),new ShopProperties(null,null,null,null,null,m));
  for(var x:d.getDeclarables())if(x instanceof Exchange e)admin.declareExchange(e);
  for(var x:d.getDeclarables())if(x instanceof org.springframework.amqp.core.Queue q)admin.declareQueue(q);
  Binding returnBinding=null;
  for(var x:d.getDeclarables())if(x instanceof Binding b){if(b.getExchange().equals(RabbitTopology.RETRY_RETURN))returnBinding=b;else admin.declareBinding(b);}
  var retry=RabbitTopology.retryQueue(delay);
  var q=d.getDeclarables().stream().filter(x->x instanceof org.springframework.amqp.core.Queue).map(x->(org.springframework.amqp.core.Queue)x).filter(x->x.getName().equals(retry)).findFirst().orElseThrow();
  assertThat(q.getArguments()).containsEntry("x-dead-letter-strategy","at-least-once").containsEntry("x-overflow","reject-publish");
  var p=new MessageProperties();p.setMessageId("safe-retry");p.setHeader(RabbitTopology.TARGET_HEADER,RabbitTopology.queue(handler));p.setDeliveryMode(MessageDeliveryMode.PERSISTENT);var cd=new CorrelationData(UUID.randomUUID().toString());rabbit.send(RabbitTopology.RETRY,RabbitTopology.tier(delay),new Message("safe".getBytes(),p),cd);assertThat(cd.getFuture().get(5,TimeUnit.SECONDS).isAck()).isTrue();assertThat(cd.getReturned()).isNull();Thread.sleep(1200);
  // The source's dead-letter worker holds the message internally; ready=0 alone cannot prove loss.
  assertThat(rabbit.receive(RabbitTopology.queue(handler))).isNull();
  admin.declareBinding(Objects.requireNonNull(returnBinding));
  await().atMost(Duration.ofSeconds(10)).untilAsserted(()->{Message received=rabbit.receive(RabbitTopology.queue(handler));assertThat(received).isNotNull();assertThat(received.getMessageProperties().getMessageId()).isEqualTo("safe-retry");});
 }
 @Test void rabbit313ExposesAckCounterWithQueueAndVhostLabels()throws Exception{
  String q="shop.review.metrics";admin.declareQueue(QueueBuilder.durable(q).quorum().build());
  rabbit.convertAndSend("",q,"probe");
  await().atMost(Duration.ofSeconds(5)).until(()->Boolean.TRUE.equals(rabbit.execute(channel->{var msg=channel.basicGet(q,false);if(msg==null)return false;channel.basicAck(msg.getEnvelope().getDeliveryTag(),false);return true;})));
  String endpoint="http://127.0.0.1:"+Integer.getInteger("review.rabbit.metrics.port")+"/metrics/detailed?family=queue_coarse_metrics&family=channel_queue_metrics";
  var http=java.net.http.HttpClient.newHttpClient();
  await().atMost(Duration.ofSeconds(15)).untilAsserted(()->{
   var response=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(endpoint)).build(),java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).isEqualTo(200);
   assertThat(response.body().lines().filter(l->l.startsWith("rabbitmq_detailed_channel_messages_acked_total{")&&l.contains("queue=\""+q+"\"")&&l.contains("vhost=\"/\"")).toList()).anySatisfy(l->assertThat(Double.parseDouble(l.substring(l.lastIndexOf(' ')+1))).isGreaterThanOrEqualTo(1));
  });
 }
}
