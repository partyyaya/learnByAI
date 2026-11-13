package com.example.shop.catalog.internal;

import com.example.shop.catalog.ProductStatus;
import com.example.shop.shared.redis.RedisGuard;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.data.redis.core.script.RedisScript;
import java.math.BigDecimal;
import java.time.Clock;
import java.util.Optional;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.mockito.Mockito.*;
import static org.assertj.core.api.Assertions.*;

class CacheFixTest {
 static ProductCache.Core core(int v){return new ProductCache.Core(1,2,"p","description",new BigDecimal(100+v),3,ProductStatus.ON_SALE,false,v);}
 static class Fixture {
  final StringRedisTemplate redis=mock(StringRedisTemplate.class);
  final RedisGuard guard=spy(new RedisGuard(Clock.systemUTC(),new SimpleMeterRegistry()));
  final AtomicReference<String> value=new AtomicReference<>();
  final AtomicBoolean failNext=new AtomicBoolean();
  final AtomicBoolean paused=new AtomicBoolean();
  Fixture(){
   // Disable only the background worker so the exact concurrent ordering is deterministic.
   doAnswer(inv->!paused.get() && !Thread.currentThread().getName().equals("product-cache-retry")).when(guard).available();
   ValueOperations<String,String> ops=mock(ValueOperations.class);when(redis.opsForValue()).thenReturn(ops);when(ops.get(anyString())).thenAnswer(inv->value.get());
   when(redis.execute(any(RedisScript.class),anyList(),any(Object[].class))).thenAnswer(inv->{
    if(failNext.getAndSet(false))throw new QueryTimeoutException("injected afterCommit write failure");
    value.set((String)inv.getArguments()[3]);return 1L;
   });
   when(redis.delete(anyString())).thenAnswer(inv->{value.set(null);return true;});
  }
  ProductCache cache(){return new ProductCache(redis,guard,new ObjectMapper());}
 }
 @Test void olderRepairCannotEraseNewerFailure()throws Exception{
  var f=new Fixture();var cache=f.cache();cache.put(core(1));f.failNext.set(true);cache.putAfterCommit(()->core(2));assertThat(cache.pendingEvictions()).isEqualTo(1);
  var deleted=new CountDownLatch(1);var allowReturn=new CountDownLatch(1);
  when(f.redis.delete(anyString())).thenAnswer(inv->{f.value.set(null);deleted.countDown();assertThat(allowReturn.await(5,TimeUnit.SECONDS)).isTrue();return true;});
  var pool=Executors.newSingleThreadExecutor();try{
   var eviction=pool.submit(cache::retryEvictions);assertThat(deleted.await(5,TimeUnit.SECONDS)).isTrue();
   assertThat(cache.get(1,id->Optional.of(core(2)))).contains(core(2));
   f.failNext.set(true);cache.putAfterCommit(()->core(3));
   allowReturn.countDown();eviction.get(5,TimeUnit.SECONDS);
   assertThat(cache.pendingEvictions()).isEqualTo(1);
   when(f.redis.delete(anyString())).thenAnswer(inv->{f.value.set(null);return true;});cache.retryEvictions();
   assertThat(cache.pendingEvictions()).isZero();assertThat(cache.get(1,id->Optional.of(core(3)))).contains(core(3));
  }finally{allowReturn.countDown();cache.close();pool.shutdownNow();}
 }
 @Test void waitersSeeOriginalException()throws Exception{
  var f=new Fixture();var c=f.cache();var started=new CountDownLatch(1);var finish=new CountDownLatch(1);var joined=new CountDownLatch(1);var pool=Executors.newFixedThreadPool(2);var error=new org.springframework.transaction.CannotCreateTransactionException("pool timeout");
  try {var loader=pool.submit(()->c.get(1,id->{started.countDown();try{finish.await(5,TimeUnit.SECONDS);}catch(InterruptedException e){throw new RuntimeException(e);}throw error;}));
   assertThat(started.await(3,TimeUnit.SECONDS)).isTrue();
   doAnswer(inv->{joined.countDown();return null;}).when(f.redis).delete("unused");
   var waiter=pool.submit(()->{joined.countDown();return c.get(1,id->{throw new AssertionError("must join");});});
   assertThat(joined.await(3,TimeUnit.SECONDS)).isTrue();Thread.sleep(50);finish.countDown();
   assertThatThrownBy(()->loader.get(3,TimeUnit.SECONDS)).hasCause(error);assertThatThrownBy(()->waiter.get(3,TimeUnit.SECONDS)).hasCause(error);
  }finally{finish.countDown();pool.shutdownNow();c.close();}
 }
 @Test void singleFlightLateMissChecksCacheAfterWinning()throws Exception{
  var f=new Fixture();var paused=new CountDownLatch(1);var resume=new CountDownLatch(1);var late=new AtomicReference<Thread>();var once=new AtomicBoolean();
  doAnswer(i->{Object result=i.callRealMethod();if(Thread.currentThread()==late.get()&&i.getArgument(0).equals("product-cache.get")&&once.compareAndSet(false,true)){paused.countDown();assertThat(resume.await(5,TimeUnit.SECONDS)).isTrue();}return result;}).when(f.guard).call(anyString(),any(java.util.function.Supplier.class));
  var c=f.cache();var loads=new AtomicInteger();java.util.function.LongFunction<Optional<ProductCache.Core>> loader=id->{loads.incrementAndGet();return Optional.of(core(1));};var pool=Executors.newSingleThreadExecutor();
  try{var slow=pool.submit(()->{late.set(Thread.currentThread());return c.get(1,loader);});assertThat(paused.await(3,TimeUnit.SECONDS)).isTrue();assertThat(c.get(1,loader)).contains(core(1));resume.countDown();assertThat(slow.get(3,TimeUnit.SECONDS)).contains(core(1));assertThat(loads).hasValue(1);}finally{resume.countDown();pool.shutdownNow();c.close();}
 }
}
