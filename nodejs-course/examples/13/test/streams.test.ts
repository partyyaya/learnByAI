import { describe, expect, test } from '@jest/globals';
import { StringDecoder } from 'node:string_decoder';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

describe('Buffer 與背壓', () => {
  test('字串長度不是 UTF-8 byte 長度，跨 chunk 解碼需要保留狀態', () => {
    const text = '中🙂';
    const data = Buffer.from(text);
    expect(text.length).toBe(3);
    expect([...text]).toHaveLength(2);
    expect(data.length).toBe(7);
    expect(data.subarray(0, 2).toString() + data.subarray(2).toString()).not.toBe(text);
    const decoder = new StringDecoder('utf8');
    expect(decoder.write(data.subarray(0, 2)) + decoder.write(data.subarray(2)) + decoder.end()).toBe(text);
  });

  test('慢速 writable 未完成第一筆時，來源不會全部產生完', async () => {
    let produced = 0;
    let consumed = 0;
    let release!: () => void;
    let notify!: () => void;
    const firstWrite = new Promise<void>(resolve => { notify = resolve; });
    function* chunks() {
      for (let index = 0; index < 1000; index++) { produced++; yield Buffer.alloc(1024); }
    }
    const source = Readable.from(chunks(), { objectMode: false, highWaterMark: 2048 });
    const sink = new Writable({ highWaterMark: 1024, write(_chunk, _encoding, callback) {
      consumed++;
      if (consumed === 1) { release = () => callback(); notify(); }
      else setImmediate(callback);
    } });
    const work = pipeline(source, sink);
    await firstWrite;
    const producedWhileBlocked = produced;
    release();
    await work;
    expect(producedWhileBlocked).toBeLessThan(1000);
    expect(consumed).toBe(1000);
  });

  test('寫入端失敗時，pipeline 會拒絕並破壞來源', async () => {
    const source = Readable.from([Buffer.from('data')]);
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('disk failed')); } });
    await expect(pipeline(source, sink)).rejects.toThrow('disk failed');
    expect(source.destroyed).toBe(true);
    expect(sink.destroyed).toBe(true);
  });
});
