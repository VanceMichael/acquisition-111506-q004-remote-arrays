
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HsdsClient } from '../src/hsds.mjs';
import { readSlice, locateDataset } from '../src/resolve.mjs';
import { startProvider } from '../provider/source.mjs';
import { startApplication } from '../src/server.mjs';
import { parseSelection } from '../src/hdf.mjs';

const DOMAIN = '/lab/authorized.h5';

async function withSource(options, run) {
  const source = await startProvider(options);
  const client = new HsdsClient({ baseUrl: source.url, authorizedDomains: [DOMAIN] });
  try { return await run({ source, client }); } finally { await source.close(); }
}

test('从授权域根组解析组内路径，并记录真实对象身份与硬链接别名', async () => {
  await withSource({}, async ({ client }) => {
    const located = await locateDataset(client, DOMAIN, '/run/readings');
    assert.equal(located.objectId, 'd-observe');
    assert.equal(located.collection, 'datasets');
    assert.ok(located.paths.includes('/run/readings'));
    assert.ok(located.paths.includes('/shortcut'), '同一对象的硬链接别名也应记录');
    assert.equal(located.gaps.length, 0);
  });
});

test('同一对象经别名请求只读取一次元数据和一次窗口', async () => {
  await withSource({}, async ({ client, source }) => {
    const before = source.events.filter(event => event.path.startsWith('/datasets/')).length;
    const slice = await readSlice(client, {
      domain: DOMAIN,
      paths: ['/shortcut', '/run/readings'],
      selection: '[0:2,0:1]',
    });
    assert.equal(slice.objects.length, 1);
    assert.deepEqual([...slice.objects[0].paths].sort(), ['/run/readings', '/shortcut']);
    assert.equal(slice.stats.datasetMetadata, 1);
    assert.equal(slice.stats.valueReads, 1);
    const reads = source.events.filter(event => event.path === '/datasets/d-observe/value');
    assert.equal(reads.length, 1);
    assert.equal(reads[0].query, '?select=%5B0%3A2%2C0%3A1%5D');
    const total = source.events.filter(event => event.path.startsWith('/datasets/')).length;
    assert.equal(total - before, 2, '只请求元数据与所需窗口');
  });
});

test('复合字段、变长字符串与填充依据按来源保留，不丢字段也不补零', async () => {
  await withSource({}, async ({ client }) => {
    const slice = await readSlice(client, {
      domain: DOMAIN,
      paths: ['/run/readings'],
      selection: '[0:2,0:2]',
    });
    const array = slice.objects[0];
    assert.deepEqual(array.values, [
      [{ value: 1.5, quality: 'ok' }, { value: -999.0, quality: 'unwritten' }],
      [{ value: 2.5, quality: '校准' }, { value: 3.5, quality: 'ok' }],
    ]);
    assert.equal(array.values[0][1].quality, 'unwritten');
    assert.equal(array.values[0][1].value, -999.0);
    assert.deepEqual(array.fillValue, { value: -999.0, quality: 'unwritten' });
    assert.equal(array.type.class, 'H5T_COMPOUND');
    assert.deepEqual(array.type.fields.map(field => field.name), ['value', 'quality']);
    assert.deepEqual(array.typeSummary.variableLengthStrings, ['quality']);
    assert.deepEqual(array.shape.dims, [3, 2]);
  });
});

test('版本在元数据与窗口之间变化时带 If-Match 重试并报告依据版本', async () => {
  await withSource({ scenario: 'grow' }, async ({ client, source }) => {
    const slice = await readSlice(client, { domain: DOMAIN, paths: ['/shortcut'], selection: '[0:2,0:1]' });
    const array = slice.objects[0];
    assert.deepEqual(array.shape.dims, [4, 2]);
    assert.deepEqual(array.values, [
      [{ value: 1.5, quality: 'ok' }],
      [{ value: 2.5, quality: '校准' }],
    ]);
    assert.equal(array.version.etag, '"array-v2"');
    assert.equal(array.version.changedDuringRead, true);
    assert.ok(array.version.observations.some(item => item.status === 412));
    const conditional = source.events
      .filter(event => event.headers['if-match'])
      .map(event => event.headers['if-match']);
    assert.ok(conditional.includes('"array-v1"'));
  });
});

