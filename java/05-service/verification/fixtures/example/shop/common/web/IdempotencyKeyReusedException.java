package example.shop.common.web; public class IdempotencyKeyReusedException extends RuntimeException { public IdempotencyKeyReusedException(String key) {super(key);} }
