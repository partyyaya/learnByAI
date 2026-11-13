package review;

import com.example.shop.persistence.MySqlSessionMetrics;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.*;
import static org.assertj.core.api.Assertions.*;

class IndexAndMetricsRegressionTest {
    static JdbcTemplate fixture(String name) {
        var jdbc=new JdbcTemplate(FixtureDatabase.schema(name));
        jdbc.execute("DROP TABLE IF EXISTS sample");return jdbc;
    }
    @Test void constraintIndexIsNotReportedAsRedundant() {
        var jdbc=fixture("index_unique");jdbc.execute("CREATE TABLE sample(id int PRIMARY KEY,email varchar(100),name varchar(100),UNIQUE KEY uq_email(email),INDEX ix_cover(email,name))");
        assertThat(jdbc.queryForList(FixtureDatabase.resource("redundant.sql"),String.class)).isEmpty();
        jdbc.update("INSERT INTO sample VALUES(1,'a','one')");
        assertThatThrownBy(()->jdbc.update("INSERT INTO sample VALUES(2,'a','two')")).isInstanceOf(org.springframework.dao.DuplicateKeyException.class);
    }
    @Test void aRealNonuniquePrefixCandidateIsDetected() {
        var jdbc=fixture("index_prefix");jdbc.execute("CREATE TABLE sample(id int PRIMARY KEY,email varchar(100),name varchar(100),INDEX ix_small(email),INDEX ix_cover(email,name))");
        assertThat(jdbc.queryForList(FixtureDatabase.resource("redundant.sql"),String.class)).containsExactly("sample.ix_small 被 ix_cover 涵蓋");
    }
    @Test void differentDirectionsOrPrefixLengthsAreNotEquivalent() {
        var jdbc=fixture("index_parts");jdbc.execute("CREATE TABLE sample(id int PRIMARY KEY,email varchar(100),name varchar(100),INDEX ix_desc(email DESC),INDEX ix_short(email(5)),INDEX ix_cover(email ASC,name))");
        assertThat(jdbc.queryForList(FixtureDatabase.resource("redundant.sql"),String.class)).isEmpty();
    }
    @Test void anInvisibleCoveringIndexDoesNotReplaceAVisibleOne() {
        var jdbc=fixture("index_visibility");jdbc.execute("CREATE TABLE sample(id int PRIMARY KEY,email varchar(100),name varchar(100),INDEX ix_small(email),INDEX ix_cover(email,name) INVISIBLE)");
        assertThat(jdbc.queryForList(FixtureDatabase.resource("redundant.sql"),String.class)).isEmpty();
    }
    @Test void nullableGeneratedIndexKeepsDeletedEntriesButAllowsRepeatedHistory() {
        var jdbc=fixture("index_soft_delete");
        jdbc.execute("CREATE TABLE sample(id int PRIMARY KEY,email varchar(100),deleted_at datetime,email_active varchar(100) GENERATED ALWAYS AS(IF(deleted_at IS NULL,email,NULL)) VIRTUAL,UNIQUE KEY uq_active(email_active))");
        jdbc.update("INSERT INTO sample(id,email,deleted_at) VALUES(1,'a',NOW()),(2,'a',NOW()),(3,'a',NULL)");
        assertThatThrownBy(()->jdbc.update("INSERT INTO sample(id,email) VALUES(4,'a')")).isInstanceOf(org.springframework.dao.DuplicateKeyException.class);
        var plan=jdbc.queryForList("EXPLAIN SELECT id FROM sample FORCE INDEX(uq_active) WHERE email_active IS NULL").getFirst();
        assertThat(plan.get("key")).isEqualTo("uq_active");assertThat(plan.get("Extra").toString()).contains("Using index");
        assertThat(jdbc.queryForList("SELECT id FROM sample FORCE INDEX(uq_active) WHERE email_active IS NULL",Integer.class)).containsExactlyInAnyOrder(1,2);
    }
    static JdbcTemplate scanRows() {
        var jdbc=fixture("scan_metrics");
        jdbc.execute("CREATE TABLE sample(id int PRIMARY KEY,customer_id int,placed_at datetime,INDEX ix_placed(placed_at),INDEX ix_customer(customer_id,placed_at))");
        jdbc.batchUpdate("INSERT INTO sample VALUES(?,?,DATE_ADD('2026-01-01',INTERVAL ? SECOND))",java.util.stream.IntStream.rangeClosed(1,1000).mapToObj(i->new Object[]{i,i<=20?42:1,i}).toList());
        return jdbc;
    }
    @Test void reverseScanRegressionCannotPassTheHundredReadBudget() {
        var jdbc=scanRows();var counts=MySqlSessionMetrics.measure(jdbc,db->{
            var rows=db.queryForList("SELECT id FROM sample FORCE INDEX(ix_placed) WHERE customer_id=42 ORDER BY placed_at DESC LIMIT 20",Integer.class);
            assertThat(rows).hasSize(20);
        });
        assertThat(counts.handlerReads()).isGreaterThan(900);
        assertThatThrownBy(()->assertThat(counts.handlerReads()).isLessThan(100)).isInstanceOf(AssertionError.class);
    }
    @Test void selectiveIndexPassesTheSameBudgetWithRealResults() {
        var jdbc=scanRows();var counts=MySqlSessionMetrics.measure(jdbc,db->{
            var rows=db.queryForList("SELECT id FROM sample FORCE INDEX(ix_customer) WHERE customer_id=42 ORDER BY placed_at DESC LIMIT 20",Integer.class);
            assertThat(rows).hasSize(20);
        });assertThat(counts.handlerReads()).isLessThan(100);
    }
    @Test void questionsExcludesTheSamplingStatement() {
        var jdbc=new JdbcTemplate(FixtureDatabase.primary());
        var counts=MySqlSessionMetrics.measure(jdbc,db->{for(int i=0;i<3;i++)assertThat(db.queryForObject("SELECT 1",Integer.class)).isEqualTo(1);});
        assertThat(counts.questions()).isEqualTo(3);
    }
}
