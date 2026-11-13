package review;

import com.example.shop.config.SecondaryFlywayConfig;
import com.example.shop.migration.SchemaFingerprint;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.*;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import java.sql.Connection;
import java.util.Map;
import javax.sql.DataSource;
import static org.assertj.core.api.Assertions.*;

class MigrationRegressionTest {
    @Configuration(proxyBeanMethods=false) static class ApplicationFixture {
        @Bean @Primary DataSource applicationDataSource(){return FixtureDatabase.primary();}
        @Bean Object priorDependency(){return new Object();}
        @Bean @DependsOn("priorDependency") Object entityManagerFactory(){return new Object();}
        @Bean Object reportEntityManagerFactory(){return new Object();}
    }
    @Test void bothCustomFlywaysMigrateAndEachEmfKeepsItsDependencies() {
        var main=FixtureDatabase.schema("dual_primary");var report=FixtureDatabase.schema("dual_report");
        new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(FlywayAutoConfiguration.class))
                .withUserConfiguration(ApplicationFixture.class,SecondaryFlywayConfig.class)
                .withPropertyValues("app.flyway.primary.url="+main.getUrl(),"app.flyway.primary.user=root","app.flyway.primary.password=review-only",
                        "app.flyway.report.url="+report.getUrl(),"app.flyway.report.user=root","app.flyway.report.password=review-only")
                .run(ctx->{
                    assertThat(ctx).hasNotFailed();assertThat(ctx.getBeansOfType(Flyway.class)).containsOnlyKeys("primaryFlyway","reportFlyway");
                    assertThat(new JdbcTemplate(main).queryForObject("SELECT COUNT(*) FROM flyway_schema_history WHERE success=1",Integer.class)).isEqualTo(3);
                    assertThat(new JdbcTemplate(report).queryForObject("SELECT label FROM report_marker WHERE id=1",String.class)).isEqualTo("report migrated");
                    var bf=ctx.getSourceApplicationContext().getBeanFactory();
                    assertThat(bf.getBeanDefinition("entityManagerFactory").getDependsOn()).contains("primaryFlyway","priorDependency");
                    assertThat(bf.getBeanDefinition("reportEntityManagerFactory").getDependsOn()).contains("reportFlyway");
                });
    }
    static String fingerprint(DriverManagerDataSource ds)throws Exception {
        try(Connection c=ds.getConnection()){return SchemaFingerprint.read(c);}
    }
    static DriverManagerDataSource fixture(String schema) {
        var ds=FixtureDatabase.schema(schema);var jdbc=new JdbcTemplate(ds);
        jdbc.execute("DROP TABLE IF EXISTS child");jdbc.execute("DROP TABLE IF EXISTS parent");
        jdbc.execute("CREATE TABLE parent(id int PRIMARY KEY)");
        jdbc.execute("CREATE TABLE child(id int PRIMARY KEY,parent_id int,qty int,INDEX ix_parent(parent_id),CONSTRAINT fk_child FOREIGN KEY(parent_id) REFERENCES parent(id),CONSTRAINT ck_qty CHECK(qty>=0))");
        return ds;
    }
    @Test void identicalSchemasWithSelfReferencesHaveIdenticalFingerprints()throws Exception {
        assertThat(fingerprint(fixture("fingerprint_a"))).isEqualTo(fingerprint(fixture("fingerprint_b")));
    }
    @Test void missingCheckChangesFingerprintEvenWhenColumnsAndIndexesAreUnchanged()throws Exception {
        var ds=fixture("fingerprint_check");String before=fingerprint(ds);
        new JdbcTemplate(ds).execute("ALTER TABLE child DROP CHECK ck_qty");assertThat(fingerprint(ds)).isNotEqualTo(before);
    }
    @Test void missingFkChangesFingerprintEvenWhenItsIndexRemains()throws Exception {
        var ds=fixture("fingerprint_fk");String before=fingerprint(ds);
        new JdbcTemplate(ds).execute("ALTER TABLE child DROP FOREIGN KEY fk_child");assertThat(fingerprint(ds)).isNotEqualTo(before);
    }
    @Test void changedReferentialActionChangesFingerprint()throws Exception {
        var ds=fixture("fingerprint_action");String before=fingerprint(ds);
        new JdbcTemplate(ds).execute("ALTER TABLE child DROP FOREIGN KEY fk_child");
        new JdbcTemplate(ds).execute("ALTER TABLE child ADD CONSTRAINT fk_child FOREIGN KEY(parent_id) REFERENCES parent(id) ON DELETE CASCADE");
        assertThat(fingerprint(ds)).isNotEqualTo(before);
    }
}
