package example.shop.order.service;
public record OrderExportJob(String exportId,String storageKey,java.time.Instant lastHeartbeatAt,long processedRows){}
