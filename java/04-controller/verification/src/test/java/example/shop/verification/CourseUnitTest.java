package example.shop.verification;

import com.fasterxml.jackson.databind.ObjectMapper;
import example.shop.common.config.*;
import example.shop.common.error.*;
import example.shop.common.web.*;
import example.shop.common.web.idempotency.*;
import example.shop.order.service.*;
import example.shop.order.web.SseProperties;
import example.shop.order.web.dto.OrderFilter;
import example.shop.test.*;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.mock.web.*;
import org.springframework.web.cors.*;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.context.request.ServletWebRequest;
import org.springframework.context.support.StaticMessageSource;
import org.springframework.core.MethodParameter;
import org.springframework.context.support.DefaultMessageSourceResolvable;
import org.springframework.validation.method.*;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.security.web.servletapi.SecurityContextHolderAwareRequestWrapper;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpHeaders;
import org.springframework.validation.beanvalidation.LocalValidatorFactoryBean;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@Tag("unit")
class CourseUnitTest {
    final Clock clock = Clock.fixed(Instant.parse("2026-11-05T00:00:00Z"), ZoneOffset.UTC);
    final ObjectMapper json = new ObjectMapper().findAndRegisterModules();
    ProblemFactory factory() { return new ProblemFactory(new ApiProblemProperties("https://api.shop.example/problems"), new StaticMessageSource(), clock); }
    ProblemWriter writer() { return new ProblemWriter(factory(), json); }
    @AfterEach void clean() { SecurityContextHolder.clearContext(); }

