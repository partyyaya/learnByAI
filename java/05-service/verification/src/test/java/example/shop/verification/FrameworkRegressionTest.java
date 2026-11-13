package example.shop.verification;

import example.shop.common.async.ContextPropagatingTaskDecorator;
import example.shop.common.cache.CacheObjectMappers;
import example.shop.common.http.*;
import example.shop.common.error.BusinessException;
import example.shop.common.web.PageResponse;
import example.shop.verification.extracted.*;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import io.github.classgraph.ClassGraph;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.*;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.*;
import org.springframework.transaction.*;
import org.springframework.transaction.annotation.*;
import org.springframework.transaction.event.*;
import org.springframework.transaction.support.*;
import org.springframework.scheduling.annotation.Async;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.cache.*;
import org.springframework.cache.annotation.*;
import org.springframework.cache.concurrent.ConcurrentMapCacheManager;
import org.springframework.cache.support.NullValue;
import org.springframework.context.i18n.*;
import org.springframework.security.core.context.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.data.redis.cache.*;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.domain.*;
import org.springframework.mock.http.client.MockClientHttpResponse;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import org.springframework.http.*;
import org.slf4j.MDC;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.nio.charset.StandardCharsets;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.*;
import static org.springframework.test.web.client.response.MockRestResponseCreators.*;

