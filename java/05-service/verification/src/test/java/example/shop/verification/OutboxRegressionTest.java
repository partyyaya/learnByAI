package example.shop.verification;

import example.shop.common.outbox.*;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.transaction.*;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import java.nio.file.*;
import java.sql.*;
import java.time.*;
import java.util.*;
import javax.sql.DataSource;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class OutboxRegressionTest {
    static final Instant NOW=Instant.parse("2026-11-09T00:00:00Z");
    static final Duration LEASE=Duration.ofMinutes(5);

    /** SQL comes from the chapter. Adapter assembly follows the documented stream-lock protocol. */
    static class Sql {
        final List<String> blocks;
        Sql() {
            try {blocks=new ObjectMapper().readValue(Files.readString(Path.of("target/sql.json")),new TypeReference<List<String>>(){});}
            catch(Exception e) {throw new IllegalStateException(e);}
        }
        String containing(String fragment) {
            return blocks.stream().flatMap(b->Arrays.stream(b.split(";")))
                    .map(statement->statement.replaceAll("(?m)^\\s*--.*$","").strip())
                    .filter(statement->statement.contains(fragment)).findFirst().orElseThrow();
        }
    }

    static class JdbcRepository implements OutboxRepository {
        final JdbcTemplate jdbc;final Sql sql=new Sql();
        JdbcRepository(JdbcTemplate jdbc) {this.jdbc=jdbc;}
        void put(long id,String aggregate,String status,int attempts) {
            jdbc.update("insert into outbox_stream values(?) on duplicate key update aggregate_id=values(aggregate_id)",aggregate);
            jdbc.update("insert into outbox(id,message_id,type,aggregate_id,payload,status,attempts,next_attempt_at,created_at) values(?,?,?,?,?,?,?,?,?)",
                    id,"message-"+id,"ORDER_PLACED",aggregate,"{}",status,attempts,Timestamp.from(NOW),Timestamp.from(NOW));
        }
        @Override public void enqueue(OutboxMessage message) {throw new UnsupportedOperationException("original business transaction not modeled");}
        @Override public List<Long> findDueIds(Instant now,int limit) {
            return jdbc.queryForList(sql.containing("SELECT o.id FROM outbox o"),Long.class,Timestamp.from(now),limit);
        }
        @Override public Optional<ClaimedOutbox> tryClaim(long id,Instant now,Duration lease) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
            String aggregate=jdbc.queryForObject("select aggregate_id from outbox where id=?",String.class,id);
            jdbc.queryForObject("select aggregate_id from outbox_stream where aggregate_id=? for update",String.class,aggregate);
            var heads=jdbc.query(sql.containing("SELECT * FROM outbox"),(rs,n)->rs.getLong("id"),aggregate);
            if(heads.isEmpty() || heads.getFirst()!=id) return Optional.empty();
            String token=UUID.randomUUID().toString();Instant until=now.plus(lease);
            int updated=jdbc.update(sql.containing("attempts = attempts + 1, claim_token"),token,Timestamp.from(until),id,Timestamp.from(now));
            if(updated==0) return Optional.empty();
            int attempts=jdbc.queryForObject("select attempts from outbox where id=?",Integer.class,id);
            return Optional.of(new ClaimedOutbox(new OutboxMessage(id,"message-"+id,"ORDER_PLACED",aggregate,"{}",attempts),token,until));
        }
        @Override public boolean markSent(long id,String token,Instant now) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
            return jdbc.update(sql.containing("SET status = 'SENT', sent_at"),Timestamp.from(now),id,token,Timestamp.from(now))==1;
        }
        @Override public boolean markDead(long id,String token,Instant now,String error) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
            return jdbc.update(sql.containing("SET status = 'DEAD', last_error"),error,id,token,Timestamp.from(now))==1;
        }
        @Override public boolean scheduleRetry(long id,String token,Instant now,Instant nextAttemptAt,String error) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
            return jdbc.update(sql.containing("SET status = 'PENDING', next_attempt_at"),Timestamp.from(nextAttemptAt),error,id,token,Timestamp.from(now))==1;
        }
        @Override public int reclaim(Instant now,int maxAttempts) {
            return jdbc.update(sql.containing("SET status = CASE WHEN attempts"),maxAttempts,Timestamp.from(now),Timestamp.from(now));
        }
        @Override public int deleteSentBefore(Instant before,int limit) {throw new UnsupportedOperationException("cleanup not under test");}
        String status(long id) {return jdbc.queryForObject("select status from outbox where id=?",String.class,id);}
    }

    @Configuration(proxyBeanMethods=false) @EnableTransactionManagement(proxyTargetClass=true)
    @Import({OutboxStateTransactions.class,OutboxDelivery.class,OutboxPoller.class})
    static class Config {
        @Bean DataSource dataSource() {return new DriverManagerDataSource("jdbc:h2:mem:"+UUID.randomUUID()+";MODE=MySQL;DB_CLOSE_DELAY=-1","sa","");}
        @Bean PlatformTransactionManager transactionManager(DataSource ds) {return new DataSourceTransactionManager(ds);}
        @Bean JdbcTemplate jdbc(DataSource ds) {
            var jdbc=new JdbcTemplate(ds);var sql=new Sql();
            jdbc.execute(sql.containing("CREATE TABLE outbox_stream"));jdbc.execute(sql.containing("CREATE TABLE outbox ("));
            return jdbc;
        }
        @Bean JdbcRepository repository(JdbcTemplate jdbc) {return spy(new JdbcRepository(jdbc));}
        @Bean OutboxProperties properties() {return new OutboxProperties(10,3,LEASE);}
        @Bean Clock clock() {return Clock.fixed(NOW,ZoneOffset.UTC);}
        @Bean OutboxDispatcher dispatcher() {return mock(OutboxDispatcher.class);}
    }
    static class Fixture implements AutoCloseable {
        final AnnotationConfigApplicationContext ctx=new AnnotationConfigApplicationContext(Config.class);
        final JdbcRepository repo=ctx.getBean(JdbcRepository.class);
        final OutboxStateTransactions states=ctx.getBean(OutboxStateTransactions.class);
        final OutboxDelivery delivery=ctx.getBean(OutboxDelivery.class);
        final OutboxDispatcher dispatcher=ctx.getBean(OutboxDispatcher.class);
        @Override public void close() {repo.jdbc.execute("drop all objects");ctx.close();}
    }

    @Test void sendingHappensOutsideTheCallerTransactionAndStateCommitsIndependently() {
        try(var f=new Fixture()) {
            f.repo.put(1,"O1","PENDING",0);
            doAnswer(inv->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();return null;}).when(f.dispatcher).dispatch(any());
            var callerTx=new TransactionTemplate(f.ctx.getBean(PlatformTransactionManager.class));
            assertThatThrownBy(()->callerTx.execute(status->{f.delivery.deliverIfEligible(1);throw new IllegalStateException("caller rollback");}))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(f.repo.status(1)).isEqualTo("SENT");verify(f.dispatcher).dispatch(any());
        }
    }

    @Test void staleCandidateCannotSkipBackoffAndOldTokenCannotCompleteTheNewClaim() {
        try(var f=new Fixture()) {
            f.repo.put(1,"O1","PENDING",0);
            assertThat(f.repo.findDueIds(NOW,10)).containsExactly(1L);
            var first=f.states.claim(1,NOW).orElseThrow();
            assertThat(first.message().attempts()).isEqualTo(1);
            assertThat(f.states.claim(1,NOW)).isEmpty();
            Instant later=NOW.plusSeconds(60);
            assertThat(f.states.failed(first,NOW,later,"failure")).isTrue();
            assertThat(f.states.claim(1,NOW)).isEmpty(); // stale preselected id rechecks due time
            var second=f.states.claim(1,later).orElseThrow();
            assertThat(second.token()).isNotEqualTo(first.token());assertThat(second.message().attempts()).isEqualTo(2);
            assertThat(f.states.sent(first,later)).isFalse();assertThat(f.repo.status(1)).isEqualTo("SENDING");
            assertThat(f.states.sent(second,later)).isTrue();
        }
    }

    @Test void leaseRecoveryFencesTheFormerOwner() {
        try(var f=new Fixture()) {
            f.repo.put(1,"O1","PENDING",0);
            var first=f.states.claim(1,NOW).orElseThrow();
            assertThat(f.states.reclaim(NOW.plus(LEASE).minusMillis(1))).isZero();
            Instant expired=NOW.plus(LEASE);
            assertThat(f.states.sent(first,expired)).isFalse();
            assertThat(f.states.reclaim(expired)).isEqualTo(1);
            var next=f.states.claim(1,expired).orElseThrow();
            assertThat(f.states.failed(first,expired,expired.plusSeconds(10),"old worker")).isFalse();
            assertThat(f.states.sent(next,expired)).isTrue();
        }
    }

    @Test void deadHeadBlocksPollerAndTheImmediateDeliveryPath() {
        try(var f=new Fixture()) {
            f.repo.put(1,"O1","DEAD",3);f.repo.put(2,"O1","PENDING",0);f.repo.put(3,"O2","PENDING",0);
            assertThat(f.repo.findDueIds(NOW,10)).containsExactly(3L);
            assertThat(f.states.claim(2,NOW)).isEmpty();
            f.delivery.deliverIfEligible(2);verifyNoInteractions(f.dispatcher);
            f.ctx.getBean(OutboxPoller.class).poll();
            assertThat(f.repo.status(2)).isEqualTo("PENDING");assertThat(f.repo.status(3)).isEqualTo("SENT");
        }
    }

    @Test void attemptsIncreaseOnceAndExhaustedCrashesBecomeDead() {
        try(var f=new Fixture()) {
            f.repo.put(1,"O1","PENDING",2);f.repo.put(2,"O2","PENDING",2);
            var first=f.states.claim(1,NOW).orElseThrow();
            assertThat(first.message().attempts()).isEqualTo(3);
            assertThat(f.states.failed(first,NOW,NOW.plusSeconds(1),"third failure")).isTrue();
            assertThat(f.repo.status(1)).isEqualTo("DEAD");
            f.states.claim(2,NOW).orElseThrow();
            assertThat(f.states.reclaim(NOW.plus(LEASE))).isEqualTo(1);
            assertThat(f.repo.status(2)).isEqualTo("DEAD");
        }
    }

    @Test void remoteFailureSchedulesRetryAndCompletionDbFailureIsNotReclassifiedAsRemoteFailure() {
        try(var f=new Fixture()) {
            f.repo.put(1,"O1","PENDING",0);
            doThrow(new IllegalStateException("remote")).when(f.dispatcher).dispatch(any());
            f.delivery.deliverIfEligible(1);
            assertThat(f.repo.status(1)).isEqualTo("PENDING");assertThat(f.repo.findDueIds(NOW,10)).isEmpty();
            reset(f.dispatcher);f.repo.put(2,"O2","PENDING",0);
            doThrow(new IllegalStateException("database")).when(f.repo).markSent(eq(2L),anyString(),any());
            assertThatThrownBy(()->f.delivery.deliverIfEligible(2)).hasMessage("database");
            assertThat(f.repo.status(2)).isEqualTo("SENDING");
            verify(f.repo,never()).scheduleRetry(eq(2L),anyString(),any(),any(),anyString());
        }
    }
}
