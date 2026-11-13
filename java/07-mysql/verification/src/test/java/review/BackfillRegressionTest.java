package review;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import static org.assertj.core.api.Assertions.*;
class BackfillRegressionTest {
    static org.springframework.jdbc.datasource.DriverManagerDataSource fixture() {
        var ds=FixtureDatabase.schema("bounded_backfill");var jdbc=new JdbcTemplate(ds);
        jdbc.execute("DROP TABLE IF EXISTS ord");jdbc.execute("CREATE TABLE ord(id int PRIMARY KEY,remark varchar(30),note varchar(30))");
        for(int i=1;i<=8;i++)jdbc.update("INSERT INTO ord VALUES(?,'original',?)",i,i<=6?"done":null);
        return ds;
    }
    @Test void computedUpperBoundActuallyRestrictsOneBatch() {
        var jdbc=new JdbcTemplate(fixture());
        long upper=jdbc.queryForObject("SELECT MAX(id) FROM (SELECT id FROM ord WHERE id>0 ORDER BY id LIMIT 2) x",Long.class);
        assertThat(upper).isEqualTo(2);
        assertThat(jdbc.update(FixtureDatabase.resource("backfill.sql"),0,upper)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ord WHERE id IN (7,8) AND note IS NULL",Integer.class)).isEqualTo(2);
    }
    @Test void actualLoopAdvancesAcrossAlreadyFilledBatchesAndEventuallyFinishes()throws Exception {
        var ds=fixture();try(var c=ds.getConnection()){BackfillExample.run(c,2);}
        var jdbc=new JdbcTemplate(ds);assertThat(jdbc.queryForList("SELECT id FROM ord WHERE note='original' ORDER BY id",Integer.class)).containsExactly(7,8);
    }
}
