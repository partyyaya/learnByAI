package review;

import org.flywaydb.core.Flyway;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import java.sql.*;
import java.nio.charset.StandardCharsets;
import java.io.IOException;

/** Disposable Docker endpoints only; never defaults to the user's local database. */
public final class FixtureDatabase {
    public static final String ROOT_USER = "root";
    public static final String ROOT_PASSWORD = "review-only";
    private static boolean migrated;
    private FixtureDatabase() {}
    public static String primaryUrl() { return required("MYSQL_PRIMARY_URL"); }
    public static String replicaUrl() { return required("MYSQL_REPLICA_URL"); }
    public static String primaryUrlWithCredentials() { return primaryUrl()+"&user=root&password=review-only"; }
    public static String replicaUrlWithCredentials() { return replicaUrl()+"&user=root&password=review-only"; }
    static String required(String key) {
        String value=System.getenv(key);
        if(value==null)throw new IllegalStateException("Run verification/run.sh; missing "+key);
        return value;
    }
    public static DriverManagerDataSource primary() { return new DriverManagerDataSource(primaryUrl(),ROOT_USER,ROOT_PASSWORD); }
    public static DriverManagerDataSource replica() { return new DriverManagerDataSource(replicaUrl(),ROOT_USER,ROOT_PASSWORD); }
    public static DriverManagerDataSource schema(String name) {
        if(!name.matches("[a-z][a-z0-9_]*"))throw new IllegalArgumentException(name);
        new JdbcTemplate(primary()).execute("CREATE DATABASE IF NOT EXISTS "+name);
        return new DriverManagerDataSource(primaryUrl().replace("/shop?","/"+name+"?"),ROOT_USER,ROOT_PASSWORD);
    }
    public static synchronized void migrateShop() {
        if(!migrated){Flyway.configure().dataSource(primary()).locations("classpath:db/migration").load().migrate();migrated=true;}
    }
    public static JdbcTemplate probeJdbc() {
        migrateShop();var jdbc=new JdbcTemplate(primary());
        jdbc.execute("CREATE USER IF NOT EXISTS 'shop_probe'@'%' IDENTIFIED BY 'probe-only'");
        jdbc.execute("GRANT SELECT,INSERT,UPDATE,DELETE,CREATE TEMPORARY TABLES ON shop.* TO 'shop_probe'@'%'");
        return new JdbcTemplate(new DriverManagerDataSource(primaryUrl(),"shop_probe","probe-only"));
    }
    public static TransactionTemplate tx(DriverManagerDataSource ds){return new TransactionTemplate(new DataSourceTransactionManager(ds));}
    public static String resource(String name) {
        try(var stream=FixtureDatabase.class.getResourceAsStream("/"+name)){
            if(stream==null)throw new IllegalArgumentException(name);
            return new String(stream.readAllBytes(),StandardCharsets.UTF_8);
        }catch(IOException e){throw new IllegalStateException(e);}
    }
    public static void awaitReplica() {
        var p=new JdbcTemplate(primary());var r=new JdbcTemplate(replica());
        String gtid=p.queryForObject("SELECT @@GLOBAL.gtid_executed",String.class);
        Integer result=r.queryForObject("SELECT WAIT_FOR_EXECUTED_GTID_SET(?,10)",Integer.class,gtid);
        if(result==null||result!=0)throw new IllegalStateException("Replica did not catch up");
    }
}
