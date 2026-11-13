package review;

import com.example.shop.persistence.VersionedBatchCounts;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.jdbc.UncategorizedSQLException;
import org.springframework.jdbc.core.*;
import org.springframework.jdbc.core.namedparam.*;
import java.sql.SQLException;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;

class WriteRegressionTest {
    static byte[] id(int value){byte[] bytes=new byte[16];bytes[15]=(byte)value;return bytes;}
    static JdbcTemplate freshShop() {
        FixtureDatabase.migrateShop();var jdbc=new JdbcTemplate(FixtureDatabase.primary());
        for(String table:List.of("outbox_message","order_item","orders","address","stock","product","customer"))jdbc.update("DELETE FROM "+table);
        return jdbc;
    }
    static JdbcTemplate stock(int qty,int reserved) {
        var jdbc=freshShop();
        jdbc.update("INSERT INTO product(id,sku,name,unit_price) VALUES(?,'fixture','product',10)",id(1));
        jdbc.update("INSERT INTO stock(product_id,qty,reserved_qty) VALUES(?,?,?)",id(1),qty,reserved);return jdbc;
    }
    @Test void reservationUsesAvailableQuantityAndReturnsZeroForInsufficientStock() {
        var jdbc=stock(10,8);String sql=FixtureDatabase.resource("reserve.sql");
        assertThat(jdbc.update(sql,3,id(1),3)).isZero();
        assertThat(jdbc.queryForObject("SELECT reserved_qty FROM stock",Integer.class)).isEqualTo(8);
        assertThat(jdbc.update(sql,2,id(1),2)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT qty FROM stock",Integer.class)).isEqualTo(10);
        assertThat(jdbc.queryForObject("SELECT reserved_qty FROM stock",Integer.class)).isEqualTo(10);
    }
    @Test void concurrentReservationsDoNotExceedAvailableStock()throws Exception {
        var jdbc=stock(10,0);String sql=FixtureDatabase.resource("reserve.sql");
        try(var workers=Executors.newFixedThreadPool(10)) {
            var jobs=new ArrayList<Future<Integer>>();
            for(int i=0;i<20;i++)jobs.add(workers.submit(()->jdbc.update(sql,1,id(1),1)));
            int succeeded=0;for(var job:jobs)succeeded+=job.get(15,TimeUnit.SECONDS);
            assertThat(succeeded).isEqualTo(10);
        }
        assertThat(jdbc.queryForObject("SELECT reserved_qty FROM stock",Integer.class)).isEqualTo(10);
        assertThat(jdbc.queryForObject("SELECT qty FROM stock",Integer.class)).isEqualTo(10);
    }
    @Test void claimedOutboxRowsCanMoveToTheSchemaDefinedPublishedState() {
        var jdbc=freshShop();byte[] event=id(2);
        jdbc.update("INSERT INTO outbox_message(id,aggregate_id,event_type,payload) VALUES(?,?,'CREATED','{}')",event,id(1));
        var ds=FixtureDatabase.primary();var tx=FixtureDatabase.tx(ds);var named=new NamedParameterJdbcTemplate(ds);
        tx.executeWithoutResult(s->{
            var claimed=named.queryForList("SELECT id FROM outbox_message WHERE status='PENDING' ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED",Map.of(),byte[].class);
            assertThat(claimed).hasSize(1);
            assertThat(named.update(FixtureDatabase.resource("publish.sql"),new MapSqlParameterSource("ids",claimed))).isEqualTo(1);
        });
        assertThat(jdbc.queryForObject("SELECT status FROM outbox_message",String.class)).isEqualTo("PUBLISHED");
        assertThat(jdbc.queryForObject("SELECT published_at IS NOT NULL FROM outbox_message",Boolean.class)).isTrue();
    }
    static org.springframework.jdbc.datasource.DriverManagerDataSource versionedRows() {
        var ds=FixtureDatabase.schema("versioned_batch");var jdbc=new JdbcTemplate(ds);
        jdbc.execute("DROP TABLE IF EXISTS versioned");jdbc.execute("CREATE TABLE versioned(id int PRIMARY KEY,ver int)");
        jdbc.update("INSERT INTO versioned VALUES(1,0),(2,0),(3,0),(4,0),(5,0)");return ds;
    }
    static int[] update(JdbcTemplate jdbc,boolean stale) {
        return jdbc.execute((ConnectionCallback<int[]>) c->{
            try(var ps=c.prepareStatement("UPDATE versioned SET ver=ver+1 WHERE id=? AND ver=?")) {
                for(int i=1;i<=5;i++){ps.setInt(1,i);ps.setInt(2,stale&&i==5?99:0);ps.addBatch();}
                return ps.executeBatch();
            }
        });
    }
    @Test void staleVersionCountFailsAndRollsBackTheWholeBatch() {
        var ds=versionedRows();var jdbc=new JdbcTemplate(ds);
        assertThatThrownBy(()->FixtureDatabase.tx(ds).executeWithoutResult(s->{
            int[] counts=update(jdbc,true);assertThat(counts).containsExactly(1,1,1,1,0);
            VersionedBatchCounts.requireOnePerUpdate(counts,5);
        })).isInstanceOf(OptimisticLockingFailureException.class);
        assertThat(jdbc.queryForObject("SELECT SUM(ver) FROM versioned",Integer.class)).isZero();
    }
    @Test void knownSuccessfulVersionUpdatesCommit() {
        var ds=versionedRows();var jdbc=new JdbcTemplate(ds);
        FixtureDatabase.tx(ds).executeWithoutResult(s->VersionedBatchCounts.requireOnePerUpdate(update(jdbc,false),5));
        assertThat(jdbc.queryForObject("SELECT SUM(ver) FROM versioned",Integer.class)).isEqualTo(5);
    }
    @ParameterizedTest @ValueSource(ints={-2,-3,2}) void unknownUpdateCountsCannotPassAsSuccess(int count) {
        assertThatThrownBy(()->VersionedBatchCounts.requireOnePerUpdate(new int[]{count},1)).isInstanceOf(IllegalStateException.class);
    }
    @Test void wrongBatchResultLengthFails() {
        assertThatThrownBy(()->VersionedBatchCounts.requireOnePerUpdate(new int[]{1},2)).isInstanceOf(IllegalStateException.class);
    }
    @Test void check3819UsesTheDocumentedDefaultTranslation() {
        var ds=FixtureDatabase.schema("check_translation");var jdbc=new JdbcTemplate(ds);
        jdbc.execute("DROP TABLE IF EXISTS sample");jdbc.execute("CREATE TABLE sample(qty int CHECK(qty>=0))");
        assertThatThrownBy(()->jdbc.update("INSERT INTO sample VALUES(-1)"))
                .isInstanceOf(UncategorizedSQLException.class).satisfies(e->{
                    var cause=(SQLException)e.getCause();assertThat(cause.getErrorCode()).isEqualTo(3819);assertThat(cause.getSQLState()).isEqualTo("HY000");
                });
    }
}