test('失效软链接与未授权外部链接留下明确缺口，不伪装成完整窗口', async () => {
  await withSource({}, async ({ client, source }) => {
    for (const [path, kind] of [['/lost', 'missing_link'], ['/partner', 'external_unauthorized']]) {
      await assert.rejects(
        readSlice(client, { domain: DOMAIN, paths: [path], selection: '[0:2,0:1]' }),
        error => {
          assert.equal(error.status, 404);
          assert.equal(error.code, 'target_unresolved');
          assert.ok(error.details.gaps.some(gap => gap.kind === kind), JSON.stringify(error.details.gaps));
          return true;
        },
      );
    }
    // 未授权外部域不应被访问。
    assert.equal(source.events.some(event => event.headers['x-hdf-domain'] === '/outside/secret'), false);
  });
});

test('授权范围内的外部链接继续读取；范围不可读时保留缺口', async () => {
  const externalDomain = '/lab/partner.h5';
  const externalObjects = {
    'g-root': {
      id: 'g-root',
      links: [{ title: 'data', class: 'H5L_TYPE_HARD', collection: 'datasets', id: 'd-partner' }],
    },
    'd-partner': {
      id: 'd-partner',
      shape: { class: 'H5S_SIMPLE', dims: [2, 1] },
      type: { class: 'H5T_COMPOUND', fields: [{ name: 'value', type: 'H5T_IEEE_F64LE' }] },
      creationProperties: { fillValue: { value: null } },
      lastModified: 1,
    },
  };
  const rootObjects = {
    'g-root': {
      id: 'g-root',
      links: [
        { title: 'inside', class: 'H5L_TYPE_EXTERNAL', h5domain: externalDomain, h5path: '/data' },
        { title: 'outside', class: 'H5L_TYPE_EXTERNAL', h5domain: '/outside/secret', h5path: '/data' },
      ],
    },
  };
  await withSource({
    objects: rootObjects,
    values: [],
    externalDomains: { [externalDomain]: { objects: externalObjects, values: [[{ value: 9 }], [{ value: 10 }]] } },
  }, async ({ client, source }) => {
    const scoped = new HsdsClient({ baseUrl: source.url, authorizedDomains: [DOMAIN, externalDomain] });
    const slice = await readSlice(scoped, { domain: DOMAIN, paths: ['/inside'], selection: '[0:2,0:1]' });
    assert.equal(slice.objects.length, 1);
    assert.equal(slice.objects[0].domain, externalDomain);
    assert.equal(slice.objects[0].objectId, 'd-partner');
    assert.deepEqual(slice.objects[0].values, [[{ value: 9 }], [{ value: 10 }]]);
    assert.ok(slice.boundaries.some(boundary => boundary.path === '/outside'));

    await assert.rejects(
      readSlice(client, { domain: DOMAIN, paths: ['/inside'], selection: '[0:2,0:1]' }),
      error => {
        assert.equal(error.code, 'target_unresolved');
        assert.ok(error.details.gaps.some(gap => gap.kind === 'external_unauthorized'));
        return true;
      },
    );
  });
});

