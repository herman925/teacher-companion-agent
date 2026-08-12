// store-contract-json.test.mjs — the store contract, against the JSON tier.
//
// This runner exists so the contract is exercised on EVERY gate run today,
// long before pg-store lands: a suite that only runs when someone remembers to
// point it at a database is a suite that rots. Its sibling
// (store-contract-pg.test.mjs, later) will pass the same factory a Postgres
// store and `{ skip: !process.env.DATABASE_URL }`.
//
// Each run gets its own temp directory, so this file never touches demo/.data
// and never sees another test's rows.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createJsonStore } from '../src/store/json-store.mjs';
import { runStoreContract } from './store-contract.test.mjs';

runStoreContract('json-store', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'cst-contract-json-'));
  return {
    store: createJsonStore({ baseDir }),
    // The contract erases its own users first; this only removes the empty
    // shell it worked in. A temp directory is the JSON tier's equivalent of a
    // throwaway schema — the contract itself knows nothing about either.
    dispose: () => rm(baseDir, { recursive: true, force: true }),
  };
});
