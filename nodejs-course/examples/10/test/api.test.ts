import { beforeEach, afterEach } from '@jest/globals';
import { once } from 'node:events';
import { createArticleServer } from '../src/server.js';
import { articleContract } from './api-contract.js';
let server: ReturnType<typeof createArticleServer>;
beforeEach(async () => { server = createArticleServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); });
afterEach(async () => { await server.lifecycle.shutdown(); });
articleContract(() => server);