test('有效软链接从同域根组继续，硬链接循环留下缺口', async () => {
  const objects = {
    'g-root': {
      id: 'g-root',
      links: [
        { title: 'run', class: 'H5L_TYPE_HARD', collection: 'groups', id: 'g-run' },
        { title: 'alias', class: 'H5L_TYPE_SOFT', h5path: '/run/readings' },
      ],
    },
    'g-run': {
      id: 'g-run',
      links: [
        { title: 'readings', class: 'H5L_TYPE_HARD', collection: 'datasets', id: 'd-1' },
        { title: 'back', class: 'H5L_TYPE_HARD', collection: 'groups', id: 'g-root' },
      ],
    },
    'd-1': {
      id: 'd-1',
      shape: { class: 'H5S_SIMPLE', dims: [1, 1] },
      type: { class: 'H5T_COMPOUND', fields: [{ name: 'value', type: 'H5T_IEEE_F64LE' }] },
      creationProperties: {},
      lastModified: 2,
    },
  };
  await withSource({ objects, values: [[{ value: 1 }]] }, async ({ client }) => {
    const viaSoft = await locateDataset(client, DOMAIN, '/alias');
    assert.equal(viaSoft.objectId, 'd-1');
    assert.ok(viaSoft.paths.includes('/alias'));
    assert.ok(viaSoft.paths.includes('/run/readings'));
  });

  // 硬链接循环：/run/back 回到根组，再次进入同一链接时停止并留下缺口。
  const loopObjects = {
    'g-root': {
      id: 'g-root',
      links: [
        { title: 'run', class: 'H5L_TYPE_HARD', collection: 'groups', id: 'g-run' },
        { title: 'loop', class: 'H5L_TYPE_SOFT', h5path: '/loop' },
      ],
    },
    'g-run': {
      id: 'g-run',
      links: [{ title: 'readings', class: 'H5L_TYPE_HARD', collection: 'datasets', id: 'd-1' }],
    },
    'd-1': objects['d-1'],
  };
  await withSource({ objects: loopObjects, values: [[{ value: 1 }]] }, async ({ client }) => {
    await assert.rejects(
      readSlice(client, { domain: DOMAIN, paths: ['/loop'], selection: '[0:1,0:1]' }),
      error => {
        assert.equal(error.code, 'target_unresolved');
        assert.ok(error.details.gaps.some(gap => gap.kind === 'link_cycle'));
        return true;
      },
    );
  });
});