class FrameworkRegressionTest {
    static final AtomicBoolean workerTx = new AtomicBoolean();
    static final AtomicInteger afterFailure = new AtomicInteger();
    static class Work {
        final JdbcTemplate jdbc;
        Work(JdbcTemplate jdbc) {this.jdbc=jdbc;}
        @Async @Transactional public CompletableFuture<Void> fail() {
            workerTx.set(TransactionSynchronizationManager.isActualTransactionActive());
            jdbc.update("insert into work values(1)");throw new IllegalStateException("worker failed");
        }
    }
    static class Events {
        final JdbcTemplate jdbc;final ApplicationEventPublisher publisher;
        Events(JdbcTemplate jdbc,ApplicationEventPublisher publisher) {this.jdbc=jdbc;this.publisher=publisher;}
        @Transactional public void publish() {
            jdbc.update("insert into work values(2)");publisher.publishEvent(new CourseListener.OrderPlacedEvent());
        }
        @Transactional public void manual() {
            jdbc.update("insert into work values(3)");
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() {throw new IllegalStateException("manual callback failed");}
            });
        }
    }
    static class LaterListener {
        @org.springframework.core.annotation.Order(2) @TransactionalEventListener
        public void listen(CourseListener.OrderPlacedEvent event) {afterFailure.incrementAndGet();}
    }
    @Configuration(proxyBeanMethods=false) static class Beans {
        @Bean EmbeddedDatabase dataSource() {return new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2).build();}
        @Bean JdbcTemplate jdbc(EmbeddedDatabase db) {var jdbc=new JdbcTemplate(db);jdbc.execute("create table work(id int)");return jdbc;}
        @Bean PlatformTransactionManager transactionManager(EmbeddedDatabase db) {return new DataSourceTransactionManager(db);}
        @Bean Work work(JdbcTemplate jdbc) {return new Work(jdbc);}
        @Bean Events events(JdbcTemplate jdbc,ApplicationEventPublisher publisher) {return new Events(jdbc,publisher);}
        @Bean CourseListener listener() {return new CourseListener();}
        @Bean LaterListener laterListener() {return new LaterListener();}
        @Bean CacheManager cacheManager() {return new ConcurrentMapCacheManager("test");}
        @Bean ThreadPoolTaskExecutor taskExecutor() {var pool=new ThreadPoolTaskExecutor();pool.setCorePoolSize(1);return pool;}
    }

    @Test void asyncWorkerOwnsItsTransactionAndRollsBack() throws Exception {
        try(var context=new AnnotationConfigApplicationContext(CourseAsyncConfig.class)) {
            var work=context.getBean(Work.class);
            assertThatThrownBy(()->work.fail().get(5,TimeUnit.SECONDS)).isInstanceOf(ExecutionException.class);
            assertThat(workerTx).isTrue();
            assertThat(context.getBean(JdbcTemplate.class).queryForObject("select count(*) from work",Integer.class)).isZero();
        }
    }

    @Test void annotationListenerFailureDoesNotBecomeAnHttpFailureOrStopLaterListeners() {
        afterFailure.set(0);
        try(var context=new AnnotationConfigApplicationContext(CourseAsyncConfig.class)) {
            var events=context.getBean(Events.class);
            assertThatCode(events::publish).doesNotThrowAnyException();
            assertThat(afterFailure).hasValue(1);
            assertThatThrownBy(events::manual).isInstanceOf(IllegalStateException.class).hasMessage("manual callback failed");
            assertThat(context.getBean(JdbcTemplate.class).queryForObject("select count(*) from work",Integer.class)).isEqualTo(2);
        }
    }

    static class MarkerCache extends RedisCache {
        MarkerCache(RedisCacheWriter writer) {super("markers",writer,RedisCacheConfiguration.defaultCacheConfig()
                .serializeValuesWith(RedisSerializationContext.SerializationPair.fromSerializer(CacheObjectMappers.serializer())));}
    }
    @Test void actualRedisCacheNullMarkerRoundTrips() {
        var serializer=CacheObjectMappers.serializer();
        assertThat(serializer.deserialize(serializer.serialize(NullValue.INSTANCE))).isInstanceOf(NullValue.class);
        var bytes=new HashMap<String,byte[]>();var writer=mock(RedisCacheWriter.class);
        doAnswer(inv->{bytes.put(Base64.getEncoder().encodeToString(inv.getArgument(1)),inv.getArgument(2));return null;})
                .when(writer).put(anyString(),any(byte[].class),any(byte[].class),any(Duration.class));
        when(writer.get(anyString(),any(byte[].class))).thenAnswer(inv->bytes.get(Base64.getEncoder().encodeToString(inv.getArgument(1))));
        var cache=new MarkerCache(writer);cache.put("missing",null);
        assertThat(cache.get("missing")).isNotNull();
        assertThat(cache.get("missing").get()).isNull();
    }

    static class MemoryRedisCache extends RedisCache {
        final Map<Object,Object> data=new ConcurrentHashMap<>();
        MemoryRedisCache() {super("scope",mock(RedisCacheWriter.class),RedisCacheConfiguration.defaultCacheConfig());}
        @Override protected Object lookup(Object key) {return data.get(key);}
        @Override public void put(Object key,Object value) {data.put(key,value);}
    }
    @Test void redisSyncScopeIsCacheWideInThePinnedVersion() throws Exception {
        var cache=new MemoryRedisCache();var running=new AtomicInteger();var peak=new AtomicInteger();
        var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            var futures=new ArrayList<Future<?>>();
            for(String key:List.of("a","b")) futures.add(pool.submit(()->{
                start.await();
                return cache.get(key,()->{
                    peak.accumulateAndGet(running.incrementAndGet(),Math::max);
                    try {Thread.sleep(60);return key;} finally {running.decrementAndGet();}
                });
            }));
            start.countDown();for(var future:futures) future.get(3,TimeUnit.SECONDS);
        }
        assertThat(peak).hasValue(1);
    }

    @Test void nullMarkerWhitelistDoesNotAllowAnArbitraryApplicationOutsideTheAllowlist() {
        var serializer=CacheObjectMappers.serializer();
        assertThatThrownBy(()->serializer.deserialize("{\"@class\":\"java.io.File\",\"path\":\"/tmp/x\"}".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(org.springframework.data.redis.serializer.SerializationException.class);
    }

    @Test void transientHttpStatusIsUnknownForSideEffectfulRequests() throws Exception {
        var handler=new OutboundStatusHandler("payment");
        for(int status:List.of(429,500,502,503,504)) {
            var response=new MockClientHttpResponse(new byte[0],HttpStatusCode.valueOf(status));
            assertThat(handler.hasError(response)).isTrue();
            assertThatThrownBy(()->handler.handleError(response)).isInstanceOf(UpstreamOutcomeUnknownException.class);
        }
        assertThatThrownBy(()->handler.handleError(new MockClientHttpResponse(new byte[0],HttpStatus.BAD_REQUEST)))
                .isInstanceOf(OutboundRequestRejectedException.class);
    }

    @Test void ioFailureIsNeverMisclassifiedAsSafeToChargeAgain() {
        var builder=RestClient.builder().baseUrl("https://payment.invalid");
        var server=MockRestServiceServer.bindTo(builder).build();
        server.expect(requestTo("https://payment.invalid/charges")).andRespond(withException(new java.net.SocketTimeoutException("Read timed out")));
        var adapter=new PaymentAdapter(builder.build());
        assertThatThrownBy(()->adapter.charge(new PaymentAdapter.ChargeRequest("merchant-1")))
                .isInstanceOf(UpstreamOutcomeUnknownException.class).hasCauseInstanceOf(org.springframework.web.client.ResourceAccessException.class);
        server.verify();
    }

    @Test void callerRunsPreservesTheSubmittingThreadContext() throws Exception {
        var pool=new ThreadPoolTaskExecutor();pool.setCorePoolSize(1);pool.setMaxPoolSize(1);pool.setQueueCapacity(0);
        pool.setTaskDecorator(new ContextPropagatingTaskDecorator());
        pool.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());pool.initialize();
        var started=new CountDownLatch(1);var release=new CountDownLatch(1);
        try {
            pool.execute(()->{started.countDown();try {release.await();} catch(InterruptedException ex) {Thread.currentThread().interrupt();}});
            assertThat(started.await(3,TimeUnit.SECONDS)).isTrue();
            MDC.put("traceId","caller");LocaleContextHolder.setLocale(Locale.TAIWAN);
            var auth=new UsernamePasswordAuthenticationToken("customer","n/a");SecurityContextHolder.getContext().setAuthentication(auth);
            pool.execute(()->{
                assertThat(MDC.get("traceId")).isEqualTo("caller");
                MDC.put("traceId","task");LocaleContextHolder.setLocale(Locale.JAPAN);
                SecurityContextHolder.getContext().setAuthentication(null);
            });
            assertThat(MDC.get("traceId")).isEqualTo("caller");
            assertThat(LocaleContextHolder.getLocale()).isEqualTo(Locale.TAIWAN);
            assertThat(SecurityContextHolder.getContext().getAuthentication()).isSameAs(auth);
        } finally {release.countDown();pool.shutdown();MDC.clear();LocaleContextHolder.resetLocaleContext();SecurityContextHolder.clearContext();}
    }

    @Test void workerContextIsRestoredEvenWhenTaskThrows() throws Exception {
        try(var pool=Executors.newSingleThreadExecutor()) {
            pool.submit(()->{MDC.put("traceId","worker");LocaleContextHolder.setLocale(Locale.JAPAN);}).get();
            MDC.put("traceId","submitter");LocaleContextHolder.setLocale(Locale.TAIWAN);
            Runnable task=new ContextPropagatingTaskDecorator().decorate(()->{
                assertThat(MDC.get("traceId")).isEqualTo("submitter");throw new IllegalStateException("task");
            });
            assertThatThrownBy(()->pool.submit(task).get()).isInstanceOf(ExecutionException.class);
            assertThat(pool.submit(()->MDC.get("traceId")).get()).isEqualTo("worker");
            assertThat(pool.submit(() -> LocaleContextHolder.getLocale()).get()).isEqualTo(Locale.JAPAN);
        } finally {MDC.clear();LocaleContextHolder.resetLocaleContext();}
    }

    static class TestBusinessException extends BusinessException {}
    static class BadListener {@TransactionalEventListener public void listen(String event) {throw new TestBusinessException();}}
    static class BeforeListener {@TransactionalEventListener(phase=TransactionPhase.BEFORE_COMMIT) public void listen(String event) {throw new TestBusinessException();}}
    static class GoodListener {@TransactionalEventListener public void listen(String event) {}}
    static class BadCache {@Cacheable("test") public String load(String id) {write();return id;} @Transactional public void write() {}}
    static class GoodCache {@Cacheable("test") public String load(String id) {return id;}}

    @Test void architectureRulesRejectViolationsAndAllowIntentionalBeforeCommitValidation() {
        var importer=new ClassFileImporter();
        assertThat(RuleAFTER.RULE.evaluate(importer.importClasses(BadListener.class,TestBusinessException.class,BusinessException.class)).hasViolation()).isTrue();
        assertThat(RuleAFTER.RULE.evaluate(importer.importClasses(BeforeListener.class,GoodListener.class,TestBusinessException.class,BusinessException.class)).hasViolation()).isFalse();
        assertThat(RuleCACHE.RULE.evaluate(importer.importClasses(BadCache.class)).hasViolation()).isTrue();
        assertThat(RuleCACHE.RULE.evaluate(importer.importClasses(GoodCache.class)).hasViolation()).isFalse();
    }

    @Test void paginationUsesTheCurrentSharedMetadataContract() throws Exception {
        var page=new PageImpl<>(List.of("one"),PageRequest.of(0,20),30);
        var mapper=new com.fasterxml.jackson.databind.ObjectMapper();
        for(var response:List.of(PageAdapter01.adapt(page),PageAdapter03.adapt(page))) {
            var json=mapper.readTree(mapper.writeValueAsString(response));
            assertThat(json.at("/page/mode").asText()).isEqualTo("OFFSET");
            assertThat(json.at("/page/hasMore").asBoolean()).isTrue();
            assertThat(json.at("/page/totalElementsRelation").asText()).isEqualTo("EQUAL");
            assertThat(json.at("/page/maxAccessibleElements").asInt()).isEqualTo(10_000);
        }
        var lastAccessible=new PageImpl<>(Collections.nCopies(20,"one"),PageRequest.of(499,20),20_000);
        assertThat(((PageResponse.OffsetPageInfo)PageAdapter01.adapt(lastAccessible).page()).hasMore()).isFalse();
    }

    @Test void classInfoIncludesGrandchildrenWithoutAllInfo() {
        try(var basic=new ClassGraph().enableClassInfo().acceptPackages("example.shop.verification.scan").scan();
            var all=new ClassGraph().enableAllInfo().acceptPackages("example.shop.verification.scan").scan()) {
            var found=basic.getSubclasses("example.shop.verification.scan.Base").getNames();
            assertThat(found).contains("example.shop.verification.scan.Middle","example.shop.verification.scan.Leaf");
            assertThat(found).containsExactlyElementsOf(all.getSubclasses("example.shop.verification.scan.Base").getNames());
        }
    }

    @Test void oneFixedRateTaskDoesNotOverlapItself() throws Exception {
        var active=new AtomicInteger();var peak=new AtomicInteger();var done=new CountDownLatch(4);
        try(var scheduler=new ScheduledThreadPoolExecutor(3)) {
            var task=scheduler.scheduleAtFixedRate(()->{
                peak.accumulateAndGet(active.incrementAndGet(),Math::max);
                try {Thread.sleep(30);} catch(InterruptedException ex) {Thread.currentThread().interrupt();}
                finally {active.decrementAndGet();done.countDown();}
            },0,1,TimeUnit.MILLISECONDS);
            assertThat(done.await(3,TimeUnit.SECONDS)).isTrue();task.cancel(true);
        }
        assertThat(peak).hasValue(1);
    }
}
