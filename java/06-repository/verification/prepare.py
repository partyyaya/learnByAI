#!/usr/bin/env python3
"""Extract the current lesson examples. No historical /tmp review artifacts required."""
from pathlib import Path
import re,shutil
here=Path(__file__).resolve().parent
out=here/'target/course-tests'
if out.exists():shutil.rmtree(out)
shutil.copytree(here/'src/test/java',out)
blocks={p.name[:2]:re.findall(r'^```[^\n]*\n(.*?)^```\s*$',p.read_text(),re.M|re.S) for p in here.parent.glob('[0-6][0-9]-*.md')}
def block(ch,needle):
 matches=[b for b in blocks[ch] if needle in b]
 assert matches,(ch,needle)
 full=[b for b in matches if b.startswith('package ')]
 return full[0] if full else matches[0]
def emit(source):
 package=re.search(r'^package ([\w.]+);',source,re.M).group(1)
 name=re.search(r'^(?:public )?(?:final |abstract )*(?:class|record|interface|enum) (\w+)',source,re.M).group(1)
 dest=out/package.replace('.','/')/(name+'.java');dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(source)
def method(source,signature):
 start=source.index(signature);end=source.index('{',start);depth=1;i=end+1
 while depth:
  if source[i]=='{':depth+=1
  elif source[i]=='}':depth-=1
  i+=1
 return source[start:i]
for marker in ['public final class Order {','public record OrderLine(','public enum OrderStatus {','public record Money(','public interface OrderRepository {','public record Actor(']:emit(block('00',marker))
emit('package review;\nimport java.time.Instant;import java.util.Base64;\n'+block('04','public record Cursor('))
emit('package review;\n'+block('04','public enum SortKey {'))
jdbc=block('02','public class JdbcOrderRepository implements OrderRepository {')
base=method(jdbc,'public void saveAll(Collection<Order> orders)')
batch=method(block('05','int[] updated = jdbc.batchUpdate(UPDATE_HEAD,'),'public void saveAll(Collection<Order> orders)')
helper=block('05','private List<SqlParameterSource> lineParams(Order order)')
emit(jdbc.replace(base,batch).replace('    // ---------- 內部 ----------',helper+'\n    // ---------- 內部 ----------'))
emit(block('02','private static OrderStatus parseStatus(String orderId, String raw)'))
emit('package example.shop.order.infrastructure.persistence;\nimport org.springframework.jdbc.core.RowMapper;import java.sql.ResultSet;\n'+block('02','record OrderLineRow(String orderId, String productId, int quantity,'))
# Only compile scaffolding is provided in templates; method bodies are verbatim course text.
pay=method(block('05','public Order payOrder(String orderId, long version)'), 'public Order payOrder(')
emit('''package review;
import example.shop.order.application.port.OrderRepository;
import example.shop.order.domain.Order;
public class PayService {
 final OrderRepository orderRepository; int stockCalls;
 interface StockPort {void decrease(Order order);}
 final StockPort stockPort=order->stockCalls++;
 static class OrderNotFound extends RuntimeException {}
 PayService(OrderRepository repo){orderRepository=repo;}
'''+pay+'\n}')
jpa=method(block('03','int changed = em.createQuery('),'public void save(Order order)')
p=out/'review/jpa/JpaAdapter.java';p.write_text(p.read_text().replace('// COURSE_SAVE',jpa+'\n'+next(b for b in blocks['02'] if b.startswith('@Override\n@Transactional') and 'public Order saveAndReload(' in b)))
registration=method(block('02','var emails = jdbc.queryForList('),'public void register(')
emit('''package review;
import org.springframework.jdbc.core.namedparam.*;
import org.springframework.dao.DuplicateKeyException;
public class Registration {
 final NamedParameterJdbcTemplate jdbc;
 Registration(javax.sql.DataSource ds){jdbc=new NamedParameterJdbcTemplate(ds);}
 static class EmailAlreadyRegisteredException extends RuntimeException {
 EmailAlreadyRegisteredException(String email,Throwable cause){super("Email conflict",cause);}}
'''+registration+'\n}')
loop=block('05','final long after = lastId;');loop=loop[loop.index('long lastId = 0;'):loop.index('// ⑤')]
(here/'target/keyset-loop.java.txt').write_text(loop)
for name,source in [('h2-schema.sql',block('00','-- shop-service 的訂單資料表')),('mysql-schema.sql',block('06','-- shop-service 的訂單資料表')),('limit-query.sql',block('04','SELECT count(*) FROM ('))]:
 (here/'target'/name).write_text(source)
# Web errors use the real preceding chapter's exception and shared base class below.
prior=(here.parent.parent/'04-controller/03-global-exception-handling.md').read_text()
priorblocks=re.findall(r'^```[^\n]*\n(.*?)^```\s*$',prior,re.M|re.S)
invalid=next(b for b in priorblocks if 'public class InvalidCursorException extends BusinessException' in b)
emit(invalid)
for needle in ['public enum ErrorCode {','public abstract class BusinessException extends RuntimeException','public record FieldViolation(']:
 emit(next(b for b in priorblocks if needle in b and b.startswith('package ')))
for needle in ['public final class SearchParameters {','public final class InvalidSearchParameterException extends BusinessException']:
 emit('package review;\nimport example.shop.common.error.*;\n'+block('04',needle))
# Actual short transaction reader + exporter methods, record/port/output fixtures in test class.
reader=block('05','public class OrderExportReader {').replace('public class OrderExportReader', 'public static class OrderExportReader')
export=method(block('05','public void exportAll(OutputStream out, String resumeFromId) throws IOException'),'public void exportAll(')
p=out/'review/ExportFixture.java';p.write_text(p.read_text().replace('// COURSE_READER',reader).replace('// COURSE_EXPORT','@Transactional(propagation = Propagation.NEVER)\n'+export))
print('Extracted current course examples into',out)
export_query=block('05','public List<OrderExportRow> nextChunk(String afterId, int size)')
(here/'target/export-query.sql').write_text(re.search(r'"""(.*?)"""',export_query,re.S).group(1))
(here/'target/final-datasource.yml').write_text(block('01','url: "jdbc:mysql://${DB_HOST:db-primary.internal}:3306/shop'))
