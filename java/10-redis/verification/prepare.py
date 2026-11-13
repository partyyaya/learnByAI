#!/usr/bin/env python3
"""Extract production examples from current Markdown; fixtures only fill missing context."""
from pathlib import Path
import json,re,shutil
root=Path(__file__).resolve().parent
course=root.parent
generated=root/'target/generated-sources/course'
resources=root/'target/generated-resources'
if generated.exists():shutil.rmtree(generated)
if resources.exists():shutil.rmtree(resources)
generated.mkdir(parents=True);resources.mkdir(parents=True)
blocks=[]
for p in sorted(course.glob('*.md')):
 text=p.read_text()
 for m in re.finditer(r'^```([^\n]*)\n(.*?)^```\s*$',text,re.M|re.S):
  blocks.append(dict(file=p.name,line=text.count('\n',0,m.start())+1,lang=m[1].strip(),source=m[2]))
def get(ch,needle,lang='java'):
 matches=[b for b in blocks if b['file'].startswith(ch) and b['lang']==lang and needle in b['source']]
 if len(matches)!=1:raise ValueError((ch,needle,len(matches)))
 return matches[0]['source']
def write_java(source,imports='',package='review'):
 match=re.search(r'^package ([\w.]+);',source,re.M)
 if match:package=match[1]
 else:source='package '+package+';\n'+source
 source=source.replace('package '+package+';','package '+package+';\n'+imports,1)
 name=re.search(r'public (?:final |abstract )?(?:class|interface|record) (\w+)',source)[1]
 path=generated/package.replace('.','/')/(name+'.java');path.parent.mkdir(parents=True,exist_ok=True);path.write_text(source)
write_java(get('06','m.activateDefaultTyping(ptv,'))
write_java(get('07','public class FailSoftRedisCacheManager'),'''import org.springframework.data.redis.cache.*;
import org.springframework.data.redis.serializer.SerializationException;
import java.util.Map;''',package='com.example.lab10.shop.config')
write_java(get('07','public class CacheConfig'),'''import org.springframework.context.annotation.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.cache.CacheManager;
import org.springframework.data.redis.cache.*;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.serializer.*;
import org.springframework.data.redis.serializer.RedisSerializationContext.SerializationPair;
import java.util.*;import java.util.concurrent.ThreadLocalRandom;import java.time.Duration;''',package='com.example.lab10.shop.config')
for name in ('DurableIdempotency','IdempotencyService'):
 write_java(get('10','public class '+name+' {'))
write_java(get('08','public class CacheCircuitBreaker'))
write_java(get('13','public class RedisHaConfig'),'''import org.springframework.context.annotation.*;
import org.springframework.boot.autoconfigure.data.redis.*;
import io.lettuce.core.*;
import io.lettuce.core.resource.*;
import io.lettuce.core.ClientOptions.DisconnectedBehavior;
import java.util.concurrent.TimeUnit;import java.time.Duration;''',package='com.example.lab10.shop.config')
write_java(get('14','public class MetricsConfig'),'''import org.springframework.context.annotation.*;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.boot.autoconfigure.data.redis.ClientResourcesBuilderCustomizer;
import io.lettuce.core.metrics.*;
import io.micrometer.core.instrument.MeterRegistry;''',package='com.example.lab10.shop.config')
write_java(get('12','public class RedisScriptConfig'),'''import org.springframework.context.annotation.*;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.redis.core.script.RedisScript;
import java.util.List;''',package='com.example.lab10.shop.config')
# TwoLevelCache is a teaching fragment. Fill constructor, NULL sentinel and Cache overloads.
local=get('08','public class TwoLevelCache')
local=local.replace('    private final Cache redis;', '''    private static final Object NULL = new Object();
    private final java.util.concurrent.atomic.AtomicLong localHits = new java.util.concurrent.atomic.AtomicLong();
    public TwoLevelCache(Cache redis,com.github.benmanes.caffeine.cache.Cache<Object,Object> local){this.redis=redis;this.local=local;}
    @Override public String getName(){return redis.getName();}
    @Override public Object getNativeCache(){return redis.getNativeCache();}
    @Override public <T>T get(Object k,Class<T> t){ValueWrapper w=get(k);return w==null?null:t.cast(w.get());}
    @Override public <T>T get(Object k,java.util.concurrent.Callable<T> loader){
        ValueWrapper w=get(k);if(w!=null)return (T)w.get();
        try{T v=loader.call();put(k,v);return v;}catch(Exception e){throw new ValueRetrievalException(k,loader,e);}
    }
    private final Cache redis;''')
