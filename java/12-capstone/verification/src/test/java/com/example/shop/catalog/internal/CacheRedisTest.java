package com.example.shop.catalog.internal;
import com.example.shop.shared.redis.RedisGuard;import com.fasterxml.jackson.databind.ObjectMapper;import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.*;import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;import org.springframework.data.redis.core.StringRedisTemplate;
import java.time.*;import java.util.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;
import static org.assertj.core.api.Assertions.*;import static org.mockito.Mockito.*;
class CacheRedisTest {
 static LettuceConnectionFactory cf;static StringRedisTemplate redis;
 @BeforeAll static void start(){cf=new LettuceConnectionFactory("127.0.0.1",Integer.getInteger("review.redis.port"));cf.afterPropertiesSet();cf.start();redis=new StringRedisTemplate(cf);}
 @AfterAll static void stop(){cf.destroy();}
 @BeforeEach void clear(){redis.delete(ProductCache.key(1));}
 RedisGuard guard(){var g=spy(new RedisGuard(Clock.systemUTC(),new SimpleMeterRegistry()));doAnswer(i->!Thread.currentThread().getName().equals("product-cache-retry")).when(g).available();return g;}
 @Test void restartCannotPreserveStaleValueBeyondOneSecond()throws Exception{
  var g=guard();var a=new ProductCache(redis,g,new ObjectMapper());a.put(CacheFixTest.core(1));assertThat(redis.getExpire(ProductCache.key(1),TimeUnit.MILLISECONDS)).isBetween(1L,1000L);
  doAnswer(i->{if(i.getArgument(0).equals("product-cache.put"))return false;return i.callRealMethod();}).when(g).run(anyString(),any(Runnable.class));
  a.putAfterCommit(()->CacheFixTest.core(2));assertThat(a.pendingEvictions()).isEqualTo(1);a.close(); // lose the in-memory repair marker
  var b=new ProductCache(redis,guard(),new ObjectMapper());try{Thread.sleep(1100);assertThat(b.get(1,id->Optional.of(CacheFixTest.core(2)))).contains(CacheFixTest.core(2));}finally{b.close();}
 }
 @Test void slowLoaderCannotRefillAfterItsFreshnessBudget()throws Exception{
  var c=new ProductCache(redis,guard(),new ObjectMapper());var pool=Executors.newSingleThreadExecutor();var began=new CountDownLatch(1);var finish=new CountDownLatch(1);
  try{var slow=pool.submit(()->c.get(1,id->{began.countDown();try{finish.await(5,TimeUnit.SECONDS);}catch(InterruptedException e){throw new RuntimeException(e);}return Optional.of(CacheFixTest.core(1));}));assertThat(began.await(3,TimeUnit.SECONDS)).isTrue();Thread.sleep(1100);
   assertThat(c.get(1,id->Optional.of(CacheFixTest.core(2)))).contains(CacheFixTest.core(2));redis.delete(ProductCache.key(1));finish.countDown();slow.get(3,TimeUnit.SECONDS);
   assertThat(redis.opsForValue().get(ProductCache.key(1))).isNull();assertThat(c.get(1,id->Optional.of(CacheFixTest.core(2)))).contains(CacheFixTest.core(2));
  }finally{finish.countDown();pool.shutdownNow();c.close();}
 }
 @Test void delayedAfterCommitCallbackCannotExtendOldSnapshotLifetime()throws Exception{
  var c=new ProductCache(redis,guard(),new ObjectMapper());try{
   org.springframework.transaction.support.TransactionSynchronizationManager.initSynchronization();
   c.putAfterCommit(()->CacheFixTest.core(1));var callbacks=org.springframework.transaction.support.TransactionSynchronizationManager.getSynchronizations();Thread.sleep(1100);callbacks.forEach(org.springframework.transaction.support.TransactionSynchronization::afterCommit);
   assertThat(redis.opsForValue().get(ProductCache.key(1))).isNull();
  }finally{org.springframework.transaction.support.TransactionSynchronizationManager.clearSynchronization();c.close();}
 }
}
