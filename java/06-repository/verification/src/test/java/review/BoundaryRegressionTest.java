package review;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.*;import org.springframework.transaction.annotation.*;import org.springframework.transaction.support.*;
import org.springframework.jdbc.core.*;import org.springframework.jdbc.datasource.*;
import org.springframework.data.domain.*;import org.springframework.data.support.PageableExecutionUtils;
import java.util.*;import java.util.concurrent.atomic.AtomicInteger;import java.io.*;import java.nio.file.*;import javax.tools.*;
import static org.assertj.core.api.Assertions.*;
class BoundaryRegressionTest {
 @Test void paymentChecksExpectedVersionBeforeAnyMutation()throws Exception {
  var ds=RepositoryRegressionTest.ds(false);RepositoryRegressionTest.schema(ds,false);var repo=RepositoryRegressionTest.repo(ds);var tx=RepositoryRegressionTest.tx(ds);var jdbc=new JdbcTemplate(ds);
  tx.executeWithoutResult(s->repo.save(RepositoryRegressionTest.order("O1")));jdbc.update("UPDATE orders SET version=5 WHERE id='O1'");var service=new PayService(repo);
  assertThatThrownBy(()->tx.executeWithoutResult(s->service.payOrder("O1",0))).isInstanceOf(org.springframework.dao.OptimisticLockingFailureException.class);
  assertThat(service.stockCalls).isZero();assertThat(jdbc.queryForObject("SELECT version FROM orders WHERE id='O1'",Long.class)).isEqualTo(5);
  var result=tx.execute(s->service.payOrder("O1",5));assertThat(result.version()).isEqualTo(6);assertThat(service.stockCalls).isEqualTo(1);
 }
 @Test void keysetLoopCompilesWithFinalPerIterationCapture()throws Exception {
  String code="""
   import java.util.*;import org.springframework.transaction.support.TransactionTemplate;
   public class ExportExample {TransactionTemplate tx;Repo repo;record PersistableRow(long id){long getId(){return id;}}
   interface Repo {List<PersistableRow>chunkAfter(long id,int limit);}void export(PersistableRow row){}
   void run(){
   """+Files.readString(Path.of("target/keyset-loop.java.txt"))+"}}";
  var source=new SimpleJavaFileObject(java.net.URI.create("string:///ExportExample.java"),JavaFileObject.Kind.SOURCE){public CharSequence getCharContent(boolean b){return code;}};
  var diagnostics=new DiagnosticCollector<JavaFileObject>();Files.createDirectories(Path.of("target/compiler"));
  try(var manager=ToolProvider.getSystemJavaCompiler().getStandardFileManager(diagnostics,null,null)){
   boolean ok=ToolProvider.getSystemJavaCompiler().getTask(null,manager,diagnostics,List.of("-proc:none","-classpath",System.getProperty("java.class.path"),"-d","target/compiler"),null,List.of(source)).call();
   assertThat(ok).as(diagnostics.getDiagnostics().toString()).isTrue();
  }
 }
 @Test void pageCountMatrixIncludesNonfirstEmptyPage(){
  page(List.of(),0,0,0);page(List.of("a"),0,1,0);page(List.of("a"),1,11,0);page(List.of(),3,12,1);page(Collections.nCopies(10,"a"),0,12,1);
 }
 static void page(List<String> content,int page,long total,int expectedCalls){var calls=new AtomicInteger();var result=PageableExecutionUtils.getPage(content,PageRequest.of(page,10),()->{calls.incrementAndGet();return 12;});assertThat(calls).hasValue(expectedCalls);assertThat(result.getTotalElements()).isEqualTo(total);}
 public static class Port implements ExportFixture.OrderExportPort {
  int calls;public int calls(){return calls;}
  @Transactional(propagation=Propagation.MANDATORY,readOnly=true) public List<ExportFixture.OrderExportRow> nextChunk(String after,int size){
   assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();assertThat(TransactionSynchronizationManager.isCurrentTransactionReadOnly()).isTrue();calls++;
   return after.isEmpty()?List.of(new ExportFixture.OrderExportRow("O1")):List.of();
  }
 }
 @Configuration(proxyBeanMethods=false)@EnableTransactionManagement(proxyTargetClass=true) static class TxConfig {
  @Bean javax.sql.DataSource ds(){return RepositoryRegressionTest.ds(false);}
  @Bean org.springframework.transaction.PlatformTransactionManager transactionManager(javax.sql.DataSource ds){return new DataSourceTransactionManager(ds);}
  @Bean example.shop.order.infrastructure.persistence.JdbcOrderRepository repository(javax.sql.DataSource ds){return new example.shop.order.infrastructure.persistence.JdbcOrderRepository(new org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate(ds));}
  @Bean Port port(){return new Port();}
  @Bean ExportFixture.OrderExportReader reader(Port port){return new ExportFixture.OrderExportReader(port);}
  @Bean ExportFixture.Exporter exporter(ExportFixture.OrderExportReader reader){return new ExportFixture.Exporter(reader,id->assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse());}
 }
 @Test void exportUsesShortReaderTransactionsAndWritesOutsideThem()throws Exception {
  try(var ctx=new AnnotationConfigApplicationContext(TxConfig.class)){
   var exporter=ctx.getBean(ExportFixture.Exporter.class);var port=ctx.getBean(Port.class);
   assertThatThrownBy(()->port.nextChunk("",1000)).isInstanceOf(org.springframework.transaction.IllegalTransactionStateException.class);
   var bytes=new ByteArrayOutputStream();var out=new OutputStream(){public void write(int b){assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();bytes.write(b);}public void flush(){assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();}};
   var tx=new TransactionTemplate(ctx.getBean(org.springframework.transaction.PlatformTransactionManager.class));
   assertThatThrownBy(()->tx.executeWithoutResult(s->{try{exporter.exportAll(out,null);}catch(IOException e){throw new UncheckedIOException(e);}})).isInstanceOf(org.springframework.transaction.IllegalTransactionStateException.class);
   exporter.exportAll(out,null);
   assertThat(bytes.toString(java.nio.charset.StandardCharsets.UTF_8)).isEqualTo("O1\n");assertThat(port.calls()).isEqualTo(2);
  }
 }
 @Test void defaultSaveAndReloadStillRequiresTheExistingWriteTransaction()throws Exception {
  try(var ctx=new AnnotationConfigApplicationContext(TxConfig.class)){
   var ds=(DriverManagerDataSource)ctx.getBean(javax.sql.DataSource.class);RepositoryRegressionTest.schema(ds,false);
   var repo=ctx.getBean(example.shop.order.infrastructure.persistence.JdbcOrderRepository.class);
   assertThatThrownBy(()->repo.saveAndReload(RepositoryRegressionTest.order("O1"))).isInstanceOf(org.springframework.transaction.IllegalTransactionStateException.class);
   var tx=new TransactionTemplate(ctx.getBean(org.springframework.transaction.PlatformTransactionManager.class));
   var saved=tx.execute(s->repo.saveAndReload(RepositoryRegressionTest.order("O1")));assertThat(saved.version()).isZero();
  }
 }

}
