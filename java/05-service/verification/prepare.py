#!/usr/bin/env python3
"""Extract the amended Markdown implementation; fixtures only fill missing dependencies."""
from pathlib import Path
import hashlib
import json
import re
import shutil

HERE = Path(__file__).resolve().parent
COURSE = HERE.parent
OUT = HERE / 'target/course-tests'
if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir(parents=True)
blocks = {}
for path in COURSE.glob('*.md'):
    blocks[path.name[:2]] = re.findall(r'^```[^\n]*\n(.*?)^```\s*$', path.read_text(), re.M | re.S)

def block(chapter, marker):
    found = [b for b in blocks[chapter] if marker in b]
    if len(found) > 1:
        full = [b for b in found if b.startswith('package ')]
        if len(full) == 1: found = full
    assert len(found) == 1, (chapter, marker, len(found))
    return found[0].rstrip() + '\n'

def emit(source):
    package = re.search(r'^package ([\w.]+);', source, re.M).group(1)
    name = re.search(r'public\s+(?:final |abstract |sealed )*(?:class|record|interface|enum)\s+(\w+)', source).group(1)
    path = OUT / package.replace('.', '/') / (name + '.java')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)

def method(source, signature):
    start = source.index(signature)
    pos = source.index('{', start) + 1
    depth = 1
    while depth:
        depth += (source[pos] == '{') - (source[pos] == '}')
        pos += 1
    return source[start:pos]

# Real domain methods and value types. Exception stubs do not validate full error JSON contracts.
terms = ['public record Money(', 'public class Order {', 'public enum OrderStatus ',
    'public record PricedLine(', 'public record OrderLine(', 'public record OrderNumber(',
    'public record Cancellation(', 'public enum CancelReason ', 'public record CancellationResult(',
    'public record StockRelease(', 'public class Payment {', 'public record Refund(',
    'public enum RefundReason ', 'public enum PaymentMethod ', 'public record PaymentResult(',
    'public record Shipment(', 'public record ShipmentLine(', 'public enum Carrier ',
    'public enum OrderAction ', 'public record ShippingAddress(', 'public interface Address ',
    'public record ShippingSnapshot(', 'public record AppliedCoupon(', 'public interface IdempotencyStore ',
    'public record CreateOrderIntent(']
for term in terms:
    emit(block('00', term))
for name in set(re.findall(r'new (\w+Exception)\(', block('00','public class Order {') + block('00','public class Payment {'))):
    if name not in ('IllegalStateException', 'IllegalArgumentException'):
        emit('package example.shop.order.domain.exception;\n'
             f'public class {name} extends RuntimeException {{public {name}(Object... args) {{super("{name}");}}}}')

# The prerequisite command's actual immutable request fields.
prereq = COURSE.parent / '04-controller/01-request-mapping-and-binding.md'
prior_blocks = re.findall(r'^```[^\n]*\n(.*?)^```\s*$', prereq.read_text(), re.M | re.S)
command = next(b for b in prior_blocks if 'public record CreateOrderCommand(' in b)
emit(command)
page = next(b for b in prior_blocks if 'public record PageResponse<T>' in b)
emit('package example.shop.common.web;\n' + page)
for chapter, term in [('05','public final class CacheObjectMappers'),
        ('07','public class OrderTestBuilder'), ('06','public interface OutboxRepository '),
        ('06','public record ClaimedOutbox('), ('06','public class OutboxStateTransactions '),
        ('06','public class OutboxDelivery '), ('06','public class OutboxPoller ')]:
    emit(block(chapter,term))

# A method-only decorator snippet: imports/package are the sole additions.
emit('''package example.shop.common.async;
import java.util.Map;
import org.slf4j.MDC;
import org.springframework.core.task.TaskDecorator;
import org.springframework.context.i18n.*;
import org.springframework.security.core.context.*;
''' + block('06','public class ContextPropagatingTaskDecorator'))
emit('''package example.shop.common.http;
import java.io.IOException;
import java.net.URI;
import org.springframework.http.*;
import org.springframework.http.client.*;
import org.springframework.web.client.ResponseErrorHandler;
''' + block('06','public class OutboundStatusHandler'))

# Use both real query-service return expressions against the current prerequisite PageResponse.
for chapter in ('01','03'):
    source = next(b for b in blocks[chapter] if 'PageResponse.PageInfo.offset(page.getNumber()' in b)
    at = source.index('return new PageResponse<>(')
    end = source.index('10_000));',at) + len('10_000));')
    expression = source[at:end]
    expression = re.sub(r'page.getContent\(\).stream\(\).map\(.*?\).toList\(\)',
                        'page.getContent()', expression)
    emit('''package example.shop.verification.extracted;
import example.shop.common.web.PageResponse;
import org.springframework.data.domain.Page;
public class PageAdapter'''+chapter+''' {
    public static PageResponse<String> adapt(Page<String> page) { '''+expression+' }\n}')

# Extract the service expiry method; missing fields/constructor and collaborator types are fixtures.
expiry = method(block('01','public class OrderCancellationExecutor '),
                'public boolean cancelInNewTransaction(')
emit('''package example.shop.verification.extracted;
import example.shop.order.domain.*;
import java.time.Instant;
import java.util.*;
public class ExpirationAdapter {
    public interface Orders {Optional<Order> findById(String id);void save(Order o);}
    public interface Stock {void release(String id,int quantity);}
    public interface Events {void publish(Object event);}
    public record OrderCancelledEvent(String id) {
        public static Object from(Order o,Object result,Instant now) {return new OrderCancelledEvent(o.id());}
    }
    public static class ResourceNotFoundException extends RuntimeException {
        ResourceNotFoundException(String type,String id) {super(type+id);}
    }
    private final Orders orders;private final Stock stock;private final Events events;
    public ExpirationAdapter(Orders orders,Stock stock,Events events) {
        this.orders=orders;this.stock=stock;this.events=events;
    }
''' + expiry + '\n}')

