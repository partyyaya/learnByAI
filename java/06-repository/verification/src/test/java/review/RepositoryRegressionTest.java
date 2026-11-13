package review;

import example.shop.order.domain.*;
import example.shop.common.money.Money;
import example.shop.order.infrastructure.persistence.JdbcOrderRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.*;
import org.springframework.jdbc.core.namedparam.*;
import org.springframework.jdbc.datasource.*;
import org.springframework.transaction.support.*;
import org.springframework.dao.OptimisticLockingFailureException;
import java.sql.*;import java.time.*;import java.nio.file.*;import java.util.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class RepositoryRegressionTest {
 static String mysqlUrl(String extra){return System.getenv().getOrDefault("MYSQL_URL","jdbc:mysql://127.0.0.1:3306/review?sslMode=DISABLED&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true")+extra;}
 static DriverManagerDataSource ds(boolean mysql){return mysql?new DriverManagerDataSource(mysqlUrl("&characterEncoding=UTF-8&rewriteBatchedStatements=true&useServerPrepStmts=true&useCursorFetch=true"),"root","review-only"):new DriverManagerDataSource("jdbc:h2:mem:"+UUID.randomUUID()+";DB_CLOSE_DELAY=-1","sa","");}
 static Order order(String id){return Order.place(id,"C1",List.of(new OrderLine("P1",1,Money.twd(10))),Money.twd(10),Instant.parse("2026-03-01T00:00:00.123456Z"));}
 static void schema(DriverManagerDataSource ds,boolean mysql)throws Exception {
  var jdbc=new JdbcTemplate(ds);jdbc.execute("DROP TABLE IF EXISTS order_line");jdbc.execute("DROP TABLE IF EXISTS orders");
  for(String sql:Files.readString(Path.of("target/"+(mysql?"mysql":"h2")+"-schema.sql")).split(";"))if(!sql.isBlank())jdbc.execute(sql);
 }
 static JdbcOrderRepository repo(DriverManagerDataSource ds){return new JdbcOrderRepository(new NamedParameterJdbcTemplate(ds));}
 static TransactionTemplate tx(DriverManagerDataSource ds){return new TransactionTemplate(new DataSourceTransactionManager(ds));}
 @ParameterizedTest @ValueSource(booleans={false,true}) void completeDdlAndCappedCountExecute(boolean mysql)throws Exception {
  var ds=ds(mysql);schema(ds,mysql);var jdbc=new JdbcTemplate(ds);
  tx(ds).executeWithoutResult(s->{for(int i=0;i<1005;i++)repo(ds).save(order("O"+i));});
  assertThat(jdbc.queryForObject(Files.readString(Path.of("target/limit-query.sql")),Long.class,"PENDING_PAYMENT")).isEqualTo(1001);
  assertThatThrownBy(()->jdbc.update("UPDATE orders SET total_minor=-1 WHERE id='O0'")).isInstanceOf(org.springframework.dao.DataAccessException.class).hasRootCauseInstanceOf(SQLException.class);
 }
 @Test void correctJavaCharsetConnectsAndRoundTripsEmoji()throws Exception {
  Map<String,Object> yaml=new org.yaml.snakeyaml.Yaml().load(Files.readString(Path.of("target/final-datasource.yml")));
  var spring=(Map<?,?>)yaml.get("spring");var datasource=(Map<?,?>)spring.get("datasource");String url=(String)datasource.get("url");
  assertThat(url).doesNotContain(" ").contains("characterEncoding=UTF-8","useCursorFetch=true");
  String parameters=url.substring(url.indexOf('?')+1).replace("sslMode=REQUIRED","sslMode=DISABLED");
  try(var c=DriverManager.getConnection(mysqlUrl("&"+parameters),"root","review-only");var ps=c.prepareStatement("SELECT ?")){
   ps.setString(1,"訂單😀");try(var rs=ps.executeQuery()){rs.next();assertThat(rs.getString(1)).isEqualTo("訂單😀");}
  }
 }
 @ParameterizedTest @ValueSource(booleans={false,true}) void microsecondKeysetWalkHasNoDuplicatesOrMissingRows(boolean mysql){
  var ds=ds(mysql);var jdbc=new JdbcTemplate(ds);jdbc.execute("DROP TABLE IF EXISTS cursor_sample");
  jdbc.execute("CREATE TABLE cursor_sample(id varchar(26) primary key,created_at "+(mysql?"datetime(6)":"timestamp(6)")+")");
  Instant t=Instant.parse("2026-03-01T00:00:00.123456Z");
  for(int i=1;i<=5;i++)jdbc.update("INSERT INTO cursor_sample VALUES(?,?)","O"+i,Timestamp.from(t.plusNanos((i/2)*1000L)));
  var seen=new ArrayList<String>();Cursor after=null;
  for(int page=0;page<10;page++){
   var rows=after==null?jdbc.query("SELECT id,created_at FROM cursor_sample ORDER BY created_at,id LIMIT 2",(rs,n)->new Cursor(rs.getTimestamp(2).toInstant(),rs.getString(1))):jdbc.query("SELECT id,created_at FROM cursor_sample WHERE created_at>? OR (created_at=? AND id>?) ORDER BY created_at,id LIMIT 2",(rs,n)->new Cursor(rs.getTimestamp(2).toInstant(),rs.getString(1)),Timestamp.from(after.createdAt()),Timestamp.from(after.createdAt()),after.id());
   if(rows.isEmpty())break;rows.forEach(r->seen.add(r.id()));after=Cursor.decode(rows.getLast().encode());
  }
  assertThat(seen).containsExactly("O1","O2","O3","O4","O5");
  assertThat(Cursor.decode(new Cursor(t,"O1").encode()).createdAt()).isEqualTo(t);
  Instant beforeEpoch=Instant.parse("1960-01-01T00:00:00.123456789Z");
  assertThat(Cursor.decode(new Cursor(beforeEpoch,"O1").encode()).createdAt()).isEqualTo(beforeEpoch);
 }
 @Test void malformedAndUnsupportedVersionCursorsFail(){
  for(String raw:List.of("","!!!", "v0|1|0|O1","v1|1|1000000000|O1","v1|1|0|","v1|1|-1|O1")){
   String token=raw.contains("|")?Base64.getUrlEncoder().encodeToString(raw.getBytes(java.nio.charset.StandardCharsets.UTF_8)):raw;
   assertThatThrownBy(()->Cursor.decode(token)).isInstanceOf(IllegalArgumentException.class);
  }
 }
 @ParameterizedTest @ValueSource(booleans={false,true}) void reloadReturnsFreshVersionsForConsecutiveWrites(boolean mysql)throws Exception {
  var ds=ds(mysql);schema(ds,mysql);var repo=repo(ds);var tx=tx(ds);Order original=order("O1");
  tx.executeWithoutResult(s->repo.save(original));
  var returned=tx.execute(s->{original.markPaid();Order fresh=repo.saveAndReload(original);assertThat(fresh.version()).isEqualTo(1);fresh.cancel();return repo.saveAndReload(fresh);});
  assertThat(returned.version()).isEqualTo(2);assertThat(returned.status()).isEqualTo(OrderStatus.CANCELLED);
  assertThat("\"v"+returned.version()+"\"").isEqualTo("\"v2\"");
  assertThatThrownBy(()->tx.executeWithoutResult(s->repo.save(original))).isInstanceOf(OptimisticLockingFailureException.class);
 }
 @ParameterizedTest @ValueSource(booleans={false,true}) void rollbackDiscardsReloadedResult(boolean mysql)throws Exception {
  var ds=ds(mysql);schema(ds,mysql);var repo=repo(ds);var tx=tx(ds);tx.executeWithoutResult(s->repo.save(order("O1")));
  assertThatThrownBy(()->tx.executeWithoutResult(s->{var o=repo.findById("O1").orElseThrow();o.markPaid();assertThat(repo.saveAndReload(o).version()).isEqualTo(1);throw new IllegalStateException("rollback");})).isInstanceOf(IllegalStateException.class);
  var actual=tx.execute(s->repo.findById("O1").orElseThrow());assertThat(actual.version()).isZero();assertThat(actual.status()).isEqualTo(OrderStatus.PENDING_PAYMENT);
 }
 @Test void placeRejectsInvalidTotalsAndEmptyLines(){
  assertThatThrownBy(()->Order.place("bad","C1",order("O1").lines(),Money.twd(-1),Instant.now())).isInstanceOf(IllegalArgumentException.class);
  assertThatThrownBy(()->Order.place("bad","C1",List.of(),Money.twd(10),Instant.now())).isInstanceOf(IllegalArgumentException.class);
 }
 @Test void cancellationUsesTheStateWhitelist(){
  for(var status:OrderStatus.values()){
   var o=Order.rehydrate("O1","C1",status,order("O1").lines(),Money.twd(10),Instant.now(),0);
   if(Set.of(OrderStatus.PENDING_PAYMENT,OrderStatus.PAID,OrderStatus.PARTIALLY_SHIPPED).contains(status)){o.cancel();assertThat(o.status()).isEqualTo(OrderStatus.CANCELLED);}
   else assertThatThrownBy(o::cancel).isInstanceOf(IllegalStateException.class);
  }
 }
 @Test void actualBatchInsertAndVersionedUpdateHaveDifferentCounts()throws Exception {
  try(var c=ds(true).getConnection();var st=c.createStatement()){
   st.execute("DROP TABLE IF EXISTS batch_probe");st.execute("CREATE TABLE batch_probe(id int primary key,version int,status varchar(20))");
   try(var p=c.prepareStatement("INSERT INTO batch_probe VALUES(?,0,'PENDING')")){
    for(int i=0;i<5;i++){p.setInt(1,i);p.addBatch();}assertThat(p.executeBatch()).containsExactly(-2,-2,-2,-2,-2);
   }
   try(var p=c.prepareStatement("UPDATE batch_probe SET status=?,version=version+1 WHERE id=? AND version=?")){
    for(int i=0;i<5;i++){p.setString(1,"PAID");p.setInt(2,i);p.setInt(3,i==4?99:0);p.addBatch();}assertThat(p.executeBatch()).containsExactly(1,1,1,1,0);
   }
  }
 }
 @ParameterizedTest @ValueSource(booleans={false,true}) void actualSaveAllWritesMixedBatchAndRollsBackStaleBatch(boolean mysql)throws Exception {
  var ds=ds(mysql);schema(ds,mysql);var repo=repo(ds);var tx=tx(ds);
  tx.executeWithoutResult(s->repo.save(order("old")));
  tx.executeWithoutResult(s->{var old=repo.findById("old").orElseThrow();old.markPaid();repo.saveAll(List.of(old,order("new")));});
  var stale=order("old");assertThatThrownBy(()->tx.executeWithoutResult(s->repo.saveAll(List.of(order("rollback"),stale)))).isInstanceOf(OptimisticLockingFailureException.class);
  assertThat(tx.<Optional<Order>>execute(s->repo.findById("rollback"))).isEmpty();assertThat(tx.<Long>execute(s->repo.findById("old").orElseThrow().version())).isEqualTo(1);
 }
 @ParameterizedTest @ValueSource(ints={-2,-3,2}) void updateClassificationRejectsUnknownCounts(int count){
  var jdbc=mock(NamedParameterJdbcTemplate.class);when(jdbc.batchUpdate(anyString(),any(SqlParameterSource[].class))).thenReturn(new int[]{count});
  assertThatThrownBy(()->new JdbcOrderRepository(jdbc).saveAll(List.of(order("O1")))).isInstanceOf(IllegalStateException.class);
  verify(jdbc,times(1)).batchUpdate(anyString(),any(SqlParameterSource[].class));verifyNoMoreInteractions(jdbc);
 }
 @Test void actualDriverRowsMatchEachFetchMode()throws Exception {
  for(int mode=0;mode<3;mode++){
   String extra=mode==1?"&useCursorFetch=true&useServerPrepStmts=true":"&useServerPrepStmts=true";
   try(var c=DriverManager.getConnection(mysqlUrl(extra),"root","review-only");var ps=c.prepareStatement("SELECT 1 UNION ALL SELECT 2",ResultSet.TYPE_FORWARD_ONLY,ResultSet.CONCUR_READ_ONLY)){
    ps.setFetchSize(mode==2?Integer.MIN_VALUE:500);try(var rs=ps.executeQuery()){
     var type=((com.mysql.cj.jdbc.result.ResultSetImpl)rs).getRows().getClass().getSimpleName();
     assertThat(type).isEqualTo(new String[]{"ResultsetRowsStatic","ResultsetRowsCursor","ResultsetRowsStreaming"}[mode]);int n=0;while(rs.next())n++;assertThat(n).isEqualTo(2);
    }
   }
  }
 }
 @Test void currentReadClassifiesPkCollisionAfterRepeatableReadSnapshot()throws Exception {
  var ds=ds(true);var jdbc=new JdbcTemplate(ds);jdbc.execute("DROP TABLE IF EXISTS customer");jdbc.execute("CREATE TABLE customer(id varchar(26) primary key,email varchar(100) unique)");
  var tx=tx(ds);tx.setIsolationLevel(Connection.TRANSACTION_REPEATABLE_READ);
  assertThatThrownBy(()->tx.executeWithoutResult(s->{
   assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM customer",Long.class)).isZero();
   try(var other=ds.getConnection();var p=other.prepareStatement("INSERT INTO customer VALUES('id1','old@example.test')")){p.executeUpdate();}catch(SQLException e){throw new RuntimeException(e);}
   new Registration(ds).register("id1","new@example.test");
  })).isInstanceOf(IllegalStateException.class).hasMessageContaining("重複 id");
  assertThatThrownBy(()->tx.executeWithoutResult(s->new Registration(ds).register("id2","old@example.test"))).isInstanceOf(Registration.EmailAlreadyRegisteredException.class);
 }
 @ParameterizedTest @ValueSource(booleans={false,true}) void exportLimitCountsOrdersAndKeepsAllTheirLines(boolean mysql)throws Exception {
  var ds=ds(mysql);schema(ds,mysql);var repo=repo(ds);var tx=tx(ds);
  var many=Order.place("O1","C1",Collections.nCopies(4,new OrderLine("P1",1,Money.twd(10))),Money.twd(40),Instant.now());
  tx.executeWithoutResult(s->{repo.save(many);repo.save(order("O2"));});
  var jdbc=new NamedParameterJdbcTemplate(ds);String sql=Files.readString(Path.of("target/export-query.sql"));
  var first=jdbc.queryForList(sql,new MapSqlParameterSource().addValue("afterId","").addValue("size",1));
  assertThat(first).hasSize(4);assertThat(first).allSatisfy(row->assertThat(row.get("id")).isEqualTo("O1"));
  var second=jdbc.queryForList(sql,new MapSqlParameterSource().addValue("afterId","O1").addValue("size",1));
  assertThat(second).hasSize(1);assertThat(second.getFirst().get("id")).isEqualTo("O2");
 }
 @ParameterizedTest @ValueSource(booleans={false,true}) void registrationTranslatesEmailAndKeepsSuccessInCallerTransaction(boolean mysql){
  var ds=ds(mysql);var jdbc=new JdbcTemplate(ds);jdbc.execute("DROP TABLE IF EXISTS customer");jdbc.execute("CREATE TABLE customer(id varchar(26) primary key,email varchar(100) unique)");
  var registration=new Registration(ds);var tx=tx(ds);tx.executeWithoutResult(s->registration.register("id1","one@example.test"));
  assertThatThrownBy(()->tx.executeWithoutResult(s->registration.register("id2","one@example.test"))).isInstanceOf(Registration.EmailAlreadyRegisteredException.class);
  assertThatThrownBy(()->tx.executeWithoutResult(s->{registration.register("rollback","other@example.test");throw new IllegalStateException("rollback");})).isInstanceOf(IllegalStateException.class);
  assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM customer",Long.class)).isEqualTo(1);
 }

 @Test void theSharedMigrationAlsoExecutesOnMysql()throws Exception {
  var ds=ds(true);schema(ds,false);
  assertThat(new JdbcTemplate(ds).queryForObject("SELECT COUNT(*) FROM orders",Long.class)).isZero();
 }

}