test('多目标按数组分别保存，不把不同字段拼成一张表', async () => {
  const objects = {
    'g-root': {
      id: 'g-root',
      links: [
        { title: 'a', class: 'H5L_TYPE_HARD', collection: 'datasets', id: 'd-a' },
        { title: 'b', class: 'H5L_TYPE_HARD', collection: 'datasets', id: 'd-b' },
      ],
    },
    'd-a': {
      id: 'd-a',
      shape: { class: 'H5S_SIMPLE', dims: [1, 1] },
      type: { class: 'H5T_COMPOUND', fields: [
        { name: 'count', type: 'H5T_STD_I32LE' },
        { name: 'label', type: { class: 'H5T_STRING', length: 'H5T_VARIABLE', charSet: 'H5T_CSET_UTF8' } },
      ] },
      creationProperties: { fillValue: { count: -1, label: null } },
      lastModified: 3,
    },
    'd-b': {
      id: 'd-b',
      shape: { class: 'H5S_SIMPLE', dims: [1, 1] },
      type: { class: 'H5T_COMPOUND', fields: [{ name: 'voltage', type: 'H5T_IEEE_F32LE' }] },
      creationProperties: { fillValue: { voltage: null } },
      lastModified: 4,
    },
  };
  const directory = await mkdtemp(join(tmpdir(), 'multi-'));
  // 两个数组内容不同：按路径分别返回，确认各数组的值和字段没有混在一起。
  const fakeFetch = async (url, init) => {
    const target = new URL(url);
    let body;
    if (target.pathname === '/') body = { root: 'g-root' };
    else if (target.pathname === '/groups/g-root/links') body = { links: objects['g-root'].links };
    else if (target.pathname === '/datasets/d-a') body = objects['d-a'];
    else if (target.pathname === '/datasets/d-b') body = objects['d-b'];
    else if (target.pathname === '/datasets/d-a/value') body = { value: [[{ count: 7, label: '样品' }]] };
    else if (target.pathname === '/datasets/d-b/value') body = { value: [[{ voltage: 0.25 }]] };
    else return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    assert.equal(init.headers['x-hdf-domain'], DOMAIN);
    return new Response(JSON.stringify(body), { headers: { etag: '"v1"', 'content-type': 'application/json' } });
  };
  const client = new HsdsClient({ baseUrl: 'http://source.test', authorizedDomains: [DOMAIN], fetchImpl: fakeFetch });
  const slice = await readSlice(client, { domain: DOMAIN, paths: ['/a', '/b'], selection: '[0:1,0:1]' });
  assert.equal(slice.objects.length, 2);
  assert.deepEqual(slice.objects.map(array => array.objectId), ['d-a', 'd-b']);
  assert.deepEqual(slice.objects.map(array => array.values), [[[{ count: 7, label: '样品' }]], [[{ voltage: 0.25 }]]]);
  assert.deepEqual(slice.objects.map(array => array.typeSummary.fields), [['count', 'label'], ['voltage']]);
  assert.deepEqual(slice.objects.map(array => array.fillValue), [{ count: -1, label: null }, { voltage: null }]);
  assert.equal(slice.stats.datasetMetadata, 2);
  assert.equal(slice.stats.valueReads, 2);

  // 收件端通过自动入口记录多数组：值按数组合并保存为带身份的对象，而不是一张拼表。
  const stub = createServer((request, response) => {
    fakeFetch(`http://source.test${request.url}`, { headers: request.headers })
      .then(result => result.text().then(text => {
        response.writeHead(result.status, { 'content-type': 'application/json', etag: result.headers.get('etag') });
        response.end(text);
      }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const application = await startApplication({
    directory,
    sourceUrl: `http://127.0.0.1:${stub.address().port}`,
    authorizedDomains: [DOMAIN],
  });
  try {
    const response = await fetch(`${application.url}/api/collect`, {
      method: 'POST',
      body: JSON.stringify({ domain: DOMAIN, paths: ['/a', '/b'], selection: '[0:1,0:1]', sliceId: 'multi-1' }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const receipt = await response.json();
    assert.equal(receipt.record.origin.arrays.length, 2);
    assert.deepEqual(receipt.record.origin.arrays.map(array => array.objectId), ['d-a', 'd-b']);
    assert.deepEqual(receipt.record.origin.arrays.map(array => array.fillValue), [{ count: -1, label: null }, { voltage: null }]);
    assert.deepEqual(receipt.record.values.map(item => item.objectId), ['d-a', 'd-b']);
    assert.deepEqual(receipt.record.values.map(item => item.values), [[[{ count: 7, label: '样品' }]], [[{ voltage: 0.25 }]]]);
  } finally {
    await application.close();
    await new Promise(resolve => stub.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('读取期间对象版本反复变化时明确失败而不是拼出窗口', async () => {
  let reads = 0;
  const fakeFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/') return new Response(JSON.stringify({ root: 'g-root' }), { headers: { etag: '"root"' } });
    if (path === '/groups/g-root/links') {
      return new Response(JSON.stringify({ links: [{ title: 'a', class: 'H5L_TYPE_HARD', collection: 'datasets', id: 'd-a' }] }), { headers: { etag: '"links"' } });
    }
    reads += 1;
    const metadata = {
      shape: { class: 'H5S_SIMPLE', dims: [2, 1] },
      type: { class: 'H5T_COMPOUND', fields: [{ name: 'value', type: 'H5T_IEEE_F64LE' }] },
      creationProperties: {},
      lastModified: reads,
    };
    if (path === '/datasets/d-a') {
      return new Response(JSON.stringify(metadata), { headers: { etag: `"v${reads}"` } });
    }
    return new Response(JSON.stringify({ value: [[{ value: reads }], [{ value: reads }]] }), { headers: { etag: `"v${reads}"` } });
  };
  const client = new HsdsClient({ baseUrl: 'http://source.test', authorizedDomains: [DOMAIN], fetchImpl: fakeFetch });
  await assert.rejects(
    readSlice(client, { domain: DOMAIN, paths: ['/a'], selection: '[0:2,0:1]' }),
    error => {
      assert.equal(error.status, 412);
      assert.equal(error.code, 'source_version_changed');
      assert.ok(error.details.observations.length >= 2);
      return true;
    },
  );
});

test('路径指向组或越过数组时报告具体位置', async () => {
  await withSource({}, async ({ client }) => {
    await assert.rejects(
      readSlice(client, { domain: DOMAIN, paths: ['/run'], selection: '[0:1,0:1]' }),
      error => error.status === 404 && error.details.collection === 'groups',
    );
    await assert.rejects(
      readSlice(client, { domain: DOMAIN, paths: ['/shortcut/extra'], selection: '[0:1,0:1]' }),
      error => error.status === 404 && error.details.collection === 'datasets',
    );
    await assert.rejects(
      readSlice(client, { domain: DOMAIN, paths: ['/run/missing'], selection: '[0:1,0:1]' }),
      error => error.code === 'target_unresolved' && error.details.gaps.some(gap => gap.kind === 'missing_link'),
    );
  });
});

test('数组在读取期间扩展时说明依据的形状与对象版本', async () => {
  await withSource({ scenario: 'grow' }, async ({ client }) => {
    const slice = await readSlice(client, { domain: DOMAIN, paths: ['/shortcut'], selection: '[0:4,0:2]' });
    const array = slice.objects[0];
    assert.deepEqual(array.shape.dims, [4, 2]);
    assert.equal(array.values.length, 4);
    assert.equal(array.version.verified, true);
    assert.equal(array.version.etag, '"array-v2"');
    assert.equal(array.version.changedDuringRead, true);
    assert.ok(array.version.observations.some(item => item.etag === '"array-v1"'));
    assert.ok(array.version.observations.some(item => item.shape?.[0] === 3));
  });
});

test('来源不提供版本证明时只报告实际观察范围', async () => {
  await withSource({ etag: false }, async ({ client }) => {
    const slice = await readSlice(client, { domain: DOMAIN, paths: ['/shortcut'], selection: '[0:2,0:1]' });
    assert.equal(slice.objects[0].version.verified, false);
    assert.equal(slice.objects[0].version.etag, null);
  });
});

test('窗口校验拒绝越界与过大的请求', async () => {
  assert.equal(parseSelection('[0:2,0:1]').expression, '[0:2,0:1]');
  assert.deepEqual(parseSelection('[0:2,0:1]').windowShape, [2, 1]);
  assert.throws(() => parseSelection('[2:1,0:1]'));
  assert.throws(() => parseSelection('[0:1000000,0:2]'), /超过单次上限/);
  await withSource({}, async ({ client }) => {
    await assert.rejects(
      readSlice(client, { domain: DOMAIN, paths: ['/shortcut'], selection: '[0:3,0:3]' }),
      error => error.status === 400 && error.code === 'selection_out_of_bounds',
    );
  });
});

test('自动采集入口实际读取来源、保存路径与对象身份并回查原始依据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const source = await startProvider();
  const application = await startApplication({
    directory,
    sourceUrl: source.url,
    authorizedDomains: [DOMAIN],
  });
  try {
    const response = await fetch(`${application.url}/api/collect`, {
      method: 'POST',
      body: JSON.stringify({ domain: DOMAIN, paths: ['/run/readings'], selection: '[0:2,0:1]', sliceId: 'auto-1' }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const receipt = await response.json();
    assert.equal(receipt.complete, true);
    assert.equal(receipt.record.sliceId, 'auto-1');
    assert.equal(receipt.record.origin.arrays[0].objectId, 'd-observe');
    assert.ok(receipt.record.origin.arrays[0].paths.includes('/shortcut'));
    assert.deepEqual(receipt.record.values, [
      [{ value: 1.5, quality: 'ok' }],
      [{ value: 2.5, quality: '校准' }],
    ]);
    const evidenceResponses = await Promise.all(receipt.evidence.map(async item =>
      JSON.parse(await (await fetch(`${application.url}/api/evidence/${item.sha256}`)).text())));
    const linksSnapshot = evidenceResponses.find(body => Array.isArray(body.links));
    assert.deepEqual(linksSnapshot.links.map(link => link.title), ['run', 'shortcut', 'lost', 'partner']);
    assert.ok(receipt.evidence.some(item => item.source.includes('/datasets/d-observe/value')));
    assert.ok(receipt.evidence.some(item => item.source.includes('/groups/g-root/links')));

    const again = await fetch(`${application.url}/api/collect`, {
      method: 'POST',
      body: JSON.stringify({ domain: DOMAIN, paths: ['/run/readings'], selection: '[0:2,0:1]', sliceId: 'auto-1' }),
    });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).duplicate, true);

    const forbidden = await fetch(`${application.url}/api/collect`, {
      method: 'POST',
      body: JSON.stringify({ domain: '/outside/secret', paths: ['/data'], selection: '[0:1,0:1]' }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).code, 'domain_not_authorized');
  } finally {
    await application.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
