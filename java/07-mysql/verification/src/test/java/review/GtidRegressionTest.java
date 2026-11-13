package review;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import static org.assertj.core.api.Assertions.*;

class GtidRegressionTest {
    static String runExample()throws Exception {
        var captured=new ByteArrayOutputStream();var old=System.out;
        try {System.setOut(new PrintStream(captured,true,StandardCharsets.UTF_8));ReadYourWritesFixed.main(new String[]{"1"});}
        finally {System.setOut(old);}
        String output=captured.toString(StandardCharsets.UTF_8);System.out.println(output);return output;
    }
    static void prepare() {
        FixtureDatabase.migrateShop();
        new JdbcTemplate(FixtureDatabase.primary()).execute("CREATE TABLE IF NOT EXISTS ord(id bigint AUTO_INCREMENT PRIMARY KEY,order_no varchar(100),amount decimal(19,4),status varchar(20),placed_at datetime(3))");
        FixtureDatabase.awaitReplica();
    }
    @Test void successfulWaitReadsTheActualReplica()throws Exception {
        prepare();String output=runExample();
        assertThat(output).containsPattern("讀到了\\s+1").containsPattern("讀不到\\s+0").contains("改讀主庫 0 次");
    }
    @Test void pausedReplicaTimesOutAndReadsThePrimary()throws Exception {
        prepare();var replica=new JdbcTemplate(FixtureDatabase.replica());
        replica.execute("STOP REPLICA SQL_THREAD");
        try {
            String output=runExample();
            assertThat(output).containsPattern("等待逾時\\s+1").contains("改讀主庫 1 次").containsPattern("讀不到\\s+0");
        } finally {replica.execute("START REPLICA SQL_THREAD");FixtureDatabase.awaitReplica();}
    }
}
