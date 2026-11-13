package review;
import org.junit.jupiter.api.Test;import org.flywaydb.core.Flyway;import java.nio.file.*;import static org.assertj.core.api.Assertions.*;
class MigrationTest {
 @Test void appendMigrationsSupportFreshLegacyAndPartiallyUpgradedSchemas()throws Exception{
  var j=DatabaseFixTest.jdbc();j.update("DELETE FROM idempotency_keys");j.update("DELETE FROM payments");
  Path dir=Path.of("target/upgrade-migrations");Files.createDirectories(dir);for(int v=26;v<=28;v++)Files.copy(Path.of("target/V"+v+".sql"),dir.resolve("V"+v+"__upgrade.sql"),StandardCopyOption.REPLACE_EXISTING);
  for(int mode=0;mode<3;mode++){
   if(mode>0)j.execute("ALTER TABLE notifications DROP COLUMN claim_token");if(mode==1)j.execute("ALTER TABLE notifications DROP COLUMN claimed_until");
   j.execute("ALTER TABLE idempotency_keys MODIFY idem_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL");
   j.execute("ALTER TABLE payments MODIFY provider_txn_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL");
   j.update("INSERT INTO idempotency_keys(buyer_id,idem_key,request_hash,expires_at) VALUES(73001,'Existing',REPEAT('a',64),NOW()+INTERVAL 1 DAY) ON DUPLICATE KEY UPDATE idem_key=idem_key");
   var flyway=Flyway.configure().dataSource(DatabaseFixTest.ds()).locations("filesystem:"+dir.toAbsolutePath()).table("upgrade_history_"+mode).baselineOnMigrate(true).baselineVersion("25").load();assertThat(flyway.migrate().migrationsExecuted).isEqualTo(3);assertThat(flyway.migrate().migrationsExecuted).isZero();
   assertThat(j.queryForObject("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='notifications' AND column_name IN ('claim_token','claimed_until')",Integer.class)).isEqualTo(2);
   assertThat(j.queryForObject("SELECT collation_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='idempotency_keys' AND column_name='idem_key'",String.class)).isEqualTo("utf8mb4_0900_bin");
   assertThat(j.queryForObject("SELECT collation_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='payments' AND column_name='provider_txn_id'",String.class)).isEqualTo("utf8mb4_0900_bin");
   assertThat(j.queryForObject("SELECT COUNT(*) FROM idempotency_keys WHERE buyer_id=73001 AND idem_key='Existing'",Integer.class)).isEqualTo(1);
  }
 }
}
