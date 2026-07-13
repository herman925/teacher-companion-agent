// callWithFailover terminal error — both directions: when NO provider could
// even be attempted (no keys anywhere) the message must say so and point at
// settings; when providers WERE attempted and failed, the message must list
// them and the error must carry the per-provider chain the UI renders as
// 失败详情. No network is reached in the no-keys case; the attempted case
// targets an unroutable local port so it fails fast and offline.

import test from 'node:test';
import assert from 'node:assert/strict';

import { callWithFailover, AdapterError } from '../src/adapter.mjs';

const MESSAGES = [{ role: 'user', content: '测试' }];

test('no keys anywhere → clear "nothing to attempt" guidance, empty chain', async () => {
  await assert.rejects(
    callWithFailover('glm', {}, MESSAGES),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.match(err.message, /没有可尝试的供应商/);
      assert.match(err.message, /设置里填写至少一个密钥|演示模式/);
      assert.deepEqual(err.chain, []);
      return true;
    },
  );
});

test('attempted providers that fail → summary lists them and chain carries detail', async () => {
  // A registry whose only enabled provider points at an unreachable endpoint;
  // the key exists, so the call IS attempted and fails at the network layer.
  const registry = {
    glm: {
      id: 'glm', label: 'GLM-测试', baseURL: 'http://127.0.0.1:1',
      model: 'glm-test', jsonStrategy: 'json_schema', enabled: true,
    },
  };
  await assert.rejects(
    callWithFailover('glm', { glm: 'test-key' }, MESSAGES, { registry, timeoutMs: 3000 }),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.match(err.message, /所有可用供应商都失败了：glm\(network\)/);
      assert.equal(err.chain.length, 1);
      assert.equal(err.chain[0].provider, 'glm');
      assert.equal(err.chain[0].kind, 'network');
      assert.ok(err.chain[0].message.length > 0, 'chain entry keeps the real failure text');
      return true;
    },
  );
});
