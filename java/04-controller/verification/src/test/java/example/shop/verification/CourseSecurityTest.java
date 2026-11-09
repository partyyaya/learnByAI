package example.shop.verification;

import example.shop.chat.ChatProperties;
import example.shop.chat.web.ws.*;
import example.shop.security.*;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.*;
import org.slf4j.MDC;
import org.springframework.messaging.*;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.*;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.util.unit.DataSize;
import org.springframework.web.socket.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

@Tag("security")
class CourseSecurityTest {
    final Clock clock=Clock.fixed(Instant.parse("2026-11-05T00:00:00Z"),ZoneOffset.UTC);
    ChatProperties props(){return new ChatProperties(List.of("https://admin.shop.example"),Duration.ofSeconds(10),Duration.ofSeconds(10),DataSize.ofKilobytes(64),DataSize.ofKilobytes(512),Duration.ofSeconds(5),10,1);}
    WebSocketSessionRegistry registry(){return new WebSocketSessionRegistry(props(),clock,new SimpleMeterRegistry(),event->{});}
    WebSocketSession session(String id){var ws=mock(WebSocketSession.class);when(ws.getId()).thenReturn(id);return ws;}
    Message<byte[]> frame(StompCommand command,String session,String destination){var a=StompHeaderAccessor.create(command);a.setSessionId(session);a.setSessionAttributes(new HashMap<>());if(destination!=null)a.setDestination(destination);a.setUser(()->"actor");a.setLeaveMutable(true);return MessageBuilder.createMessage(new byte[0],a.getMessageHeaders());}
    @Test void brokerSendAndForeignSubscriptionAreRejected() {
        var guard=new SubscriptionAuthorizationInterceptor((conversation,user)->conversation.equals("allowed"));
        assertThatThrownBy(()->guard.preSend(frame(StompCommand.SEND,"s","/topic/conversations/allowed"),null)).isInstanceOf(ChatAccessDeniedException.class);
        assertThatThrownBy(()->guard.preSend(frame(StompCommand.SUBSCRIBE,"s","/topic/conversations/foreign"),null)).isInstanceOf(ChatAccessDeniedException.class);
        assertThat(guard.preSend(frame(StompCommand.SUBSCRIBE,"s","/topic/conversations/allowed"),null)).isNotNull();
        assertThat(guard.preSend(frame(StompCommand.SEND,"s","/app/conversations/allowed/messages"),null)).isNotNull();
        assertThatThrownBy(()->guard.preSend(frame(StompCommand.SEND,"s","/app/conversations/foreign/typing"),null)).isInstanceOf(ChatAccessDeniedException.class);
    }
    @Test void configuredChannelCarriesSecurityAndMdcOnWorkerAndRestoresContext() throws Exception {
        var sessions=registry();sessions.register(session("s"));var auth=new StompAuthChannelInterceptor(raw->new VerifiedToken("actor",Set.of("AGENT"),clock.instant().plusSeconds(60)),sessions);
        var guard=new SubscriptionAuthorizationInterceptor((c,u)->true);var mdc=new StompMdcChannelInterceptor();
        var config=new StompConfig(auth,mdc,props(),guard,sessions);
        class Inspection extends ChannelRegistration {List<ChannelInterceptor> configured(){return getInterceptors();}}
        var registration=new Inspection();config.configureClientInboundChannel(registration);
        assertThat(registration.configured()).contains(guard);
        try(var pool=Executors.newSingleThreadExecutor()){
            pool.submit(()->MDC.put("worker","previous")).get();
            var channel=new ExecutorSubscribableChannel(pool);registration.configured().forEach(channel::addInterceptor);
            var result=new CompletableFuture<List<String>>();channel.subscribe(message->{result.complete(List.of(MDC.get("traceId"),SecurityContextHolder.getContext().getAuthentication().getName()));});
            var connect=frame(StompCommand.CONNECT,"s",null);var accessor=MessageHeaderAccessor.getAccessor(connect,StompHeaderAccessor.class);accessor.setNativeHeader("Authorization","Bearer good");
            MDC.put("caller","keep");channel.send(connect);
            assertThat(result.get(5,TimeUnit.SECONDS).get(0)).hasSize(16);assertThat(result.get().get(1)).isEqualTo("actor");
            assertThat(MDC.get("caller")).isEqualTo("keep");assertThat(pool.submit(()->MDC.get("worker")).get()).isEqualTo("previous");
        }finally{MDC.clear();SecurityContextHolder.clearContext();}
    }
    @Test void expiredTokenClosesTheRegisteredTransportWith4001() throws Exception {
        var sessions=registry();var ws=session("s");sessions.register(ws);
        var auth=new StompAuthChannelInterceptor(raw->{throw new TokenExpiredException();},sessions);
        var message=frame(StompCommand.CONNECT,"s",null);MessageHeaderAccessor.getAccessor(message,StompHeaderAccessor.class).setNativeHeader("Authorization","Bearer expired");
        assertThatThrownBy(()->auth.preSend(message,null)).isInstanceOf(StompAuthenticationException.class);
        verify(ws).close(argThat(status->status.getCode()==4001));assertThat(sessions.size()).isZero();
    }
    @Test void registeredSessionsEnforceNodeAndUserCapacity() throws Exception {
        var sessions=registry();assertThat(sessions.register(session("s1"))).isTrue();assertThat(sessions.register(session("s2"))).isTrue();
        assertThat(sessions.authenticate("s1","actor",clock.instant().plusSeconds(60))).isTrue();
        assertThat(sessions.authenticate("s2","actor",clock.instant().plusSeconds(60))).isFalse();
        sessions.markNotReady();assertThat(sessions.register(session("new"))).isFalse();sessions.closeAllInBatches(1,0,CloseStatus.GOING_AWAY);assertThat(sessions.size()).isZero();
    }
    static class MutableClock extends Clock {Instant now=Instant.parse("2026-11-05T00:00:00Z");public ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(ZoneId zone){return this;}public Instant instant(){return now;}}
    @Test void reapersCloseUnauthenticatedAndExpiredAuthenticatedSockets() throws Exception {
        var time=new MutableClock();var sessions=new WebSocketSessionRegistry(props(),time,new SimpleMeterRegistry(),event->{});
        var unauth=session("unauth");var authenticated=session("auth");sessions.register(unauth);sessions.register(authenticated);
        assertThat(sessions.authenticate("auth","actor",time.now.plusSeconds(20))).isTrue();time.now=time.now.plusSeconds(11);sessions.reapUnauthenticated();
        verify(unauth).close(argThat(s->s.getCode()==4002));assertThat(sessions.size()).isEqualTo(1);
        time.now=time.now.plusSeconds(10);sessions.reapExpiredTokens();verify(authenticated).close(argThat(s->s.getCode()==4001));assertThat(sessions.size()).isZero();
    }
}
