package com.example.lab11.messaging;

import com.example.lab11.events.OrderCreatedEvent;
import org.junit.jupiter.api.*;
import org.springframework.context.annotation.*;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.transaction.annotation.*;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.orm.jpa.*;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.data.redis.core.*;
import org.springframework.data.redis.RedisConnectionFailureException;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import javax.sql.DataSource;
import jakarta.persistence.EntityManagerFactory;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class DatabaseTest {
 @Configuration @EnableTransactionManagement @EnableJpaRepositories(basePackageClasses=OutboxRepository.class)
 @Import({DedupClaims.class,CreditWorker.class,CreditConsumer.class,MailDeliveryService.class,OutboxPump.class,OutboxOrderService.class})
 static class Config {
  @Bean DataSource dataSource(){return new DriverManagerDataSource(url()+"&useAffectedRows=true","lab","lab");}
  @Bean JdbcTemplate jdbc(DataSource ds){return new JdbcTemplate(ds);}
  @Bean LocalContainerEntityManagerFactoryBean entityManagerFactory(DataSource ds){
   var f=new LocalContainerEntityManagerFactoryBean();f.setDataSource(ds);f.setPackagesToScan("com.example.lab11.messaging");f.setJpaVendorAdapter(new HibernateJpaVendorAdapter());
   f.setJpaPropertyMap(Map.of("hibernate.hbm2ddl.auto","create-drop","hibernate.physical_naming_strategy","org.hibernate.boot.model.naming.CamelCaseToUnderscoresNamingStrategy"));return f;
  }
  @Bean PlatformTransactionManager transactionManager(EntityManagerFactory emf){return new JpaTransactionManager(emf);}
  @Bean com.fasterxml.jackson.databind.ObjectMapper json(){return new com.fasterxml.jackson.databind.ObjectMapper();}
  @Bean FakeGateway gateway(){return new FakeGateway();}
  @Bean ConfirmedRabbitSender sender(){return mock(ConfirmedRabbitSender.class);}
  @Bean OutboxMetrics metrics(){return new OutboxMetrics(new SimpleMeterRegistry());}
 }
 static class FakeGateway implements MailGateway {
  final Set<String> accepted=ConcurrentHashMap.newKeySet();
  final AtomicInteger calls=new AtomicInteger();boolean failBefore,loseResponse;
  public void sendConfirm(OrderCreatedEvent e,String key){
   calls.incrementAndGet();if(failBefore){failBefore=false;throw new IllegalStateException("offline before accept");}
   accepted.add(key);if(loseResponse){loseResponse=false;throw new IllegalStateException("accepted but response lost");}
  }
  void reset(){accepted.clear();calls.set(0);failBefore=false;loseResponse=false;}
 }
 static String url(){return "jdbc:mysql://127.0.0.1:"+Integer.getInteger("review.mysql.port")+"/lab11?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Taipei";}
 static AnnotationConfigApplicationContext context;static JdbcTemplate jdbc;static TransactionTemplate tx;
 static OutboxRepository outbox;static ConfirmedRabbitSender sender;
 @BeforeAll static void start(){
  context=new AnnotationConfigApplicationContext(Config.class);jdbc=context.getBean(JdbcTemplate.class);tx=new TransactionTemplate(context.getBean(PlatformTransactionManager.class));
  outbox=context.getBean(OutboxRepository.class);sender=context.getBean(ConfirmedRabbitSender.class);
  jdbc.execute("CREATE TABLE notification_job(event_id VARCHAR(64) NOT NULL,consumer VARCHAR(64) NOT NULL,status VARCHAR(16) NOT NULL,PRIMARY KEY(event_id,consumer)) ENGINE=InnoDB");
 }
 @AfterAll static void stop(){jdbc.execute("DROP TABLE notification_job");context.close();}
 @BeforeEach void reset(){
  jdbc.execute("DELETE FROM orders");jdbc.execute("DELETE FROM processed_message");jdbc.execute("DELETE FROM outbox");jdbc.execute("DELETE FROM account");jdbc.execute("DELETE FROM notification_job");
  jdbc.update("INSERT INTO account(id,balance) VALUES('alice',0)");context.getBean(FakeGateway.class).reset();org.mockito.Mockito.reset(sender);
 }
 long balance(){return jdbc.queryForObject("SELECT balance FROM account WHERE id='alice'",Long.class);}
 long claims(){return jdbc.queryForObject("SELECT COUNT(*) FROM processed_message",Long.class);}
 @Test void orderAndOutboxCommitTogetherWithEscapedJsonIdentity()throws Exception{
  String orderId="O\"-escaped";String id=context.getBean(OutboxOrderService.class).placeOrder(orderId);
  String payload=jdbc.queryForObject("SELECT payload FROM outbox WHERE id=?",String.class,id);
  assertThat(new com.fasterxml.jackson.databind.ObjectMapper().readValue(payload,OrderCreatedEvent.class)).isEqualTo(new OrderCreatedEvent(id,orderId));
  assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM orders",Long.class)).isEqualTo(1);
 }
 @Test void outerRollbackRemovesBothOrderAndOutbox(){tx.executeWithoutResult(s->{context.getBean(OutboxOrderService.class).placeOrder("rollback");s.setRollbackOnly();});assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM orders",Long.class)).isZero();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM outbox",Long.class)).isZero();}
 @Test void sequentialDuplicateDoesNotCreditTwice(){
  var c=context.getBean(CreditConsumer.class);assertThat(c.handle("E1")).isEqualTo("DONE");assertThat(c.handle("E1")).isEqualTo("SKIPPED");assertThat(balance()).isEqualTo(100);assertThat(claims()).isEqualTo(1);
 }
 @Test void concurrentDuplicateCreditsOnlyOnce()throws Exception{
  var executor=Executors.newFixedThreadPool(4);var gate=new CountDownLatch(1);var tasks=new ArrayList<Future<String>>();
  try{for(int i=0;i<4;i++)tasks.add(executor.submit(()->{gate.await();return context.getBean(CreditConsumer.class).handle("race");}));gate.countDown();
   var results=new ArrayList<String>();for(var t:tasks)results.add(t.get(10,TimeUnit.SECONDS));assertThat(results).containsExactlyInAnyOrder("DONE","SKIPPED","SKIPPED","SKIPPED");assertThat(balance()).isEqualTo(100);
  }finally{executor.shutdownNow();}
 }
 @Test void differentConsumersCanClaimSameEvent(){
  var c=context.getBean(DedupClaims.class);tx.executeWithoutResult(s->c.insert("same","mail"));tx.executeWithoutResult(s->c.insert("same","warehouse"));assertThat(claims()).isEqualTo(2);
 }
 @Test void businessIntegrityFailurePropagatesAndClaimRollsBackThenCanRetry(){
  jdbc.execute("CREATE TABLE allowed_balance(value BIGINT PRIMARY KEY)");jdbc.execute("INSERT INTO allowed_balance VALUES(0)");
  jdbc.execute("ALTER TABLE account ADD CONSTRAINT verification_balance_fk FOREIGN KEY(balance) REFERENCES allowed_balance(value)");
  try{assertThatThrownBy(()->context.getBean(CreditConsumer.class).handle("failed-business")).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);assertThat(claims()).isZero();assertThat(balance()).isZero();}
  finally{jdbc.execute("ALTER TABLE account DROP FOREIGN KEY verification_balance_fk");jdbc.execute("DROP TABLE allowed_balance");}
  assertThat(context.getBean(CreditConsumer.class).handle("failed-business")).isEqualTo("DONE");assertThat(balance()).isEqualTo(100);
 }
 @Test void invalidIdentityIsNotReportedAsDuplicate(){assertThatThrownBy(()->context.getBean(CreditConsumer.class).handle(null)).isInstanceOf(IllegalArgumentException.class);assertThat(claims()).isZero();}
 @Test void claimRequiresExistingTransaction(){assertThatThrownBy(()->context.getBean(DedupClaims.class).insert("id","consumer")).isInstanceOf(org.springframework.transaction.IllegalTransactionStateException.class);}
 @Test void upsertRowCountIsVerifiedWithBothDriverOptions(){
  var repo=context.getBean(ProcessedMessageRepository.class);assertThat(tx.<Integer>execute(s->repo.claim("upsert","credit")).intValue()).isEqualTo(1);assertThat(tx.<Integer>execute(s->repo.claim("upsert","credit")).intValue()).isZero();
  var defaultJdbc=new JdbcTemplate(new DriverManagerDataSource(url()+"&useAffectedRows=false","lab","lab"));
  assertThat(defaultJdbc.update("INSERT INTO processed_message(message_id,consumer,processed_at) VALUES('upsert','credit',NOW(6)) ON DUPLICATE KEY UPDATE message_id=message_id")).isEqualTo(1);
 }
 void seed(){tx.executeWithoutResult(s->outbox.saveAndFlush(new OutboxMessage("O1","Order","order1","order.created","{\"eventId\":\"O1\",\"orderId\":\"order1\"}")));}
 String status(){return jdbc.queryForObject("SELECT status FROM outbox WHERE id='O1'",String.class);}
 @Test void fifthFailureAndOnlyFifthFailureTurnsFailed(){
  seed();for(int i=1;i<=5;i++){tx.executeWithoutResult(s->outbox.markRetry("O1",Instant.now(),"failure"));assertThat(status()).isEqualTo(i==5?"FAILED":"PENDING");assertThat(jdbc.queryForObject("SELECT attempts FROM outbox WHERE id='O1'",Integer.class)).isEqualTo(i);}
 }
 @Test void pumpMarksSentAfterConfirmedSenderReturns(){seed();assertThat(context.getBean(OutboxPump.class).pumpOneBatch()).isEqualTo(1);assertThat(status()).isEqualTo("SENT");verify(sender).sendJson(eq("O1"),eq("order.x"),eq("order.created"),contains("eventId"));}
 @Test void pumpDoesNotOverwriteUnroutableWithSent(){seed();doThrow(new ConfirmedRabbitSender.UnroutableMessageException("NO_ROUTE")).when(sender).sendJson(any(),any(),any(),any());assertThat(context.getBean(OutboxPump.class).pumpOneBatch()).isZero();assertThat(status()).isEqualTo("UNROUTABLE");}
 @Test void pumpPreservesRetryableFailure(){seed();doThrow(new org.springframework.amqp.AmqpException("offline")).when(sender).sendJson(any(),any(),any(),any());assertThat(context.getBean(OutboxPump.class).pumpOneBatch()).isZero();assertThat(status()).isEqualTo("PENDING");assertThat(jdbc.queryForObject("SELECT attempts FROM outbox",Integer.class)).isEqualTo(1);}
 @Test void mailFailureDoesNotLeaveDoneClaim(){
  var g=context.getBean(FakeGateway.class);g.failBefore=true;var mail=context.getBean(MailDeliveryService.class);var e=new OrderCreatedEvent("mail-before","order1");
  assertThatThrownBy(()->mail.sendOnce(e)).isInstanceOf(IllegalStateException.class);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notification_job",Long.class)).isZero();
  mail.sendOnce(e);mail.sendOnce(e);assertThat(g.calls.get()).isEqualTo(2);assertThat(g.accepted).hasSize(1);assertThat(jdbc.queryForObject("SELECT status FROM notification_job",String.class)).isEqualTo("DONE");
 }
 @Test void mailAcceptedButResponseLostUsesSameProviderIdempotencyKey(){
  var g=context.getBean(FakeGateway.class);g.loseResponse=true;var mail=context.getBean(MailDeliveryService.class);var e=new OrderCreatedEvent("mail-response","order1");
  assertThatThrownBy(()->mail.sendOnce(e)).isInstanceOf(IllegalStateException.class);mail.sendOnce(e);assertThat(g.calls.get()).isEqualTo(2);assertThat(g.accepted).containsExactly("confirm-mail:mail-response");assertThat(jdbc.queryForObject("SELECT status FROM notification_job",String.class)).isEqualTo("DONE");
 }
 @Test void redisReadAndWriteFailureFallBackToDatabase(){
  var redis=mock(StringRedisTemplate.class);ValueOperations<String,String> values=mock(ValueOperations.class);
  when(redis.hasKey(anyString())).thenThrow(new RedisConnectionFailureException("offline"));when(redis.opsForValue()).thenReturn(values);doThrow(new RedisConnectionFailureException("offline")).when(values).set(anyString(),anyString(),any(java.time.Duration.class));
  var facade=new CachedCreditConsumer(context.getBean(CreditWorker.class),redis);assertThat(facade.handle("cache")).isEqualTo("DONE");assertThat(facade.handle("cache")).isEqualTo("SKIPPED");assertThat(balance()).isEqualTo(100);
 }
 @Test void redisFacadeDoesNotSwallowBusinessException(){var redis=mock(StringRedisTemplate.class);assertThatThrownBy(()->new CachedCreditConsumer(context.getBean(CreditWorker.class),redis).handle(null)).isInstanceOf(IllegalArgumentException.class);verify(redis,never()).opsForValue();}
}
