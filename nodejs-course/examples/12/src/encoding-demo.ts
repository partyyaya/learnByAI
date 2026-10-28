import { StringDecoder } from 'node:string_decoder';

const text = '中🙂';
const bytes = Buffer.from(text, 'utf8');
const first = bytes.subarray(0, 2);
const second = bytes.subarray(2);
const decoder = new StringDecoder('utf8');
const decoded = decoder.write(first) + decoder.write(second) + decoder.end();
console.log(JSON.stringify({ text, utf16Units: text.length, codePoints: [...text].length, bytes: bytes.length,
  naive: first.toString('utf8') + second.toString('utf8'), decoded }, null, 2));
