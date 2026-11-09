package example.shop.verification;

import example.shop.chat.ChatProperties;
import example.shop.chat.service.ConversationGuard;
import example.shop.chat.web.ws.*;
import example.shop.security.*;
import org.junit.jupiter.api.*;
import org.springframework.boot.*;
import org.springframework.boot.autoconfigure.*;
import org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration;
import org.springframework.boot.actuate.autoconfigure.security.servlet.ManagementWebSecurityAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.*;
import org.springframework.util.unit.DataSize;
import java.net.*;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;

@Tag("security")
@SpringBootTest(classes=CourseSocketTest.App.class,webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
 properties={"shop.chat.allowed-origins[0]=https://admin.shop.example","shop.chat.heartbeat-interval=10s",
 "shop.chat.connect-timeout=10s","shop.chat.message-size-limit=64KB","shop.chat.send-buffer-size-limit=512KB",
 "shop.chat.send-time-limit=5s","shop.chat.max-sessions-per-node=10","shop.chat.max-sessions-per-user=5"})
class CourseSocketTest {
    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude={SecurityAutoConfiguration.class,ManagementWebSecurityAutoConfiguration.class})
    @Import({StompConfig.class,StompAuthChannelInterceptor.class,SubscriptionAuthorizationInterceptor.class,WebSocketSessionRegistry.class,StompMdcChannelInterceptor.class})
    static class App {
        @Bean Clock clock(){return Clock.systemUTC();}
        @Bean JwtVerifier jwtVerifier(){return raw->{if(raw.equals("expired"))throw new TokenExpiredException();return new VerifiedToken("actor",Set.of("AGENT"),Instant.now().plusSeconds(60));};}
        @Bean ConversationGuard conversationGuard(){return (conversation,user)->conversation.equals("allowed");}
    }
    @LocalServerPort int port;
    @org.springframework.beans.factory.annotation.Autowired org.springframework.messaging.simp.SimpMessagingTemplate template;
    static class Client implements WebSocket.Listener,AutoCloseable {
        WebSocket socket;final BlockingQueue<String> frames=new LinkedBlockingQueue<>();final CompletableFuture<Integer> closed=new CompletableFuture<>();final StringBuilder fragment=new StringBuilder();
        public void onOpen(WebSocket ws){ws.request(1);}
        public CompletionStage<?> onText(WebSocket ws,CharSequence data,boolean last){fragment.append(data);if(last){frames.add(fragment.toString());fragment.setLength(0);}ws.request(1);return CompletableFuture.completedFuture(null);}
        public CompletionStage<?> onClose(WebSocket ws,int code,String reason){closed.complete(code);return CompletableFuture.completedFuture(null);}
        public void onError(WebSocket ws,Throwable error){closed.completeExceptionally(error);}
        void send(String frame){socket.sendText(frame+"\u0000",true).join();}
        public void close(){if(socket!=null)socket.abort();}
    }
    Client connect(String token)throws Exception {
        var client=new Client();client.socket=HttpClient.newHttpClient().newWebSocketBuilder().header("Origin","https://admin.shop.example").subprotocols("v12.stomp")
                .buildAsync(URI.create("ws://localhost:"+port+"/ws"),client).get(5,TimeUnit.SECONDS);
        client.send("CONNECT\naccept-version:1.2\nhost:localhost\nAuthorization:Bearer "+token+"\n\n");return client;
    }
    @Test void realSocketGets4001ForAnExpiredToken()throws Exception {
        try(var client=connect("expired")){assertThat(client.closed.get(5,TimeUnit.SECONDS)).isEqualTo(4001);}
    }
    @Test void foreignSubscriptionIsDeniedByTheConfiguredInboundChannel()throws Exception {
        try(var client=connect("good")){
            assertThat(client.frames.poll(5,TimeUnit.SECONDS)).startsWith("CONNECTED");
            client.send("SUBSCRIBE\nid:sub-1\ndestination:/topic/conversations/foreign\n\n");
            assertThat(client.closed.get(5,TimeUnit.SECONDS)).isEqualTo(1002);
        }
    }
    @Test void authorizedSubscriptionReceivesAServerMessage()throws Exception {
        try(var client=connect("good")){
            assertThat(client.frames.poll(5,TimeUnit.SECONDS)).startsWith("CONNECTED");
            client.send("SUBSCRIBE\nid:sub-1\ndestination:/topic/conversations/allowed\n\n");
            org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(5)).untilAsserted(()->{
                template.convertAndSend("/topic/conversations/allowed","server-message");
                assertThat(client.frames.poll(200,TimeUnit.MILLISECONDS)).contains("MESSAGE").contains("server-message");
            });
        }
    }
    @Test void directBrokerSendIsDeniedEvenForAnAllowedConversation()throws Exception {
        try(var client=connect("good")){
            assertThat(client.frames.poll(5,TimeUnit.SECONDS)).startsWith("CONNECTED");
            client.send("SEND\ndestination:/topic/conversations/allowed\ncontent-type:application/json\n\n{\"forged\":true}");
            assertThat(client.closed.get(5,TimeUnit.SECONDS)).isEqualTo(1002);
        }
    }
}
