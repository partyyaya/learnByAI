package example.shop.common.outbox; public record OutboxProperties(int batchSize,int maxAttempts,java.time.Duration stuckThreshold) {}
