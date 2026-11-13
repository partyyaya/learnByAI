#!/usr/bin/env python3
"""Run the chapter's DDL and state SQL on disposable MySQL 8; no published ports."""
from pathlib import Path
import json
import re
import subprocess
import time

HERE = Path(__file__).resolve().parent
blocks = json.loads((HERE/'target/sql.json').read_text())
def statement(fragment):
    statements = [re.sub(r'(?m)^\s*--.*$', '', part).strip()
                  for block in blocks for part in block.split(';')]
    return next(part for part in statements if fragment in part)

def bind(source, *values):
    for value in values:
        literal = str(value) if isinstance(value,int) else "'"+value.replace("'","''")+"'"
        source = source.replace('?',literal,1)
    assert '?' not in source, source
    return source+';'

def docker(*args, input=None, check=True):
    return subprocess.run(['docker',*args],input=input,text=True,capture_output=True,check=check)

container = docker('run','--rm','-d','--network','none','--tmpfs','/var/lib/mysql',
                   '-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','mysql:8.0').stdout.strip()
try:
    # Ping must succeed against the final server, not the entrypoint's initialization server.
    for _ in range(90):
        ready = docker('exec',container,'mysql','-uroot','--batch','--skip-column-names',
                       '-e',"SELECT @@port, @@skip_networking",check=False)
        if ready.returncode==0 and ready.stdout.strip().endswith('\t0'):
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('MySQL did not become ready')
    docker('exec',container,'mysql','-uroot','-e','CREATE DATABASE course')
    def sql(source):
        return docker('exec','-i',container,'mysql','-uroot','--batch','--skip-column-names','course',input=source).stdout.strip()
    sql(statement('CREATE TABLE outbox_stream')+';'+statement('CREATE TABLE outbox (')+';')
    def put(id,aggregate,status='PENDING',attempts=0):
        sql(f"INSERT INTO outbox_stream VALUES ('{aggregate}') ON DUPLICATE KEY UPDATE aggregate_id=VALUES(aggregate_id);"
            f"INSERT INTO outbox(id,message_id,type,aggregate_id,payload,status,attempts,next_attempt_at,created_at) "
            f"VALUES ({id},'m-{id}','ORDER_PLACED','{aggregate}','{{}}','{status}',{attempts},'2026-11-09 00:00:00','2026-11-08 00:00:00');")
    now='2026-11-09 00:00:00.000'
    lease='2026-11-09 00:05:00.000'
    claim=statement('attempts = attempts + 1, claim_token')
    sent=statement("SET status = 'SENT', sent_at")
    retry=statement("SET status = 'PENDING', next_attempt_at")
    reclaim=statement('SET status = CASE WHEN attempts')
    due=statement('SELECT o.id FROM outbox o')
    put(1,'O1')
    assert sql(bind(claim,'token-1',lease,1,now)+'SELECT ROW_COUNT();')=='1'
    assert sql(bind(reclaim,3,now,now)+'SELECT ROW_COUNT();')=='0'  # created_at is old; lease is still current
    later='2026-11-09 00:01:00.000'
    assert sql(bind(retry,later,'failure',1,'token-1',now)+'SELECT ROW_COUNT();')=='1'
    assert sql(bind(claim,'too-early',lease,1,now)+'SELECT ROW_COUNT();')=='0'
    assert sql(bind(claim,'token-2',lease,1,later)+'SELECT ROW_COUNT();')=='1'
    assert sql(bind(sent,later,1,'token-1',later)+'SELECT ROW_COUNT();')=='0'
    assert sql(bind(sent,later,1,'token-2',later)+'SELECT ROW_COUNT();')=='1'
    put(100,'blocked','DEAD',3);put(101,'blocked');put(201,'free')
    assert sql(bind(due,now,50))=='201'
    put(300,'crash','PENDING',2)
    assert sql(bind(claim,'third',lease,300,now)+'SELECT ROW_COUNT();')=='1'
    assert sql(bind(reclaim,3,lease,lease)+'SELECT ROW_COUNT();')=='1'
    assert sql('SELECT status FROM outbox WHERE id=300;')=='DEAD'
    print('PASS: MySQL 8 DDL, lease time, due-time recheck, stale token, DEAD ordering and crash attempt limit.')
finally:
    docker('rm','-f',container,check=False)