    @ParameterizedTest @ValueSource(ints={0,3,4,5,8192,8193})
    void cacheKnowsExactlyWhenBodyExceededLimit(int length) throws Exception {
        var req=new MockHttpServletRequest("POST","/orders");req.setContent(new byte[length]);
        var cached=new CachedBodyRequestWrapper(req,4);
        assertThat(cached.cachedBody()).hasSize(Math.min(length,4));
        assertThat(cached.isTruncated()).isEqualTo(length>4);
    }
    @Test void cacheFilterRejectsInsteadOfForwardingTruncatedJson() throws Exception {
        var req=new MockHttpServletRequest("POST","/orders");req.setContentType("application/json");req.setContent("12345".getBytes());
        var response=new MockHttpServletResponse();var forwarded=new AtomicBoolean();
        new CachedBodyFilter(new FilterProperties(4,0),writer()).doFilter(req,response,(r,s)->forwarded.set(true));
        assertThat(forwarded).isFalse();assertThat(response.getStatus()).isEqualTo(413);
    }
    public static class Orders { @Idempotent public void create(){} }
    HandlerMethod handler() throws Exception { return new HandlerMethod(new Orders(),Orders.class.getMethod("create")); }
    jakarta.servlet.http.HttpServletRequest secured(String body) throws Exception {
        var request=new MockHttpServletRequest("POST","/orders");request.setContentType("application/json");
        request.addHeader("Idempotency-Key","operation-123");request.setContent(body.getBytes());
        return new SecurityContextHolderAwareRequestWrapper(new CachedBodyRequestWrapper(request,1024),"ROLE_");
    }
    @Test void authenticatedWrappedRequestsWithDifferentBodyMustConflict() throws Exception {
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken("actor","n/a",List.of()));
        var store=new InMemoryIdempotencyStore(clock);var guard=new IdempotencyInterceptor(store,writer());
        assertThat(guard.preHandle(secured("{\"a\":1}"),new MockHttpServletResponse(),handler())).isTrue();
        var response=new MockHttpServletResponse();
        assertThat(guard.preHandle(secured("{\"a\":2}"),response,handler())).isFalse();
        assertThat(response.getStatus()).isEqualTo(409);
        assertThat(response.getContentAsString()).contains("IDEMPOTENCY_KEY_REUSED");
    }
    @Test void replayPreservesCorsVaryAndTraceHeaders() throws Exception {
        var store=new InMemoryIdempotencyStore(clock);var guard=new IdempotencyInterceptor(store,writer());var first=secured("{}");
        assertThat(guard.preHandle(first,new MockHttpServletResponse(),handler())).isTrue();
        store.completeOwned("operation-123","anonymous",(String)first.getAttribute(IdempotencyInterceptor.ATTR_OWNER),201,Map.of("Content-Type","application/json"),"{}".getBytes());
        var response=new MockHttpServletResponse();response.setHeader("Access-Control-Allow-Origin","https://admin.shop.example");
        response.addHeader("Vary","Origin");response.setHeader("X-Trace-Id","current-trace");response.setHeader("Content-Length","999");
        assertThat(guard.preHandle(secured("{}"),response,handler())).isFalse();
        assertThat(response.getStatus()).isEqualTo(201);assertThat(response.getContentAsString()).isEqualTo("{}");
        assertThat(response.getHeader("Access-Control-Allow-Origin")).isEqualTo("https://admin.shop.example");
        assertThat(response.getHeader("Vary")).isEqualTo("Origin");assertThat(response.getHeader("X-Trace-Id")).isEqualTo("current-trace");
        assertThat(response.getHeader("Content-Length")).isEqualTo("2");
    }
    MockHttpServletRequest acquired(InMemoryIdempotencyStore store) {
        var claim=(IdempotencyStore.ClaimResult.Acquired)store.claim("key","a","fp",86400,60);
        var request=new MockHttpServletRequest("POST","/orders");
        request.setAttribute(IdempotencyInterceptor.ATTR_STORE_KEY,"key");request.setAttribute(IdempotencyInterceptor.ATTR_ACTOR_ID,"a");
        request.setAttribute(IdempotencyInterceptor.ATTR_OWNER,claim.ownerToken());return request;
    }
    @Test void successfulJsonLargerThan64KiBIsStillCompleted() throws Exception {
        var store=new InMemoryIdempotencyStore(clock);var response=new MockHttpServletResponse();
        new IdempotencyFilter(store).doFilter(acquired(store),response,(r,s)->{((jakarta.servlet.http.HttpServletResponse)s).setStatus(201);s.getOutputStream().write(new byte[65537]);});
        assertThat(store.find("key","a").orElseThrow().state()).isEqualTo(IdempotencyStore.State.COMPLETED);
        assertThat(store.find("key","a").orElseThrow().responseBody()).hasSize(65537);
        assertThat(store.claim("key","a","fp",86400,60)).isInstanceOf(IdempotencyStore.ClaimResult.Replay.class);
    }
    @Test void exceptionsAnd5xxLeaveAnUnknownOperation() throws Exception {
        for(boolean throwsException:List.of(false,true)){
            var store=new InMemoryIdempotencyStore(clock);var req=acquired(store);var response=new MockHttpServletResponse();
            try {new IdempotencyFilter(store).doFilter(req,response,(r,s)->{
                if(throwsException)throw new jakarta.servlet.ServletException("downstream outcome unknown");
                ((jakarta.servlet.http.HttpServletResponse)s).setStatus(504);
            });}catch(jakarta.servlet.ServletException expected){assertThat(throwsException).isTrue();}
            assertThat(store.find("key","a").orElseThrow().state()).isEqualTo(IdempotencyStore.State.UNKNOWN);
            assertThat(store.claim("key","a","fp",1,1)).isInstanceOf(IdempotencyStore.ClaimResult.InProgress.class);
        }
    }
    static class MutableClock extends Clock {
        Instant now=Instant.parse("2026-11-05T00:00:00Z");public ZoneId getZone(){return ZoneOffset.UTC;}
        public Clock withZone(ZoneId zone){return this;}public Instant instant(){return now;}
    }
    @Test void overdueOperationCannotBeTakenOverAndStaleOwnerCannotMutateNewRecord() {
        var time=new MutableClock();var store=new InMemoryIdempotencyStore(time);
        var first=(IdempotencyStore.ClaimResult.Acquired)store.claim("key","actor","fp",1,1);time.now=time.now.plusSeconds(100);
        assertThat(store.claim("key","actor","fp",1,1)).isInstanceOf(IdempotencyStore.ClaimResult.InProgress.class);
        assertThat(store.find("key","actor").orElseThrow().state()).isEqualTo(IdempotencyStore.State.UNKNOWN);
        store.releaseOwned("key","actor","wrong-owner");assertThat(store.find("key","actor")).isPresent();
        // Only a verified recovery is allowed to release the old owner.
        store.releaseOwned("key","actor",first.ownerToken());
        var second=(IdempotencyStore.ClaimResult.Acquired)store.claim("key","actor","fp",1,1);
        store.completeOwned("key","actor",first.ownerToken(),201,Map.of(),new byte[0]);store.releaseOwned("key","actor",first.ownerToken());
        assertThat(store.find("key","actor").orElseThrow().ownerToken()).isEqualTo(second.ownerToken());
    }
    @Test void actorsAreIsolatedAndResultTtlStartsAtCompletion() {
        var time=new MutableClock();var store=new InMemoryIdempotencyStore(time);
        var first=(IdempotencyStore.ClaimResult.Acquired)store.claim("key","actor","fp",2,60);
        assertThat(store.claim("key","other","fp",2,60)).isInstanceOf(IdempotencyStore.ClaimResult.Acquired.class);
        time.now=time.now.plusSeconds(50);store.completeOwned("key","actor",first.ownerToken(),201,Map.of(),new byte[]{1});
        time.now=time.now.plusSeconds(1);assertThat(store.claim("key","actor","fp",2,60)).isInstanceOf(IdempotencyStore.ClaimResult.Replay.class);
        time.now=time.now.plusSeconds(1);assertThat(store.claim("key","actor","fp",2,60)).isInstanceOf(IdempotencyStore.ClaimResult.Acquired.class);
    }
    MockHttpServletRequest multipart(String path,String value) {
        var r=new MockHttpServletRequest("POST",path);r.setContentType("multipart/form-data;boundary=random");r.addParameter("alt",value);return r;
    }
    String fp(MockHttpServletRequest request) {return IdempotencyFingerprint.compute(request,"/products/{productId}/images",null,false);}
    @Test void finalFingerprintDistinguishesResourcesValuesFilesAndTruncation() {
        assertThat(fp(multipart("/products/A/images","a"))).isNotEqualTo(fp(multipart("/products/B/images","a")));
        var one=multipart("/products/A/images","a,b");var two=multipart("/products/A/images","a");two.addParameter("alt","b");
        assertThat(fp(one)).isNotEqualTo(fp(two));
        one.addPart(new MockPart("file","x.png",new byte[]{1}));two=multipart("/products/A/images","a,b");two.addPart(new MockPart("file","x.png",new byte[]{2}));
        assertThat(fp(one)).isNotEqualTo(fp(two));
        var jsonReq=new MockHttpServletRequest("POST","/orders");jsonReq.setContentType("application/json");
        assertThatThrownBy(()->IdempotencyFingerprint.compute(jsonReq,"/orders",new byte[4],true)).isInstanceOf(IdempotencyBodyTooLargeException.class);
    }
    @Test void missingJsonCacheFailsClosedInsteadOfHashingAnEmptyBody() {
        var req=new MockHttpServletRequest("POST","/orders");req.setContentType("application/json");req.setContent("{}".getBytes());
        assertThatThrownBy(()->IdempotencyFingerprint.compute(req,"/orders",null,false)).isInstanceOf(IllegalStateException.class);
    }
    @Test void authenticatedProductReadUsesTheTrustedOriginPolicy() throws Exception {
        var source=new CorsConfig(new CorsProperties(List.of("https://admin.shop.example"),List.of())).corsConfigurationSource();
        var req=new MockHttpServletRequest("OPTIONS","/products/A");req.addHeader("Origin","https://admin.shop.example");req.addHeader("Access-Control-Request-Method","GET");req.addHeader("Access-Control-Request-Headers","Authorization");
        var res=new MockHttpServletResponse();assertThat(new DefaultCorsProcessor().processRequest(source.getCorsConfiguration(req),req,res)).isTrue();
        assertThat(res.getHeader("Access-Control-Allow-Origin")).isEqualTo("https://admin.shop.example");assertThat(res.getHeader("Access-Control-Allow-Credentials")).isEqualTo("true");
    }
    @Test void multipartBoundaryDoesNotAffectFingerprint() {
        var a=multipart("/products/A/images","same");var b=multipart("/products/A/images","same");b.setContentType("multipart/form-data;boundary=other");
        a.addPart(new MockPart("file","x.png",new byte[]{1}));b.addPart(new MockPart("file","x.png",new byte[]{1}));assertThat(fp(a)).isEqualTo(fp(b));
    }
    @ParameterizedTest @ValueSource(strings={"POST","PUT","DELETE"})
    void trustedProductWritePreflightIsAccepted(String method) throws Exception {
        var source=new CorsConfig(new CorsProperties(List.of("https://admin.shop.example"),List.of())).corsConfigurationSource();
        var req=new MockHttpServletRequest("OPTIONS","/products/A/images");req.addHeader("Origin","https://admin.shop.example");req.addHeader("Access-Control-Request-Method",method);
        req.addHeader("Access-Control-Request-Headers","Authorization,Content-Type,Idempotency-Key");var res=new MockHttpServletResponse();
        assertThat(new DefaultCorsProcessor().processRequest(source.getCorsConfiguration(req),req,res)).isTrue();
        assertThat(res.getHeader("Access-Control-Allow-Origin")).isEqualTo("https://admin.shop.example");
    }
    @Test void anonymousPublicReadUsesWildcardButUntrustedWriteIsDenied() throws Exception {
        var source=new CorsConfig(new CorsProperties(List.of("https://admin.shop.example"),List.of())).corsConfigurationSource();
        var req=new MockHttpServletRequest("GET","/products/A");req.addHeader("Origin","https://partner.example");var res=new MockHttpServletResponse();
        assertThat(new DefaultCorsProcessor().processRequest(source.getCorsConfiguration(req),req,res)).isTrue();assertThat(res.getHeader("Access-Control-Allow-Origin")).isEqualTo("*");
        req=new MockHttpServletRequest("OPTIONS","/products/A/images");req.addHeader("Origin","https://evil.example");req.addHeader("Access-Control-Request-Method","POST");res=new MockHttpServletResponse();
        assertThat(new DefaultCorsProcessor().processRequest(source.getCorsConfiguration(req),req,res)).isFalse();assertThat(res.getStatus()).isEqualTo(403);
    }
    @Test void sseQuotaCannotBeOverbookedAndIndexesStayConsistent() throws Exception {
        var registry=new SseEmitterRegistry(new SimpleMeterRegistry(),new SseProperties(1,1,Duration.ofSeconds(1),Duration.ofSeconds(2),0));
        var go=new CountDownLatch(1);var accepted=new AtomicInteger();
        try(var pool=Executors.newFixedThreadPool(8)){
            var futures=new ArrayList<Future<?>>();for(int i=0;i<20;i++){final int id=i;futures.add(pool.submit(()->{go.await();try{registry.register("s"+id,"o","a"+id,new SseEmitter());accepted.incrementAndGet();}catch(TooManySseConnectionsException expected){}return null;}));}
            go.countDown();for(var f:futures)f.get(5,TimeUnit.SECONDS);
        }
        assertThat(accepted).hasValue(1);assertThat(registry.forOrder("o")).hasSize(1);
        var snapshot=registry.forOrder("o");String old=snapshot.getFirst().subscriptionId();
        try(var pool=Executors.newFixedThreadPool(2)){
            var a=pool.submit(()->registry.unregister(old));var b=pool.submit(()->{try{registry.register("new","o","b",new SseEmitter());}catch(TooManySseConnectionsException expected){}});a.get();b.get();
        }
        assertThat(registry.forOrder("o")).hasSize(registry.size());assertThat(snapshot).hasSize(1);
        for(var sub:registry.all())registry.unregister(sub.subscriptionId());assertThat(registry.countFor("b")).isZero();assertThat(registry.size()).isZero();
    }
    @Test void sweeperRetriesDeletionWithoutReenablingDownloads() {
        var repository=mock(OrderExportRepository.class);var storage=mock(example.shop.common.upload.ObjectStorage.class);var job=new OrderExportJob("job","object",clock.instant(),0);
        when(repository.findSucceededBefore(any(),anyInt())).thenReturn(List.of(job),List.of());
        when(repository.findExpiredWithPendingCleanup(anyInt())).thenReturn(List.of(job));when(repository.findRunningWithHeartbeatBefore(any(),anyInt())).thenReturn(List.of());
        doThrow(new IllegalStateException("temporary")).doNothing().when(storage).delete("object");
        var sweeper=new ExportRetentionSweeper(repository,storage);sweeper.sweep();sweeper.sweep();
        var order=inOrder(repository,storage);order.verify(repository).markExpiredAndRevokeTokens("job");order.verify(storage).delete("object");order.verify(storage).delete("object");order.verify(repository).markStorageDeleted(eq("job"),any());
        verify(repository,times(1)).markExpiredAndRevokeTokens("job");
    }
    @Test void webpIsActuallyDecodedAndReencoded() throws Exception {
        byte[] webp=Base64.getDecoder().decode("UklGRiIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA=");
        assertThat(javax.imageio.ImageIO.getImageReadersByMIMEType("image/webp").hasNext()).isTrue();
        var decoded=javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(webp));
        assertThat(decoded.getWidth()).isEqualTo(1);assertThat(decoded.getHeight()).isEqualTo(1);
        byte[] clean=new example.shop.common.upload.ImageReencoder().reencode(webp,example.shop.common.upload.ContentTypeDetector.DetectedType.WEBP);
        assertThat(javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(clean))).isNotNull();
    }
    @Test void weakIfMatchIsRejectedButWeakIfNoneMatchStillWorks() {
        String tag=ETags.of(7,clock.instant(),"order/customer/en/*");assertThat(tag).startsWith("\"");
        assertThat(ETags.strongMatch("W/"+tag,tag)).isFalse();assertThat(ETags.strongMatch(tag,"W/"+tag)).isFalse();
        assertThat(ETags.strongMatch(tag,tag)).isTrue();assertThat(ETags.matchesAny("W/"+tag,tag)).isTrue();
    }
    @Test void paginationHasTheRequiredDiscriminatorsAndMetadata() {
        var offset=json.valueToTree(PageResponse.PageInfo.offset(0,20,1L,PageResponse.CountRelation.EQUAL,false,10000));
        var cursor=json.valueToTree(PageResponse.PageInfo.cursor(20,null,null,false));
        assertThat(offset.path("mode").asText()).isEqualTo("OFFSET");assertThat(offset.has("hasMore")).isTrue();
        assertThat(cursor.path("mode").asText()).isEqualTo("CURSOR");assertThat(cursor.path("limit").asInt()).isEqualTo(20);assertThat(cursor.has("hasMore")).isTrue();
        assertThat(json.valueToTree(PageResponse.PageInfo.none(2)).path("mode").asText()).isEqualTo("NONE");
    }
    @ParameterizedTest @CsvSource({"504,500","408,400","404,404"})
    void fallbackStatusAndInstanceAgree(int original,int normalized) {
        var req=new MockHttpServletRequest("GET","/error");req.setAttribute(jakarta.servlet.RequestDispatcher.ERROR_STATUS_CODE,original);req.setAttribute(jakarta.servlet.RequestDispatcher.ERROR_REQUEST_URI,"/orders/x");
        var response=new ApiErrorController(factory(),new ErrorLogger()).handle(req);
        assertThat(response.getStatusCode().value()).isEqualTo(normalized);assertThat(response.getBody().status()).isEqualTo(normalized);assertThat(response.getBody().instance()).isEqualTo("/orders/x");
    }
    public String invalid(){return null;}
    @Test void returnValueValidationIsAnInternalError() throws Exception {
        var method=getClass().getMethod("invalid");var result=MethodValidationResult.create(this,method,List.of(new ParameterValidationResult(new MethodParameter(method,-1),null,List.of(new DefaultMessageSourceResolvable("NotNull")))));
        var ex=new HandlerMethodValidationException(result);var response=new ValidationAdvice(factory()).apply(ex,new ServletWebRequest(new MockHttpServletRequest()));
        assertThat(response.getStatusCode().value()).isEqualTo(500);assertThat(((Problem)response.getBody()).code()).isEqualTo("INTERNAL_ERROR");
    }
    @RestController public static class QueryController extends QueryBinder {
        volatile OrderFilter seen;
        @GetMapping("/orders") public Map<String,Object> list(@jakarta.validation.Valid @ModelAttribute OrderFilter filter){seen=filter;return Map.of("page",filter.effectivePage(),"size",filter.effectiveSize(),"sort",filter.sort(),"cursorMode",filter.usesCursor());}
    }
    @Test void queryBindingPreservesSortTermsAndCursorPresence() throws Exception {
        var controller=new QueryController();try(var validator=new LocalValidatorFactoryBean()){
            validator.afterPropertiesSet();var mvc=MockMvcBuilders.standaloneSetup(controller).setValidator(validator).build();
            mvc.perform(get("/orders").param("q","Alice").param("amountFrom","10").param("amountTo","20").param("sort","createdAt,desc","updatedAt,asc")).andExpect(status().isOk()).andExpect(jsonPath("$.sort[0]").value("createdAt,desc"));
            assertThat(controller.seen.q()).isEqualTo("Alice");assertThat(controller.seen.amountFrom()).isEqualByComparingTo("10");
            mvc.perform(get("/orders").param("cursor","").param("limit","5")).andExpect(status().isOk()).andExpect(jsonPath("$.cursorMode").value(true)).andExpect(jsonPath("$.size").value(5));
            mvc.perform(get("/orders").param("cursor","").param("page","0")).andExpect(status().isBadRequest());
            mvc.perform(get("/orders").param("cursor","").param("q","x")).andExpect(status().isBadRequest());
            mvc.perform(get("/orders").param("sort","createdAt,")).andExpect(status().isBadRequest());
        }
    }
    @Test void unknownQueryGuardAcceptsPublishedNamesAndRejectsTypos() throws Exception {
        var guard=new UnknownQueryParamInterceptor();var method=new HandlerMethod(new QueryController(),QueryController.class.getMethod("list",OrderFilter.class));
        var req=new MockHttpServletRequest();for(String name:List.of("q","amountFrom","amountTo","limit","sort","include","updatedFrom"))req.addParameter(name,"x");
        assertThat(guard.preHandle(req,new MockHttpServletResponse(),method)).isTrue();req.addParameter("statuss","PAID");
        assertThatThrownBy(()->guard.preHandle(req,new MockHttpServletResponse(),method)).isInstanceOf(UnknownParameterException.class);
    }
    @Test void auditLookupUsesTheDeclaredRequestUri() {
        var repo=new RecordingAuditRepository();repo.save(new example.shop.common.audit.AuditEvent("trace","PATCH","/orders/{orderId}/shipping-address","/orders/ord_A/shipping-address",null,200,0,clock.instant(),"a",null));
        assertThat(repo.findByResourceId("ord_A")).hasSize(1);assertThat(repo.findByResourceId("ord")).isEmpty();
    }
}
