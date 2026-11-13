package review;

import com.example.lab10.shop.idempotency.*;
import com.example.lab10.shop.config.RedisScriptConfig;
import org.junit.jupiter.api.*;
import org.springframework.cache.Cache;
import org.springframework.cache.concurrent.ConcurrentMapCache;
import org.springframework.cache.transaction.TransactionAwareCacheDecorator;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.core.io.ClassPathResource;
import org.springframework.transaction.support.*;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class ConsistencyTest {
 static LettuceConnectionFactory factory;static StringRedisTemplate redis;
 JdbcTemplate jdbc;IdempotencyService idem;
 @BeforeAll static void connect(){factory=new LettuceConnectionFactory("127.0.0.1",Integer.getInteger("review.redis.port",33420));factory.afterPropertiesSet();factory.start();redis=new StringRedisTemplate(factory);}
 @AfterAll static void close(){factory.destroy();}
 @BeforeEach void reset()throws Exception{
  try(var c=factory.getConnection()){c.serverCommands().flushDb();}
  var ds=new DriverManagerDataSource("jdbc:h2:mem:stock;DB_CLOSE_DELAY=-1","sa","");jdbc=new JdbcTemplate(ds);
  jdbc.execute(new ClassPathResource("schema.sql").getContentAsString(StandardCharsets.UTF_8));jdbc.update("DELETE FROM business_request");
  jdbc.execute("CREATE TABLE IF NOT EXISTS orders(id BIGINT PRIMARY KEY)");jdbc.update("DELETE FROM orders");
  idem=new IdempotencyService(redis,new DurableIdempotency(jdbc,new DataSourceTransactionManager(ds)));
 }
 @Test void rollbackNeverPublishesValueToEitherCacheLayer(){
  var ds=new DriverManagerDataSource("jdbc:h2:mem:l1;DB_CLOSE_DELAY=-1","sa","");var sql=new JdbcTemplate(ds);
  sql.execute("CREATE TABLE product(id INT PRIMARY KEY,name VARCHAR(30))");sql.update("INSERT INTO product VALUES(1,'old')");
  Cache remote=spy(new ConcurrentMapCache("products"));
  Cache cache=CacheAssembly.assemble(remote,new CacheCircuitBreaker(5,5000),Caffeine.newBuilder().build());
  var tx=new TransactionTemplate(new DataSourceTransactionManager(ds));
  assertThatThrownBy(()->tx.executeWithoutResult(s->{sql.update("UPDATE product SET name='uncommitted' WHERE id=1");cache.put(1,"uncommitted");throw new IllegalStateException("rollback");})).isInstanceOf(IllegalStateException.class);
  assertThat(sql.queryForObject("SELECT name FROM product",String.class)).isEqualTo("old");assertThat(remote.get(1)).isNull();
  doThrow(new RedisConnectionFailureException("offline")).when(remote).get(1);
  assertThatThrownBy(()->cache.get(1)).isInstanceOf(RedisConnectionFailureException.class);
  tx.executeWithoutResult(s->cache.put(2,"committed"));
  doThrow(new RedisConnectionFailureException("offline")).when(remote).get(2);
  assertThat(cache.get(2).get()).isEqualTo("committed");
 }
 @Test void reconciliationDoesNotReplenishInFlightReservation(){
  var db=new AtomicInteger(100);redis.opsForValue().set("stock:1","99");
  var task=new ReconcileProbe(id->db.get(),id->Long.parseLong(redis.opsForValue().get("stock:1")));
  task.reconcile();db.decrementAndGet();
  assertThat(redis.opsForValue().get("stock:1")).isEqualTo("99");assertThat(db.get()).isEqualTo(99);
 }
 @Test void concurrentObserversCannotDoubleCompensate()throws Exception{
  redis.opsForValue().set("stock:1","99");var barrier=new CyclicBarrier(2);
  var task=new ReconcileProbe(id->100,id->{try{barrier.await(5,TimeUnit.SECONDS);}catch(Exception e){throw new RuntimeException(e);}return Long.parseLong(redis.opsForValue().get("stock:1"));});
  var pool=Executors.newFixedThreadPool(2);
  try{var a=pool.submit(task::reconcile);var b=pool.submit(task::reconcile);a.get(5,TimeUnit.SECONDS);b.get(5,TimeUnit.SECONDS);assertThat(redis.opsForValue().get("stock:1")).isEqualTo("99");}
  finally{pool.shutdownNow();}
 }
 @Test void halfOpenAllowsOneProbeAndIgnoresOldCompletions()throws Exception{
  var breaker=new CacheCircuitBreaker(1,0);var failed=breaker.tryAcquire();var old=breaker.tryAcquire();breaker.onFailure(failed);
  var start=new CountDownLatch(1);var pool=Executors.newFixedThreadPool(16);var accepted=new ArrayList<CacheCircuitBreaker.Permit>();
  try{
   var futures=new ArrayList<Future<CacheCircuitBreaker.Permit>>();
   for(int i=0;i<32;i++)futures.add(pool.submit(()->{RedisBehaviorTest.await(start);return breaker.tryAcquire();}));
   start.countDown();for(var f:futures){var p=f.get(5,TimeUnit.SECONDS);if(p!=null)accepted.add(p);}
   assertThat(accepted).hasSize(1);assertThat(breaker.state()).isEqualTo(CacheCircuitBreaker.State.HALF_OPEN);
   breaker.onSuccess(old);assertThat(breaker.state()).isEqualTo(CacheCircuitBreaker.State.HALF_OPEN);
   breaker.onSuccess(accepted.get(0));assertThat(breaker.state()).isEqualTo(CacheCircuitBreaker.State.CLOSED);
   breaker.onFailure(old);assertThat(breaker.state()).isEqualTo(CacheCircuitBreaker.State.CLOSED);
  }finally{pool.shutdownNow();}
 }
 class Stock implements SeckillProbe.RedisStock {
  final AtomicInteger givebacks=new AtomicInteger();boolean fail;
  final StockClientProbe client=new StockClientProbe(redis,new RedisScriptConfig().deductStockScript());
  public StockClientProbe.Deduction deduct(Long id,int n){return client.deduct(id,n);}
  public void giveBack(Long id,int n){givebacks.incrementAndGet();if(fail)throw new IllegalStateException("compensation failed");redis.opsForValue().increment("stock:"+id,n);}
 }
 @Test void databaseSoldOutIsCommittedWithoutGivebackAndReplayed(){
  redis.opsForValue().set("stock:1","5");var stock=new Stock();var service=new SeckillProbe(idem,stock,(id,user)->null);
  var reply=service.seckill(1L,"alice","sold-out");assertThat(reply.status()).isEqualTo(409);
  assertThat(stock.givebacks.get()).isZero();assertThat(redis.opsForValue().get("stock:1")).isEqualTo("4");
  assertThat(service.seckill(1L,"alice","sold-out")).isEqualTo(reply);
  assertThat(redis.opsForValue().get("stock:1")).isEqualTo("4");
 }
 @Test void confirmedRollbackCompensatesOnceAndRollsBackDurableResult(){
  redis.opsForValue().set("stock:1","5");var stock=new Stock();
  var service=new SeckillProbe(idem,stock,(id,user)->{jdbc.update("INSERT INTO orders VALUES(1)");throw new IllegalStateException("business failed");});
  assertThatThrownBy(()->service.seckill(1L,"alice","failed")).isInstanceOf(IllegalStateException.class).hasMessage("business failed");
  assertThat(stock.givebacks.get()).isEqualTo(1);assertThat(redis.opsForValue().get("stock:1")).isEqualTo("5");
  assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM orders",Long.class)).isZero();
  assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM business_request",Long.class)).isZero();
 }
 @Test void compensationFailurePreservesOriginalBusinessException(){
  redis.opsForValue().set("stock:1","5");var stock=new Stock();stock.fail=true;
  var service=new SeckillProbe(idem,stock,(id,user)->{throw new IllegalArgumentException("original failure");});
  assertThatThrownBy(()->service.seckill(1L,"alice","failed-compensation")).isInstanceOf(IllegalArgumentException.class).hasMessage("original failure");
  assertThat(stock.givebacks.get()).isEqualTo(1);
 }
 @Test void unknownCompletionDoesNotBlindlyCompensate()throws Exception{
  var stock=new Stock();var service=new SeckillProbe(idem,stock,(id,user)->null);
  var method=SeckillProbe.class.getDeclaredMethod("compensateOnRollback",Long.class,int.class);method.setAccessible(true);
  TransactionSynchronizationManager.initSynchronization();
  try{
   method.invoke(service,1L,1);
   for(var sync:TransactionSynchronizationManager.getSynchronizations())sync.afterCompletion(TransactionSynchronization.STATUS_UNKNOWN);
   assertThat(stock.givebacks.get()).isZero();
  }finally{TransactionSynchronizationManager.clearSynchronization();}
 }
}
