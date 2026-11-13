#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Run the extracted operations scripts against disposable Docker databases."""
from pathlib import Path
import os,subprocess,tempfile,unittest

HERE=Path(__file__).resolve().parent
TARGET=HERE/'target';SCRIPTS=TARGET/'scripts'
PRIMARY=os.environ['VERIFY_PRIMARY_CONTAINER']
PASSWORD='review-only'

def run(args,**kwargs):
    return subprocess.run([str(a) for a in args],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
def sql(query):
    result=run(['docker','exec','-e','MYSQL_PWD='+PASSWORD,PRIMARY,'mysql','-uroot','--batch','--skip-column-names','shop','-e',query])
    if result.returncode:raise RuntimeError(result.stderr)
    return result.stdout.strip()

def object_ddl(kind,value):
    if kind=='view':return f'CREATE OR REPLACE VIEW inspection_view AS SELECT {value} AS x'
    if kind=='routine':return f'DROP PROCEDURE IF EXISTS inspection_routine; CREATE PROCEDURE inspection_routine() SELECT {value} AS x'
    if kind=='trigger':return f'DROP TRIGGER IF EXISTS inspection_trigger; CREATE TRIGGER inspection_trigger BEFORE UPDATE ON stock FOR EACH ROW SET NEW.version=NEW.version+{value-1}'
    if kind=='event':return f"DROP EVENT IF EXISTS inspection_event; CREATE EVENT inspection_event ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00' DISABLE DO SELECT {value}"
    raise ValueError(kind)

class OperationsRegressionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder=TARGET/'shell-cases';cls.folder.mkdir(parents=True,exist_ok=True)
        cls.env=os.environ.copy()
        cls.env.update(DUMP_PASSWORD=PASSWORD,VERIFY_PASSWORD=PASSWORD,EXPECTED_ORDER_COUNT='1',EXPECTED_TABLE_COUNT='7',EXPECTED_SCHEMA_VERSION='3',
                       DUMP_SCHEMA_SCRIPT=str(SCRIPTS/'ci/dump-golden-schema.sh'),VERIFY_RESTORE_SCRIPT=str(SCRIPTS/'ops/verify-restored-mysql.sh'))
        sql("""
            DROP TABLE IF EXISTS ord;
            DELETE FROM outbox_message; DELETE FROM order_item; DELETE FROM orders;
            DELETE FROM address; DELETE FROM stock; DELETE FROM product; DELETE FROM customer;
            INSERT INTO customer(id,email,username,display_name,password_hash)
              VALUES(UNHEX(REPEAT('21',16)),'fixture@example.test','fixture','fixture','x');
            INSERT INTO product(id,sku,name,unit_price) VALUES(UNHEX(REPEAT('11',16)),'FIXTURE','product',10);
            INSERT INTO stock(product_id,qty,reserved_qty) VALUES(UNHEX(REPEAT('11',16)),10,0);
            INSERT INTO orders(id,order_no,customer_id,status,total_amount,placed_at)
              VALUES(UNHEX(REPEAT('31',16)),'FIXTURE',UNHEX(REPEAT('21',16)),'PAID',10,'2026-09-01');
            INSERT INTO order_item(id,order_id,product_id,product_name,unit_price,qty,line_amount)
              VALUES(UNHEX(REPEAT('41',16)),UNHEX(REPEAT('31',16)),UNHEX(REPEAT('11',16)),'product',10,1,10);
        """)
        for kind in ['view','routine','trigger','event']:sql(object_ddl(kind,1))
        cls.golden=cls.folder/'golden.sql';cls.golden.write_text(cls.dump())
        # Transport adapter: the original backup script invokes a real mysqldump
        # inside PRIMARY. It does not fabricate dump output or exit codes.
        adapter=cls.folder/'bin';adapter.mkdir(exist_ok=True)
        wrapper=adapter/'mysqldump';wrapper.write_text('''#!/usr/bin/env bash
set -euo pipefail
if [[ "${INJECT_DUMP_WARNING:-}" == 1 ]]; then echo 'Warning: verification injected an unknown warning' >&2; fi
exec docker exec -e MYSQL_PWD=review-only "$VERIFY_PRIMARY_CONTAINER" mysqldump "$@"
''');wrapper.chmod(0o755)
        cls.env['PATH']=str(adapter)+os.pathsep+cls.env['PATH']
        cls.env['GOLDEN']=str(cls.golden)

    @classmethod
    def dump(cls):
        result=run(['bash',SCRIPTS/'ci/dump-golden-schema.sh',PRIMARY,'shop'],env=cls.env)
        if result.returncode:raise RuntimeError(result.stderr)
        return result.stdout

    def verify(self,*,golden=None,extra=None):
        env=self.env.copy();env.update(extra or {})
        return run(['bash',SCRIPTS/'ops/verify-restored-mysql.sh',PRIMARY,'shop',golden or self.golden],env=env)

    def backup(self,directory,extra=None):
        env=self.env.copy();env.update(DB_HOST='127.0.0.1',BACKUP_USER='root',BACKUP_DIR=str(directory));env.update(extra or {})
        return run(['bash',SCRIPTS/'ops/backup-mysql.sh'],env=env)

    def test_dump_retains_each_executable_object_definition(self):
        for kind in ['view','routine','trigger','event']:
            with self.subTest(kind=kind):
                before=self.dump()
                try:
                    sql(object_ddl(kind,2));self.assertNotEqual(before,self.dump())
                finally:sql(object_ddl(kind,1))

    def test_dml_and_gtid_progress_do_not_change_golden_schema(self):
        before=self.dump()
        sql("INSERT INTO outbox_message(id,aggregate_id,event_type,payload) VALUES(UNHEX(REPEAT('51',16)),UNHEX(REPEAT('31',16)),'FIXTURE','{}')")
        try:self.assertEqual(before,self.dump());self.assertNotIn('GTID_PURGED',before);self.assertNotIn('flyway_schema_history',before)
        finally:sql("DELETE FROM outbox_message WHERE id=UNHEX(REPEAT('51',16))")

    def test_normal_single_database_gtid_backup_succeeds(self):
        with tempfile.TemporaryDirectory(dir=self.folder) as directory:
            result=self.backup(Path(directory));self.assertEqual(result.returncode,0,result.stderr)
            files=list(Path(directory).glob('*.sql.gz'));self.assertEqual(len(files),1)
            self.assertEqual(run(['gzip','-t',files[0]]).returncode,0)
            text=run(['gzip','-dc',files[0]]).stdout
            self.assertIn('CHANGE MASTER',text);self.assertNotIn('SET @@GLOBAL.GTID_PURGED',text)

    def test_unknown_dump_warning_is_still_rejected(self):
        with tempfile.TemporaryDirectory(dir=self.folder) as directory:
            result=self.backup(Path(directory),{'INJECT_DUMP_WARNING':'1'})
            self.assertNotEqual(result.returncode,0);self.assertNotIn('備份完成',result.stdout)

    def test_valid_data_and_schema_pass(self):
        result=self.verify();self.assertEqual(result.returncode,0,result.stderr+result.stdout)

    def test_mismatched_amount_fails_even_when_schema_matches(self):
        sql('UPDATE orders SET total_amount=99')
        try:
            result=self.verify();self.assertNotEqual(result.returncode,0);self.assertIn('明細和',result.stderr)
        finally:sql('UPDATE orders SET total_amount=10')

    def test_missing_details_fail(self):
        sql('DELETE FROM order_item')
        try:
            result=self.verify();self.assertNotEqual(result.returncode,0);self.assertIn('缺明細',result.stderr)
        finally:sql("INSERT INTO order_item(id,order_id,product_id,product_name,unit_price,qty,line_amount) VALUES(UNHEX(REPEAT('41',16)),UNHEX(REPEAT('31',16)),UNHEX(REPEAT('11',16)),'product',10,1,10)")

    def test_schema_mismatch_fails(self):
        wrong=self.folder/'wrong-golden.sql';wrong.write_text('-- deliberately different\n')
        result=self.verify(golden=wrong);self.assertNotEqual(result.returncode,0);self.assertIn('schema',result.stderr)

    def test_latest_version_is_by_installed_rank(self):
        sql("""INSERT INTO flyway_schema_history(installed_rank,version,description,type,script,installed_by,execution_time,success)
             VALUES(99,'9','fixture','SQL','V9.sql','fixture',0,1),(100,'10','fixture','SQL','V10.sql','fixture',0,1)""")
        try:
            result=self.verify(extra={'EXPECTED_SCHEMA_VERSION':'10'});self.assertEqual(result.returncode,0,result.stderr+result.stdout)
        finally:sql('DELETE FROM flyway_schema_history WHERE installed_rank IN(99,100)')

    def test_real_restore_drill_completes(self):
        with tempfile.TemporaryDirectory(dir=self.folder) as directory:
            result=self.backup(Path(directory));self.assertEqual(result.returncode,0,result.stderr)
            backup=next(Path(directory).glob('*.sql.gz'))
            env=self.env.copy();env['RESTORE_REPORT']=str(Path(directory)/'restore.txt')
            result=run(['bash',SCRIPTS/'ops/restore-drill.sh',backup],env=env,timeout=120)
            self.assertEqual(result.returncode,0,result.stderr+result.stdout);self.assertIn('演練成功',result.stdout)

    def test_real_restore_of_bad_data_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory(dir=self.folder) as directory:
            sql('UPDATE orders SET total_amount=99')
            try:result=self.backup(Path(directory))
            finally:sql('UPDATE orders SET total_amount=10')
            self.assertEqual(result.returncode,0,result.stderr)
            backup=next(Path(directory).glob('*.sql.gz'))
            env=self.env.copy();env['RESTORE_REPORT']=str(Path(directory)/'restore.txt')
            result=run(['bash',SCRIPTS/'ops/restore-drill.sh',backup],env=env,timeout=120)
            self.assertNotEqual(result.returncode,0);self.assertNotIn('演練成功',result.stdout)

    def test_pitr_command_has_no_empty_or_whitespace_filename_arguments(self):
        body=(TARGET/'course-resources/pitr-command.sh').read_text()
        with tempfile.TemporaryDirectory(dir=self.folder) as directory:
            output=Path(directory)/'pitr_replay.sql'
            body=body.replace('/tmp/pitr_replay.sql',str(output))
            script=Path(directory)/'argv.sh';script.write_text("docker(){ printf '%s\\n' \"$@\"; }\n"+body)
            result=run(['bash',script]);self.assertEqual(result.returncode,0,result.stderr)
            args=output.read_text().splitlines()
            self.assertTrue(all(arg and arg.strip()==arg for arg in args),args)
            self.assertEqual(args[-1],'binlog.000004');self.assertTrue(any(arg.startswith('--exclude-gtids=') for arg in args))

if __name__=='__main__':unittest.main(verbosity=2)
