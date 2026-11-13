package example.shop.common.outbox; public record OutboxMessage(long id,String messageId,String type,String aggregateId,String payload,int attempts) {}
