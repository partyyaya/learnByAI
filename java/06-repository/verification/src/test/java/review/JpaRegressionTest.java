package review;
import review.jpa.*;
import example.shop.order.domain.*;import example.shop.common.money.Money;
import org.junit.jupiter.api.Test;import org.junit.jupiter.params.*;import org.junit.jupiter.params.provider.*;
import org.springframework.context.annotation.*;import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.orm.jpa.*;import org.springframework.orm.jpa.vendor.*;
import org.springframework.transaction.*;import org.springframework.transaction.annotation.*;import org.springframework.transaction.support.*;
import jakarta.persistence.*;import javax.sql.DataSource;import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
class JpaRegressionTest {
 @Configuration(proxyBeanMethods=false) @EnableJpaRepositories(basePackageClasses=RootRepo.class)
 @EnableTransactionManagement(proxyTargetClass=true) static class Beans {
  @Bean LocalContainerEntityManagerFactoryBean entityManagerFactory(DataSource ds){
   var f=new LocalContainerEntityManagerFactoryBean();f.setDataSource(ds);f.setPackagesToScan("review.jpa");f.setJpaVendorAdapter(new HibernateJpaVendorAdapter());
   f.setJpaPropertyMap(Map.of("hibernate.hbm2ddl.auto","create-drop","hibernate.generate_statistics",true));return f;
  }
  @Bean PlatformTransactionManager transactionManager(EntityManagerFactory emf){return new JpaTransactionManager(emf);}
  @Bean JpaAdapter adapter(RootRepo repo,EntityManagerFactory emf){return new JpaAdapter(repo,SharedEntityManagerCreator.createSharedEntityManager(emf));}
 }
 @Configuration(proxyBeanMethods=false) @Import(Beans.class) static class H2 {
  @Bean DataSource dataSource(){return RepositoryRegressionTest.ds(false);}
 }
 @Configuration(proxyBeanMethods=false) @Import(Beans.class) static class Mysql {
  @Bean DataSource dataSource(){return RepositoryRegressionTest.ds(true);}
 }
 static TransactionTemplate tx(AnnotationConfigApplicationContext ctx){return new TransactionTemplate(ctx.getBean(PlatformTransactionManager.class));}
 static Order changedLines(Order source){return Order.rehydrate(source.id(),source.customerId(),source.status(),List.of(new OrderLine("changed",1,Money.twd(10))),source.total(),source.createdAt(),source.version());}
 @ParameterizedTest @ValueSource(booleans={false,true}) void childOnlySaveAdvancesParentAndRejectsOldAggregate(boolean mysql){
  try(var ctx=new AnnotationConfigApplicationContext(mysql?Mysql.class:H2.class)){
   var adapter=ctx.getBean(JpaAdapter.class);var tx=tx(ctx);tx.executeWithoutResult(s->adapter.save(RepositoryRegressionTest.order("O1")));
   var stale=tx.execute(s->adapter.findById("O1").orElseThrow());
   var fresh=tx.execute(s->adapter.saveAndReload(changedLines(stale)));
   assertThat(fresh.version()).isEqualTo(1);assertThat(fresh.lines().getFirst().productId()).isEqualTo("changed");
   assertThatThrownBy(()->tx.executeWithoutResult(s->adapter.save(stale))).isInstanceOf(org.springframework.dao.OptimisticLockingFailureException.class);
   var actual=tx.execute(s->adapter.findById("O1").orElseThrow());assertThat(actual.lines().getFirst().productId()).isEqualTo("changed");
   var second=tx.execute(s->{var o=adapter.findById("O1").orElseThrow();o.markPaid();var paid=adapter.saveAndReload(o);assertThat(paid.version()).isEqualTo(2);paid.cancel();return adapter.saveAndReload(paid);});
   assertThat(second.version()).isEqualTo(3);
  }
 }
 @ParameterizedTest @ValueSource(booleans={false,true}) void flushedChildrenAndCasRollBackTogether(boolean mysql){
  try(var ctx=new AnnotationConfigApplicationContext(mysql?Mysql.class:H2.class)){
   var adapter=ctx.getBean(JpaAdapter.class);var tx=tx(ctx);tx.executeWithoutResult(s->adapter.save(RepositoryRegressionTest.order("O1")));
   assertThatThrownBy(()->tx.executeWithoutResult(s->{var o=adapter.findById("O1").orElseThrow();assertThat(adapter.saveAndReload(changedLines(o)).version()).isEqualTo(1);throw new IllegalStateException("rollback");})).isInstanceOf(IllegalStateException.class);
   var actual=tx.execute(s->adapter.findById("O1").orElseThrow());assertThat(actual.version()).isZero();assertThat(actual.lines().getFirst().productId()).isEqualTo("P1");
  }
 }
 @Test void competingLoadedSnapshotsCannotBothCommit()throws Exception {
  try(var ctx=new AnnotationConfigApplicationContext(Mysql.class);var workers=Executors.newFixedThreadPool(2)){
   var adapter=ctx.getBean(JpaAdapter.class);tx(ctx).executeWithoutResult(s->adapter.save(RepositoryRegressionTest.order("O1")));
   var barrier=new CyclicBarrier(2);var tasks=new ArrayList<Future<Boolean>>();
   for(int i=0;i<2;i++)tasks.add(workers.submit(()->{
    try{tx(ctx).executeWithoutResult(s->{var o=adapter.findById("O1").orElseThrow();try{barrier.await(10,TimeUnit.SECONDS);}catch(Exception e){throw new IllegalStateException(e);}adapter.save(o);});return true;}
    catch(org.springframework.dao.OptimisticLockingFailureException e){return false;}
   }));
   int success=0;for(var task:tasks)if(task.get(20,TimeUnit.SECONDS))success++;
   assertThat(success).isEqualTo(1);assertThat(tx(ctx).<Long>execute(s->adapter.findById("O1").orElseThrow().version())).isEqualTo(1);
  }
 }
 @Test void jpaReadOnlyPreparesTheMysqlConnection(){
  try(var ctx=new AnnotationConfigApplicationContext(Mysql.class)){
   var tx=tx(ctx);tx.setReadOnly(true);tx.executeWithoutResult(s->{var em=EntityManagerFactoryUtils.getTransactionalEntityManager(ctx.getBean(EntityManagerFactory.class));assertThat(em.unwrap(org.hibernate.Session.class).doReturningWork(java.sql.Connection::isReadOnly)).isTrue();});
  }
 }
 @Test void guardPassesProjectionAndRejectsRealLazyNPlusOne(){
  try(var ctx=new AnnotationConfigApplicationContext(H2.class)){
   var adapter=ctx.getBean(JpaAdapter.class);var tx=tx(ctx);
   tx.executeWithoutResult(s->{for(int i=0;i<40;i++)adapter.save(RepositoryRegressionTest.order("O"+i));});
   long p5=count(ctx,5,false),p20=count(ctx,20,false);assertConstantQueries(p5,p20);
   long n5=count(ctx,5,true),n20=count(ctx,20,true);assertThat(n20).isGreaterThan(n5);
   assertThatThrownBy(()->assertConstantQueries(n5,n20)).isInstanceOf(AssertionError.class);
   System.out.println("N+1 guard: projection="+p5+"/"+p20+", lazy="+n5+"/"+n20);
  }
 }
 static void assertConstantQueries(long first,long second){assertThat(first).isEqualTo(second);}
 static long count(AnnotationConfigApplicationContext ctx,int size,boolean lazy){
  var emf=ctx.getBean(EntityManagerFactory.class);emf.getCache().evictAll();var stats=emf.unwrap(org.hibernate.SessionFactory.class).getStatistics();stats.clear();
  tx(ctx).executeWithoutResult(s->{var em=EntityManagerFactoryUtils.getTransactionalEntityManager(emf);em.clear();
   if(lazy){var rows=em.createQuery("SELECT e FROM OrderEntity e ORDER BY e.id",OrderEntity.class).setMaxResults(size).getResultList();assertThat(rows).hasSize(size);rows.forEach(e->e.getLines().forEach(l->assertThat(l.getProductId()).isNotEmpty()));}
   else{var ids=em.createQuery("SELECT e.id FROM OrderEntity e ORDER BY e.id",String.class).setMaxResults(size).getResultList();assertThat(ids).hasSize(size);ids.forEach(id->assertThat(id).isNotEmpty());}
  });return stats.getPrepareStatementCount();
 }
}
