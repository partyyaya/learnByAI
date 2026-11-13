package review;

import com.example.lab10.shop.idempotency.*;
import com.example.lab10.shop.idempotency.DurableIdempotency.Reply;
import com.example.lab10.shop.config.RedisScriptConfig;
import org.junit.jupiter.api.*;
import org.springframework.data.redis.core.*;
import org.springframework.data.redis.core.script.*;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.RedisSystemException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.core.io.ClassPathResource;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.assertj.core.api.Assertions.*;

class RedisBehaviorTest {
 static LettuceConnectionFactory factory;static StringRedisTemplate redis;
 JdbcTemplate jdbc;DurableIdempotency durable;IdempotencyService idem;
 static final String SCOPE=IdempotencyService.scope("shop","alice","orders");
 static final String FP=IdempotencyService.fingerprint("product=1;qty=1");
 @BeforeAll static void connect(){factory=new LettuceConnectionFactory("127.0.0.1",Integer.getInteger("review.redis.port",33420));factory.afterPropertiesSet();factory.start();redis=new StringRedisTemplate(factory);}
 @AfterAll static void close(){factory.destroy();}
 @BeforeEach void reset()throws Exception{
  try(var c=factory.getConnection()){c.serverCommands().flushDb();}
  var ds=new DriverManagerDataSource("jdbc:h2:mem:request;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=5000","sa","");
  jdbc=new JdbcTemplate(ds);jdbc.execute(new ClassPathResource("schema.sql").getContentAsString(StandardCharsets.UTF_8));
  jdbc.execute("CREATE TABLE IF NOT EXISTS orders(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY)");
  jdbc.update("DELETE FROM orders");jdbc.update("DELETE FROM business_request");
  durable=new DurableIdempotency(jdbc,new DataSourceTransactionManager(ds));idem=new IdempotencyService(redis,durable);
 }
 Reply create(){jdbc.update("INSERT INTO orders DEFAULT VALUES");return new Reply(201,"{\"orderId\":1}");}
 String redisKey(String scope,String key){return "idem:"+scope+":"+IdempotencyService.fingerprint(key);}
 long orderCount(){return jdbc.queryForObject("SELECT COUNT(*) FROM orders",Long.class);}
 static void await(CountDownLatch l){try{if(!l.await(5,TimeUnit.SECONDS))throw new AssertionError("latch timeout");}catch(InterruptedException e){Thread.currentThread().interrupt();throw new AssertionError(e);}}
 static class FailFinishTemplate extends StringRedisTemplate {
  boolean fail=true;FailFinishTemplate(){super(factory);}
  @Override public <T>T execute(RedisScript<T> script,List<String> keys,Object... args){
   if(fail && script.getScriptAsString().contains("-- scripts/idempotency-finish.lua")){
    fail=false;throw new RedisSystemException("injected DONE publish failure",new RuntimeException());
   }
   return super.execute(script,keys,args);
  }
 }
 @Test void donePublishFailureNeverReexecutesCommittedOrder(){
  var service=new IdempotencyService(new FailFinishTemplate(),durable);
  assertThat(service.execute(SCOPE,"commit",FP,this::create).status()).isEqualTo(201);
  assertThat(redis.opsForHash().get(redisKey(SCOPE,"commit"),"state")).isEqualTo("IN_PROGRESS");
  redis.delete(redisKey(SCOPE,"commit")); // simulate lease expiry; persistent DB record remains
  assertThat(service.execute(SCOPE,"commit",FP,this::create).body()).contains("orderId");
  assertThat(orderCount()).isEqualTo(1);
 }
 @Test void processCrashGapIsRecoveredFromDatabase(){
  Reply committed=durable.execute(SCOPE,"crash",FP,this::create); // process dies before Redis DONE
  assertThat(idem.execute(SCOPE,"crash",FP,this::create)).isEqualTo(committed);
  assertThat(orderCount()).isEqualTo(1);
 }
 @Test void staleOwnerCannotCompleteNewOwnersLease(){
  var begin=RedisScript.of(new ClassPathResource("scripts/idempotency-begin.lua"),List.class);
  var finish=RedisScript.of(new ClassPathResource("scripts/idempotency-finish.lua"),Long.class);
  String k=redisKey(SCOPE,"owners");
  redis.execute(begin,List.of(k),FP,"30000","A");redis.delete(k);
  redis.execute(begin,List.of(k),FP,"30000","B");
  assertThat(redis.execute(finish,List.of(k),"A","201","old","86400000")).isZero();
  assertThat(redis.opsForHash().get(k,"owner")).isEqualTo("B");
  assertThat(redis.opsForHash().get(k,"state")).isEqualTo("IN_PROGRESS");
  assertThat(redis.execute(finish,List.of(k),"B","201","new","86400000")).isEqualTo(1);
  assertThat(redis.getExpire(k)).isPositive();
 }
 @Test void actorAndOperationScopesDoNotShareResponses(){
  String bob=IdempotencyService.scope("shop","bob","orders");String cancel=IdempotencyService.scope("shop","alice","cancel");
  assertThat(idem.execute(SCOPE,"same-key",FP,()->new Reply(201,"alice"))).isEqualTo(new Reply(201,"alice"));
  assertThat(idem.execute(bob,"same-key",FP,()->new Reply(201,"bob"))).isEqualTo(new Reply(201,"bob"));
  assertThat(idem.execute(cancel,"same-key",FP,()->new Reply(200,"cancel"))).isEqualTo(new Reply(200,"cancel"));
 }
 @Test void rollbackRemovesBusinessAndDurableClaimTogether(){
  assertThatThrownBy(()->idem.execute(SCOPE,"rollback",FP,()->{create();throw new IllegalStateException("rollback");})).isInstanceOf(IllegalStateException.class);
  assertThat(orderCount()).isZero();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM business_request",Long.class)).isZero();
  assertThat(redis.hasKey(redisKey(SCOPE,"rollback"))).isTrue();
  redis.delete(redisKey(SCOPE,"rollback"));idem.execute(SCOPE,"rollback",FP,this::create);assertThat(orderCount()).isEqualTo(1);
 }
 @Test void durableMismatchSurvivesRedisExpiry(){
  idem.execute(SCOPE,"mismatch",FP,this::create);redis.delete(redisKey(SCOPE,"mismatch"));
  assertThatThrownBy(()->idem.execute(SCOPE,"mismatch",IdempotencyService.fingerprint("different"),this::create)).isInstanceOf(DurableIdempotency.FingerprintMismatchException.class);
  assertThat(orderCount()).isEqualTo(1);
 }
 @Test void concurrentDatabaseClaimsCommitOneBusiness()throws Exception{
  var start=new CountDownLatch(1);var pool=Executors.newFixedThreadPool(8);
  try{
   var futures=new ArrayList<Future<Reply>>();
   for(int i=0;i<8;i++)futures.add(pool.submit(()->{await(start);return durable.execute(SCOPE,"concurrent",FP,this::create);}));
   start.countDown();for(var f:futures)assertThat(f.get(10,TimeUnit.SECONDS).status()).isEqualTo(201);
   assertThat(orderCount()).isEqualTo(1);
  }finally{pool.shutdownNow();}
 }
 @Test void terminalRejectionReplaysStatusAndBody(){
  var count=new AtomicInteger();
  Reply reply=idem.execute(SCOPE,"sold-out",FP,()->{count.incrementAndGet();return new Reply(409,"sold_out");});
  assertThat(idem.execute(SCOPE,"sold-out",FP,()->{count.incrementAndGet();return new Reply(201,"bad");})).isEqualTo(reply);
  assertThat(count.get()).isEqualTo(1);
 }
 @Test void scriptAndJavaAgreeOnAllStockResults(){
  var client=new StockClientProbe(redis,new RedisScriptConfig().deductStockScript());
  assertThat(client.deduct(1L,1).result()).isEqualTo(StockClientProbe.Result.NOT_LOADED);
  redis.opsForValue().set("stock:1","5");
  assertThat(client.deduct(1L,2)).isEqualTo(new StockClientProbe.Deduction(StockClientProbe.Result.OK,3));
  assertThat(client.deduct(1L,4)).isEqualTo(new StockClientProbe.Deduction(StockClientProbe.Result.SOLD_OUT,3));
 }
 @Test void stockRejectsNonpositiveAndNonintegralQuantitiesBeforeMutation(){
  var script=new RedisScriptConfig().deductStockScript();var client=new StockClientProbe(redis,script);redis.opsForValue().set("stock:1","5");
  for(int n:new int[]{0,-2})assertThatThrownBy(()->client.deduct(1L,n)).isInstanceOf(IllegalArgumentException.class);
  for(String n:List.of("0","-2","1.5","wat"))assertThatThrownBy(()->redis.execute(script,List.of("stock:1"),n)).hasRootCauseMessage("quantity must be a positive int");
  assertThat(redis.opsForValue().get("stock:1")).isEqualTo("5");
 }
 @Test void tokenBucketDoesNotMoveStoredClockBackwards(){
  String key="rl:tb:test";long future=System.currentTimeMillis()+60000;
  redis.opsForHash().putAll(key,Map.of("tokens","0","ts",Long.toString(future)));
  var script=RedisScript.of(new ClassPathResource("scripts/rate-token-bucket.lua"),List.class);
  for(int i=0;i<20;i++)assertThat(redis.execute(script,List.of(key),"1","1","1").get(0)).isEqualTo(0L);
  assertThat(redis.opsForHash().get(key,"ts")).isEqualTo(Long.toString(future));
  redis.delete(key);assertThat(redis.execute(script,List.of(key),"1","1","1").get(0)).isEqualTo(1L);
  assertThat(redis.execute(script,List.of(key),"1","1","1").get(0)).isEqualTo(0L);
 }
 @Test void fencingIsGrantedAtomicallyAndRejectsExpiredOwner()throws Exception{
  var script=RedisScript.of(new ClassPathResource("scripts/fenced-lock-acquire.lua"),List.class);
  var keys=List.of("lock:{p1}","fence:{p1}");
  List<?> a=redis.execute(script,keys,"A","20");Thread.sleep(40);
  List<?> b=redis.execute(script,keys,"B","10000");
  assertThat(Long.parseLong((String)b.get(1))).isGreaterThan(Long.parseLong((String)a.get(1)));
  assertThat(redis.execute(script,keys,"C","10000")).isEmpty();
  var release=RedisScript.of(new ClassPathResource("scripts/release-lock.lua"),Long.class);
  assertThat(redis.execute(release,List.of(keys.get(0)),"A")).isZero();
  assertThat(redis.opsForValue().get(keys.get(0))).isEqualTo("B");
  var store=new FencedStoreProbe();store.write("p1",2,Long.parseLong((String)b.get(1)));store.write("p1",1,Long.parseLong((String)a.get(1)));
  assertThat(store.value.get("p1")).isEqualTo(2);assertThat(store.rejected.get()).isEqualTo(1);
 }
}
