import test from 'node:test';
import assert from 'node:assert/strict';
import { startProvider } from '../provider/source.mjs';

test("来源实际交互保持已声明的语义", async () => {
  const source = await startProvider();
  try {
    const headers = { 'x-hdf-domain': '/lab/authorized.h5' };
    const root = await (await fetch(`${source.url}/`, { headers })).json();
    assert.equal(root.root, 'g-root');
    const links = await (await fetch(`${source.url}/groups/g-root/links`, { headers })).json();
    assert.ok(links.links.some(link => link.class === 'H5L_TYPE_EXTERNAL'));
    const result = await fetch(`${source.url}/datasets/d-observe/value?select=[0:2,0:1]`, { headers: { ...headers, 'if-match': '"array-v1"' } });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).value[0][0].quality, 'ok');
    assert.equal((await fetch(`${source.url}/`, { headers: { 'x-hdf-domain': '/outside/secret' } })).status, 403);
  } finally { await source.close(); }
});