write_java(local,'import org.springframework.cache.Cache;import org.springframework.cache.support.SimpleValueWrapper;')
# Compile the typed serializer recipe and actual decorator assembly from the course.
recipe=get('07','ObjectMapper typedMapper = redisJson.mapper().copy().deactivateDefaultTyping()')
recipe=recipe.replace('Map.of(', 'return Map.of(', 1).rstrip()+';'
write_java('''public class TypedCacheRecipe {
public static class Product {
 private long id;public Product(){}public Product(long id){this.id=id;}public long getId(){return id;}
}
public static java.util.Map<String,org.springframework.data.redis.cache.RedisCacheConfiguration> configs(
 RedisConfig.RedisJson redisJson,org.springframework.data.redis.cache.RedisCacheConfiguration base){
'''+recipe+'\n}\n}', '''import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.type.TypeFactory;
import org.springframework.data.redis.serializer.*;
import org.springframework.data.redis.serializer.RedisSerializationContext.SerializationPair;
import java.util.*;''',package='com.example.lab10.shop.config')
circuit=get('08','public class CircuitBreakingCache')
circuit=circuit.replace('    ...', '''    final Cache delegate;final CacheCircuitBreaker breaker;
    public CircuitBreakingCache(Cache delegate,CacheCircuitBreaker breaker){this.delegate=delegate;this.breaker=breaker;}
    @Override public String getName(){return delegate.getName();}
    @Override public Object getNativeCache(){return delegate.getNativeCache();}
    @Override public <T>T get(Object key,Class<T> type){return guard(()->delegate.get(key,type));}
    @Override public <T>T get(Object key,java.util.concurrent.Callable<T> loader){return guard(()->delegate.get(key,loader));}
'''+get('08','evict 與 clear 即使跳閘也要試'))
write_java(circuit,'''import org.springframework.cache.Cache;
import java.util.function.Supplier;''')
write_java('public class CacheUnavailableException extends RuntimeException {public CacheUnavailableException(String name){super(name);}}')
assembly=get('08','Cache exposed = new TransactionAwareCacheDecorator')
write_java('''public class CacheAssembly {
public static org.springframework.cache.Cache assemble(org.springframework.cache.Cache rawRedisCache,
 CacheCircuitBreaker breaker,com.github.benmanes.caffeine.cache.Cache<Object,Object> local){
'''+assembly+'\nreturn exposed;\n}\n}', 'import org.springframework.cache.Cache;import org.springframework.cache.transaction.TransactionAwareCacheDecorator;')
write_java('''public class FencedStoreProbe {
final java.util.Map<String,Long> fence=new java.util.HashMap<>();
final java.util.Map<String,Integer> value=new java.util.HashMap<>();
final java.util.concurrent.atomic.AtomicInteger rejected=new java.util.concurrent.atomic.AtomicInteger();
'''+get('09','synchronized void write(String k, int v, Long token)')+'\n}')
# Actual scheduled method, with domain data sources represented by small interfaces.
method=get('12','public void reconcile()')
write_java('''public class ReconcileProbe {
public interface Inventory {int stock(Long id);}
public interface Redis {long current(Long id);}
private final Inventory inventoryDao;private final Redis redis;
private final org.slf4j.Logger log=org.slf4j.LoggerFactory.getLogger(getClass());
public ReconcileProbe(Inventory db,Redis redis){inventoryDao=db;this.redis=redis;}
java.util.List<Long> activeProductIds(){return java.util.List.of(1L);}void alert(){}
'''+method+'\n}', 'import org.springframework.scheduling.annotation.Scheduled;')
method=get('12','public Deduction deduct(Long productId, int count)')
write_java('''public class StockClientProbe {
public enum Result {OK,SOLD_OUT,NOT_LOADED}
public record Deduction(Result result,long left){}
final org.springframework.data.redis.core.StringRedisTemplate redis;
final org.springframework.data.redis.core.script.RedisScript<List> deduct;
public StockClientProbe(org.springframework.data.redis.core.StringRedisTemplate redis,
 org.springframework.data.redis.core.script.RedisScript<List> deduct){this.redis=redis;this.deduct=deduct;}
String key(Long id){return "stock:"+id;}
'''+method+'\n}', 'import java.util.List;')
method=get('12','public Reply seckill(')
write_java('''public class SeckillProbe {
public record Order(long id){}
public record Decision(boolean allowed){}
public interface RedisStock {StockClientProbe.Deduction deduct(Long id,int n);void giveBack(Long id,int n);}
public interface OrderDao {Order settle(Long id,String user);}
public interface Limiter {Decision tokenBucket(String key,int capacity,int rate,int requested);}
public static class TooManyRequestsException extends RuntimeException{}
public static class ServiceUnavailableException extends RuntimeException{}
final RedisStock redisStock;final OrderDao orderDao;final Limiter limiter;
final IdempotencyService idem;
final org.slf4j.Logger log=org.slf4j.LoggerFactory.getLogger(getClass());
public SeckillProbe(IdempotencyService idem,RedisStock stock,OrderDao dao){this.idem=idem;redisStock=stock;orderDao=dao;limiter=(k,c,r,n)->new Decision(true);}
String orderJson(Order o){return "{\\"orderId\\":"+o.id()+"}";}void alert(){}
'''+method+'\n}', '''import com.example.lab10.shop.idempotency.*;
import com.example.lab10.shop.idempotency.DurableIdempotency.Reply;
import static review.StockClientProbe.Result.*;
import org.springframework.transaction.support.*;''')
for ch,name in [('09','fenced-lock-acquire'),('10','rate-token-bucket'),('10','rate-sliding-counter'),('10','idempotency-begin'),('10','idempotency-finish'),('12','deduct-stock'),('05','release-lock')]:
 source=get(ch,'-- KEYS[1] = 鎖的 key，ARGV[1] = 我當初寫進去的 token','lua') if name=='release-lock' else get(ch,'-- scripts/'+name+'.lua','lua')
 path=resources/'scripts'/(name+'.lua');path.parent.mkdir(exist_ok=True);path.write_text(source)
(resources/'schema.sql').write_text(get('10','CREATE TABLE IF NOT EXISTS business_request','sql'))
for name,needle in [('redis.conf','bind 0.0.0.0'),('roles.conf','############ ① 快取那台'),('app.acl','user app reset on')]:
 (resources/name).write_text(get('14',needle,'conf'))
(resources/'ha-start.sh').write_text(get('13',"mkdir -p /lab/m" ,'bash'))
(root/'target/fences.json').write_text(json.dumps(blocks,ensure_ascii=False,indent=2))
print('Extracted current Markdown to',generated,'and',resources)
