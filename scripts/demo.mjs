
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { product, defaultAuthorizedDomains } from '../src/domain.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const source = await startProvider();
const application = await startApplication({ directory, sourceUrl: source.url, authorizedDomains: defaultAuthorizedDomains });
try {
  const fixture = await readFile(new URL('../fixtures/manual.json', import.meta.url));
  const record = JSON.parse(fixture);
  console.log(`${product}：人工收件、自动采集与原始依据回查`);
  console.log('本地来源状态', await (await fetch(`${source.url}/health`)).text());
  const body = { record, evidence: [{ source: 'operator:local', bytesBase64: fixture.toString('base64'), mediaType: 'application/json' }] };
  for (const label of ['人工首次提交', '人工同件再次提交']) {
    const response = await fetch(`${application.url}/api/manual`, { method: 'POST', body: JSON.stringify(body) });
    const receipt = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(receipt));
    console.log(label, JSON.stringify({ status: response.status, key: receipt.key, duplicate: receipt.duplicate, identity: receipt.identity }));
    const evidence = await (await fetch(`${application.url}/api/evidence/${receipt.evidence[0].sha256}`)).arrayBuffer();
    if (!Buffer.from(evidence).equals(fixture)) throw new Error('原始依据不一致');
  }

  const collectBody = {
    sliceId: 'auto-17',
    domain: '/lab/authorized.h5',
    paths: ['/shortcut', '/run/readings'],
    selection: '[0:2,0:2]',
  };
  const collected = await fetch(`${application.url}/api/collect`, { method: 'POST', body: JSON.stringify(collectBody) });
  const receipt = await collected.json();
  if (!collected.ok) throw new Error(JSON.stringify(receipt));
  const array = receipt.record.origin.arrays[0];
  console.log('自动采集', JSON.stringify({
    status: collected.status,
    duplicate: receipt.duplicate,
    complete: receipt.complete,
    objectId: array.objectId,
    paths: array.paths,
    shape: array.shape.dims,
    version: array.version.etag,
    fields: array.typeSummary.fields,
    fillValue: array.fillValue,
    readCounts: receipt.record.origin.stats,
    coverage: receipt.record.origin.coverage.status,
  }));
  const evidenceBodies = await Promise.all(receipt.evidence.map(async item =>
    JSON.parse(await (await fetch(`${application.url}/api/evidence/${item.sha256}`)).text())));
  console.log('依据回查', JSON.stringify(evidenceBodies.find(item => Array.isArray(item.links)).links.map(link => link.class)));
  const partial = await fetch(`${application.url}/api/collect`, {
    method: 'POST',
    body: JSON.stringify({ sliceId: 'auto-gap', domain: '/lab/authorized.h5', paths: ['/shortcut', '/partner'], selection: '[0:2,0:1]' }),
  });
  const partialBody = await partial.json();
  console.log('缺口报告', JSON.stringify({
    status: partial.status,
    complete: partialBody.complete,
    gaps: partialBody.coverage?.gaps?.map(gap => gap.kind),
  }));
  console.log('当前收件', await (await fetch(`${application.url}/api/records`)).text());
} finally {
  await application.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