# The chapter's own allocation example is compiled and run as well.
allocation_example = block('00','void 折扣分攤後加總必須等於原折扣()')
emit('package example.shop.verification;\nimport example.shop.common.money.Money;\nimport java.util.List;import java.math.BigDecimal;\nimport org.junit.jupiter.api.Test;\nimport static org.assertj.core.api.Assertions.*;\npublic class AllocationExampleTest {\n' + allocation_example + '\n}')
stock = block('06','order.lines().size(); i++')
at = stock.index('    for (int i = 0;')
end = stock.index('    orderRepository.save(order);',at)
emit('package example.shop.verification.extracted;\nimport example.shop.order.domain.Order;\nimport java.util.Optional;\nimport java.time.LocalDate;\nimport example.shop.order.domain.exception.InsufficientStockException;\npublic class StockReservationAdapter {\n    public record StockSnapshot(int available,LocalDate restockEstimatedAt) {}\n    public interface StockPort {boolean tryReserve(String id,int quantity);Optional<StockSnapshot> snapshot(String id);}\n    private final StockPort stockPort;private final Runnable persist;\n    public StockReservationAdapter(StockPort stockPort,Runnable persist) {this.stockPort=stockPort;this.persist=persist;}\n    public void create(Order order) {\n' + stock[at:end] + 'persist.run();\n}\n}')
emit('package example.shop.order.domain.exception;\npublic class InsufficientStockException extends RuntimeException {\n    public InsufficientStockException(Object... args) {super("insufficient stock");}\n}\n')

# Actual custom ArchUnit conditions, including selection and annotation-phase logic.
exception_rule = block('04','static final ArchRule afterCommit不可拋業務例外 =')
cache_rule = block('05','new ArchCondition<JavaMethod>("不呼叫寫入交易的方法")')
for source, start_marker, name in [(exception_rule,'methods().that().areAnnotatedWith(TransactionalEventListener.class)','AFTER'),
                                 (cache_rule,'methods().that().areAnnotatedWith(Cacheable.class)','CACHE')]:
    start = source.index(start_marker)
    end = source.index('\n                   });',start) + len('\n                   });')
    rule = source[start:end]
    emit('''package example.shop.verification.extracted;
import com.tngtech.archunit.core.domain.JavaMethod;
import com.tngtech.archunit.lang.*;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.*;
import org.springframework.transaction.event.*;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.cache.annotation.Cacheable;
import example.shop.common.error.BusinessException;
public class Rule'''+name+' {public static final ArchRule RULE = '+rule+'\n}')

# Use the amended Async enable block verbatim, including its BPP order.
async_config = block('06', '@EnableAsync // 保留預設 BPP order')
emit('package example.shop.verification;\nimport org.springframework.context.annotation.*;\nimport org.springframework.core.Ordered;\nimport org.springframework.scheduling.annotation.EnableAsync;\nimport org.springframework.cache.annotation.EnableCaching;\nimport org.springframework.transaction.annotation.EnableTransactionManagement;\n@Configuration(proxyBeanMethods=false)\n@Import(FrameworkRegressionTest.Beans.class)\n' + async_config + 'public class CourseAsyncConfig {}')

listener = method(block('02', 'throw new RuntimeException("寄信失敗");'),
                  'public void onOrderPlaced(')
emit('package example.shop.verification;\nimport org.springframework.transaction.event.TransactionalEventListener;\npublic class CourseListener {\n    public record OrderPlacedEvent() {}\n    @org.springframework.core.annotation.Order(1)\n    @TransactionalEventListener\n' + listener + '\n}')

charge = block('06','// PaymentHttpAdapter.charge 的 I/O 例外邊界')
emit('package example.shop.common.http;\nimport org.springframework.web.client.*;\npublic class PaymentAdapter {\n    public record ChargeRequest(String merchantTradeNo) {}\n    public record ChargeResult(String id) {}\n    private final RestClient restClient;\n    public PaymentAdapter(RestClient restClient) {this.restClient=restClient;}\n    public ChargeResult charge(ChargeRequest request) {\n' + charge + '\n}\n}')

# The fake is a method excerpt: supply imports and only its deliberately narrow dependency interface.
fake = block('07','public class InMemoryOrderRepository implements OrderRepository {')
emit('''package example.shop.order.infrastructure;
import example.shop.order.domain.Order;
import java.util.*;import java.util.concurrent.ConcurrentHashMap;
import org.springframework.data.domain.*;
''' + fake)

# Named SQL excerpts are used verbatim in lease/ordering tests, not reimplemented in Java tests.
sql = [b for b in blocks['06'] if 'UPDATE outbox' in b or 'SELECT o.id FROM outbox o' in b or 'CREATE TABLE outbox_stream' in b]
(HERE/'target/sql.json').write_text(json.dumps(sql,ensure_ascii=False,indent=2))
(HERE/'target/course-hashes.json').write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest()
    for p in COURSE.glob('*.md')},indent=2))

for directory in ('fixtures','src/test/java'):
    shutil.copytree(HERE/directory, OUT, dirs_exist_ok=True)
print(f'Prepared {len(list(OUT.rglob("*.java")))} Java sources from current Markdown plus fixtures.')
