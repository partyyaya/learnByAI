package review;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.transaction.support.TransactionTemplate;
import java.sql.*;import java.util.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;
import static org.assertj.core.api.Assertions.*;
class DatabaseFixTest {
 static final DriverManagerDataSource DATA_SOURCE=new DriverManagerDataSource("jdbc:mysql://127.0.0.1:"+Integer.getInteger("review.mysql.port")+"/review?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC","lab","lab");
 static DriverManagerDataSource ds(){return DATA_SOURCE;}
 static JdbcTemplate jdbc(){return new JdbcTemplate(ds());}
 @Test void opaqueKeysRemainDistinctIncludingCaseAndAccent(){var j=jdbc();j.update("DELETE FROM idempotency_keys WHERE buyer_id=70001");for(var k:List.of("Checkout-A","checkout-a","checkout-á"))j.update("INSERT INTO idempotency_keys(buyer_id,idem_key,request_hash,expires_at) VALUES(70001,?,REPEAT('a',64),NOW()+INTERVAL 1 DAY)",k);assertThat(j.queryForObject("SELECT COUNT(*) FROM idempotency_keys WHERE buyer_id=70001",Integer.class)).isEqualTo(3);}
 @Test void providerIdsRemainDistinct(){var j=jdbc();j.update("DELETE FROM payments WHERE order_id BETWEEN 70001 AND 70003");int i=70001;for(var k:List.of("Charge-A","charge-a","charge-á"))j.update("INSERT INTO payments(order_id,amount,provider,provider_txn_id) VALUES(?,100,'SIMULATED',?)",i++,k);assertThat(j.queryForObject("SELECT COUNT(*) FROM payments WHERE order_id BETWEEN 70001 AND 70003",Integer.class)).isEqualTo(3);}
 @Test void pointLocksAvoidReservationGapDeadlockAtRepeatableRead()throws Exception {
  var j=jdbc();j.update("DELETE FROM inventory_reservations WHERE product_id=71001");j.update("DELETE FROM inventory WHERE product_id=71001");j.update("INSERT INTO inventory(product_id,on_hand,reserved) VALUES(71001,10,1)");j.update("INSERT INTO inventory_reservations(order_id,product_id,quantity,status) VALUES(71001,71001,1,'HELD')");
  try(Connection cancel=ds().getConnection();Connection place=ds().getConnection()){
   cancel.setAutoCommit(false);place.setAutoCommit(false);assertThat(cancel.getTransactionIsolation()).isEqualTo(Connection.TRANSACTION_REPEATABLE_READ);
   // SingleConnectionDataSource lets the exact Markdown helper use this controlled transaction.
   var access=new ReservationAccess(new JdbcTemplate(new SingleConnectionDataSource(cancel,true)));
   assertThat(access.lock(71001)).hasSize(1);
   place.createStatement().executeUpdate("UPDATE inventory SET reserved=reserved+1 WHERE product_id=71001");
   var pool=Executors.newSingleThreadExecutor();var started=new CountDownLatch(1);
   try{var release=pool.submit(()->{started.countDown();new JdbcTemplate(new SingleConnectionDataSource(cancel,true)).update("UPDATE inventory SET reserved=reserved-1 WHERE product_id=71001");});
    assertThat(started.await(3,TimeUnit.SECONDS)).isTrue();Thread.sleep(100);
    place.createStatement().executeUpdate("INSERT INTO inventory_reservations(order_id,product_id,quantity,status) VALUES(71002,71001,1,'HELD')");place.commit();release.get(5,TimeUnit.SECONDS);cancel.rollback();
   }finally{place.rollback();cancel.rollback();pool.shutdownNow();}
  }
 }
 @Test void secondReleaseSeesCurrentStatusEvenWithOlderSnapshot()throws Exception{
  var j=jdbc();j.update("DELETE FROM inventory_reservations WHERE order_id=72001");j.update("INSERT INTO inventory(product_id,on_hand,reserved) VALUES(72001,10,1) ON DUPLICATE KEY UPDATE reserved=1");j.update("INSERT INTO inventory_reservations(order_id,product_id,quantity,status) VALUES(72001,72001,1,'HELD')");
  try(var first=ds().getConnection();var second=ds().getConnection()){
   first.setAutoCommit(false);second.setAutoCommit(false);var one=new JdbcTemplate(new SingleConnectionDataSource(first,true));var two=new JdbcTemplate(new SingleConnectionDataSource(second,true));
   assertThat(new CountedReservationAccess(one).lock(72001)).hasSize(1);
   assertThat(two.queryForObject("SELECT status FROM inventory_reservations WHERE order_id=72001",String.class)).isEqualTo("HELD");
   one.update("UPDATE inventory_reservations SET status='RELEASED' WHERE order_id=72001");first.commit();
   assertThat(two.queryForObject("SELECT status FROM inventory_reservations WHERE order_id=72001",String.class)).isEqualTo("HELD"); // older RR snapshot
   assertThat(new CountedReservationAccess(two).lock(72001)).isEmpty(); // point locking read sees committed RELEASED
   second.rollback();
  }
 }
 @Test void retryStartsNewTransactionAndRollsBackFailedAttempt(){var j=jdbc();j.execute("CREATE TABLE IF NOT EXISTS retry_probe(id INT PRIMARY KEY)");j.update("DELETE FROM retry_probe");var attempts=new AtomicInteger();var tx=new TransactionTemplate(new DataSourceTransactionManager(ds()));var service=new RetryFixture(tx,()->{j.update("INSERT INTO retry_probe VALUES(?)",attempts.incrementAndGet());if(attempts.get()<3)throw new org.springframework.dao.CannotAcquireLockException("injected");return 7;});assertThat(service.run()).isEqualTo(7);assertThat(attempts).hasValue(3);assertThat(j.queryForList("SELECT id FROM retry_probe",Integer.class)).containsExactly(3);}
 @Test void lockRetryIsBounded(){var n=new AtomicInteger();var tx=new TransactionTemplate(new DataSourceTransactionManager(ds()));assertThatThrownBy(()->new RetryFixture(tx,()->{n.incrementAndGet();throw new org.springframework.dao.CannotAcquireLockException("injected");}).run()).isInstanceOf(org.springframework.dao.PessimisticLockingFailureException.class);assertThat(n).hasValue(3);}
}
