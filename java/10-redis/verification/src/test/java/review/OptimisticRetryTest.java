package review;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.*;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.orm.jpa.*;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.transaction.annotation.*;
import org.springframework.transaction.PlatformTransactionManager;
import jakarta.persistence.*;
import review.jpa.VersionedItem;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
class OptimisticRetryTest {
 @Configuration @EnableTransactionManagement static class Config {
  @Bean javax.sql.DataSource ds(){return new DriverManagerDataSource("jdbc:h2:mem:version;DB_CLOSE_DELAY=-1","sa","");}
  @Bean LocalContainerEntityManagerFactoryBean emf(javax.sql.DataSource ds){
   var f=new LocalContainerEntityManagerFactoryBean();f.setDataSource(ds);f.setPackagesToScan("review.jpa");f.setJpaVendorAdapter(new HibernateJpaVendorAdapter());f.setJpaPropertyMap(Map.of("hibernate.hbm2ddl.auto","create-drop"));return f;
  }
  @Bean PlatformTransactionManager manager(EntityManagerFactory emf){return new JpaTransactionManager(emf);}
  @Bean TxDao dao(EntityManagerFactory emf){return new TxDao(SharedEntityManagerCreator.createSharedEntityManager(emf));}
 }
 public static class TxDao {
  final EntityManager em;public TxDao(EntityManager em){this.em=em;}
  @Transactional public void update(CountDownLatch read,CountDownLatch finish,String name){
   VersionedItem p=em.find(VersionedItem.class,1L);if(read!=null){read.countDown();RedisBehaviorTest.await(finish);}p.name=name;
   // No explicit flush. Proxy commits after this method body returns.
  }
 }
 @Test void callerCatchReceivesCommitConflictWithoutExplicitFlush()throws Exception{
  try(var ctx=new AnnotationConfigApplicationContext(Config.class)){
   new JdbcTemplate(ctx.getBean(javax.sql.DataSource.class)).update("INSERT INTO VersionedItem(id,version,name) VALUES(1,0,'old')");
   var dao=ctx.getBean(TxDao.class);var read=new CountDownLatch(1);var finish=new CountDownLatch(1);var pool=Executors.newSingleThreadExecutor();
   try{
    var result=pool.submit(()->{try{dao.update(read,finish,"A");return "unexpected success";}catch(org.springframework.orm.ObjectOptimisticLockingFailureException e){return "caught by caller";}});
    assertThat(read.await(5,TimeUnit.SECONDS)).isTrue();dao.update(null,null,"B");finish.countDown();
    assertThat(result.get(5,TimeUnit.SECONDS)).isEqualTo("caught by caller");
   }finally{finish.countDown();pool.shutdownNow();}
  }
  System.out.println("CONFIRMED: external caller catches @Transactional proxy commit conflict without em.flush()");
 }
}
