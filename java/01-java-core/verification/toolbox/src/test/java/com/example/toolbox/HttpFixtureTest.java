package com.example.toolbox;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.time.Duration;
import static org.junit.jupiter.api.Assertions.*;

class HttpFixtureTest {
    @Test void localResponsesCoverSuccessFailureAndPayloadLimit() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/ok", exchange -> {
            byte[] body = "{\"name\":\"Java\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (var out = exchange.getResponseBody()) { out.write(body); }
        });
        server.createContext("/error", exchange -> { exchange.sendResponseHeaders(500, -1); exchange.close(); });
        server.createContext("/large", exchange -> {
            byte[] body = new byte[64 * 1024 + 1];
            exchange.sendResponseHeaders(200, body.length);
            try (var out = exchange.getResponseBody()) { out.write(body); }
        });
        server.start();
        try (HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build()) {
            String base = "http://127.0.0.1:" + server.getAddress().getPort();
            assertEquals("{\"name\":\"Java\"}", HttpExamples.fetch(client, URI.create(base + "/ok")));
            assertThrows(IOException.class, () -> HttpExamples.fetch(client, URI.create(base + "/error")));
            assertThrows(IOException.class, () -> HttpExamples.fetch(client, URI.create(base + "/large")));
        } finally { server.stop(0); }
    }
}
