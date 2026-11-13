package review;

import lab7.rw.*;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.*;
import org.springframework.core.env.MapPropertySource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import javax.sql.DataSource;
import java.util.Map;
import static org.assertj.core.api.Assertions.*;

class RoutingRegressionTest {
    @Configuration(proxyBeanMethods=false)
    @EnableAspectJAutoProxy(proxyTargetClass=true)
    @Import(ReadWriteSplitConfig.class)
    static class ApplicationFixture {
        @Bean ReadPort readPort(DataSource dataSource) { return new ReadPort(new JdbcTemplate(dataSource)); }
    }
    public static class ReadPort {
        final JdbcTemplate jdbc;
        ReadPort(JdbcTemplate jdbc) { this.jdbc=jdbc; }
        @ReadFromReplica(maxLagMillis=1000)
        public int port() { return jdbc.queryForObject("SELECT @@port",Integer.class); }
    }
    static void heartbeat(boolean replica,int secondsAgo) {
        var ds=replica?FixtureDatabase.replica():FixtureDatabase.primary();
        try(var c=ds.getConnection();var st=c.createStatement()) {
            if(replica){st.execute("SET GLOBAL super_read_only=OFF");st.execute("SET GLOBAL read_only=OFF");}
            try {
                st.execute("CREATE DATABASE IF NOT EXISTS ops");
                st.execute("CREATE TABLE IF NOT EXISTS ops.heartbeat(id int PRIMARY KEY,ts datetime(6))");
                st.execute("REPLACE INTO ops.heartbeat VALUES(1,NOW(6)-INTERVAL "+secondsAgo+" SECOND)");
            } finally { if(replica)st.execute("SET GLOBAL super_read_only=ON"); }
        } catch(Exception e){throw new IllegalStateException(e);}
    }
    @Test void actualMonitorUsesNativeReplicaAndLagRoutesBackToPrimary() {
        FixtureDatabase.migrateShop();heartbeat(false,0);heartbeat(true,5);
        try(var ctx=new AnnotationConfigApplicationContext()) {
            ctx.getEnvironment().getPropertySources().addFirst(new MapPropertySource("fixture",Map.of(
                    "db.primary.url",FixtureDatabase.primaryUrl(),"db.primary.user","root","db.primary.password","review-only",
                    "db.replica.url",FixtureDatabase.replicaUrl(),"db.replica.user","root","db.replica.password","review-only")));
            ctx.register(ApplicationFixture.class);ctx.refresh();
            var monitor=ctx.getBean(ReplicaLagMonitor.class);
            var nativeJdbc=(JdbcTemplate)ReflectionTestUtils.getField(monitor,"replicaJdbc");
            assertThat(nativeJdbc.getDataSource()).isSameAs(ctx.getBean("replicaDataSource"));
            assertThat(nativeJdbc.getDataSource()).isNotSameAs(ctx.getBean("dataSource"));
            monitor.refresh();assertThat(monitor.currentLagMillis()).isGreaterThanOrEqualTo(4000);
            assertThat(ctx.getBean(ReadPort.class).port()).isEqualTo(3306);
            heartbeat(true,0);monitor.refresh();
            assertThat(ctx.getBean(ReadPort.class).port()).isEqualTo(3307);
            assertThat(DbRoleContext.current()).isEqualTo(DbRole.PRIMARY);
        }
    }
}
