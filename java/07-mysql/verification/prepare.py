#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Extract current course sources. Only lifecycle/endpoint scaffolding is replaced."""
from pathlib import Path
import re,shutil
here=Path(__file__).resolve().parent
out=here/'target/course-tests';res=here/'target/course-resources';scripts=here/'target/scripts'
for folder in [out,res,scripts]:
 if folder.exists():shutil.rmtree(folder)
shutil.copytree(here/'src/test/java',out);shutil.copytree(here/'src/test/resources',res)
blocks=[]
for p in sorted(here.parent.glob('[0-9][0-9]-*.md')):
 for m in re.finditer(r'^```([^\n]*)\n(.*?)^```\s*$',p.read_text(),re.M|re.S):
  blocks.append((p.name[:2],m[1],m[2]))
def block(ch,needle,lang=None):
 found=[text for c,l,text in blocks if c==ch and needle in text and (lang is None or l==lang)]
 assert found,(ch,needle)
 return found[0]
def emit(source):
 pkg=re.search(r'^package ([\w.]+);',source,re.M).group(1)
 name=re.search(r'^public (?:final |abstract )*(?:class|record|enum|@interface) (\w+)',source,re.M).group(1)
 p=out/pkg.replace('.','/')/(name+'.java');p.parent.mkdir(parents=True,exist_ok=True);p.write_text(source)
def method(source,signature):
 start=source.index(signature);brace=source.index('{',start);depth=1;end=brace+1
 while depth:
  if source[end]=='{':depth+=1
  elif source[end]=='}':depth-=1
  end+=1
 return source[start:end]
for needle in ['public enum DbRole {','public final class DbRoleContext','public class RoutingDataSource','public @interface ReadFromReplica','public class DbRoleAspect','public class ReplicaLagMonitor','public class ReadWriteSplitConfig']:
 emit(block('07',needle,'java'))
for ch,needle in [('06','public class SecondaryFlywayConfig'),('06','public final class SchemaFingerprint'),('05','public final class VersionedBatchCounts'),('05','public final class MySqlSessionMetrics')]:emit(block(ch,needle,'java'))
# Real GTID example. Replace connection constants only; preserve the complete control flow.
gtid=block('07','public class ReadYourWritesFixed','java')
gtid=re.sub(r'(static final String M = )"[^"]+"',r'\1FixtureDatabase.primaryUrlWithCredentials()',gtid)
gtid=re.sub(r'(static final String R = )"[^"]+"',r'\1FixtureDatabase.replicaUrlWithCredentials()',gtid)
emit('package review;\nimport java.sql.*;\n'+gtid)
# Compile and run the same four MigrationTest methods, using external Docker endpoints.
migration=block('06','class MigrationTest {','java').replace('@Testcontainers\n','')
a=migration.index('    @Container');b=migration.index('    private Flyway flyway(',a)
migration=migration[:a]+'''    static final FixtureEndpoint MYSQL = new FixtureEndpoint();
    static class FixtureEndpoint {
        String getJdbcUrl() { return review.FixtureDatabase.primaryUrl(); }
        String getUsername() { return review.FixtureDatabase.ROOT_USER; }
        String getPassword() { return review.FixtureDatabase.ROOT_PASSWORD; }
    }

'''+migration[b:]
p=out/'com/example/shop/migration/MigrationTest.java';p.parent.mkdir(parents=True,exist_ok=True);p.write_text(migration)
# Four actual DB timezone methods; omit the unrelated BusinessClock placeholder assertion.
timezone=block('00','class TimeZoneContractTest','java')
methods=[]
for signature in ['void 伺服器時區是_UTC()','void 連線的_session_時區被強制成_UTC()','void 應用寫入的時間與資料庫的_NOW_落在同一個時間軸()','void DATETIME_欄位存的是_UTC_的字面值()']:
 methods.append('@org.junit.jupiter.api.Test\n'+method(timezone,signature))
emit('''package review;
import java.sql.Timestamp;import java.time.Instant;
import org.springframework.jdbc.core.JdbcTemplate;
import static org.assertj.core.api.Assertions.assertThat;
public class TimezoneRegressionTest {
 final JdbcTemplate jdbc=FixtureDatabase.probeJdbc();
'''+ '\n'.join(methods)+'\n}')
# Compiles the actual bounded backfill loop as well as testing its extracted SQL.
backfill=block('06','ps.setLong(2, next);','java')
emit('package review;\nimport java.sql.*;\npublic class BackfillExample {\n public static void run(Connection c,int size)throws SQLException {\n'+backfill+'\n}\n}')
res.mkdir(parents=True,exist_ok=True)
(res/'db/migration/V1__canonical_schema.sql').write_text(block('01','-- shop-service schema  v1','sql'))
(res/'redundant.sql').write_text(block('03','WITH idx AS (','sql'))
reserve=block('04','public class PlaceOrderService','java')
(res/'reserve.sql').write_text(re.search(r'"""\s*(UPDATE stock.*?)"""',reserve,re.S).group(1))
outbox=block('04',"SET status = 'PUBLISHED', published_at",'sql')
(res/'publish.sql').write_text(re.search(r'UPDATE outbox_message.*?;',outbox,re.S).group())
(res/'backfill.sql').write_text(re.search(r'"(UPDATE ord SET note.*?)"',backfill).group(1))
(res/'pitr-command.sh').write_text(block('07','--exclude-gtids="$UUID:87682"','bash'))
for ch,marker,path in [('06','# ci/dump-golden-schema.sh','ci/dump-golden-schema.sh'),('07','# ops/backup-mysql.sh','ops/backup-mysql.sh'),('07','# ops/verify-restored-mysql.sh','ops/verify-restored-mysql.sh'),('07','# ops/restore-drill.sh','ops/restore-drill.sh')]:
 p=scripts/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(block(ch,marker,'bash'));p.chmod(0o755)
print('Extracted current Java, SQL and shell examples into verification/target')
