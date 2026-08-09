import assert from 'node:assert/strict';
import test from 'node:test';

import { invariantSql, permissionSql, validateDatabaseTarget } from './verify-database.mjs';

test('database verifier permits only the named local SettleFlow target', () => {
  assert.deepEqual(
    validateDatabaseTarget({
      POSTGRES_APP_USER: 'settleflow_app',
      POSTGRES_DB: 'settleflow',
      POSTGRES_USER: 'settleflow_owner',
    }),
    { appUser: 'settleflow_app', database: 'settleflow', owner: 'settleflow_owner' },
  );
  assert.throws(
    () =>
      validateDatabaseTarget({
        POSTGRES_APP_USER: 'settleflow_app',
        POSTGRES_DB: 'production',
        POSTGRES_USER: 'owner',
      }),
    /exactly settleflow/u,
  );
});

test('database checks are read-only SELECT verifiers', () => {
  for (const sql of [invariantSql(), permissionSql()]) {
    assert.match(sql, /SELECT/iu);
    assert.doesNotMatch(sql, /\b(?:DELETE|INSERT|TRUNCATE|UPDATE)\s+(?:INTO|FROM|TABLE|[a-z_])/iu);
  }
});
