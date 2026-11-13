package review;

import com.example.lab09.ch08.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.*;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.DefaultTransactionStatus;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.assertj.core.api.Assertions.*;

@SpringBootTest(classes=ReviewApplication.class) @org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
class CommitAuditTest {
 @Autowired JdbcTemplate jdbc;
 @Configuration @EnableTransactionManagement static class TxBeans {
  @Bean AuditLog audit(JdbcTemplate jdbc){return new AuditLog(jdbc);}
  @Bean NoteChanges changes(JdbcTemplate jdbc,AuditLog audit){return new NoteChanges(jdbc,audit);}
  @Bean NoteService notes(JdbcTemplate jdbc,AuditLog audit,NoteChanges changes){return new NoteService(jdbc,audit,changes);}
 }
 @Test void commitFailureRollsBackSuccessAndOuterServiceWritesFailure(){
  jdbc.update("DELETE FROM audit_log");jdbc.update("DELETE FROM note");
  AtomicBoolean fail=new AtomicBoolean(true);
  var tm=new DataSourceTransactionManager(jdbc.getDataSource()){
   @Override protected void doCommit(DefaultTransactionStatus status){
    if(fail.getAndSet(false)) throw new TransactionSystemException("simulated commit failure before database commit");
    super.doCommit(status);
   }
  };
  tm.setRollbackOnCommitFailure(true);
  try(var ctx=new AnnotationConfigApplicationContext()){
   ctx.registerBean(JdbcTemplate.class,()->jdbc);ctx.registerBean(PlatformTransactionManager.class,()->tm);
   ctx.register(TxBeans.class);ctx.refresh();
   var service=ctx.getBean(NoteService.class);long id=service.seed("alice","old");
   assertThatThrownBy(()->service.updateV2(id,"new",false)).isInstanceOf(TransactionSystemException.class);
   assertThat(service.bodyOf(id)).isEqualTo("old");
   assertThat(jdbc.queryForList("SELECT outcome FROM audit_log WHERE action='NOTE_UPDATE'",String.class)).containsExactly("FAILURE");
  }
 }
}
