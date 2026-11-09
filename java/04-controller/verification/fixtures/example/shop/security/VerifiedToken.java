package example.shop.security;
public record VerifiedToken(String userId,java.util.Set<String> authorities,java.time.Instant expiresAt){}
