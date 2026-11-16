
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { validateRecord, validateCollectRequest, product, defaultAuthorizedDomains } from './domain.mjs';
import { HsdsClient } from './hsds.mjs';
import { readSlice } from './resolve.mjs';

const MAX_COLLECT_CELLS = 250_000;

export async function readJson(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('收件超过大小限制'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求不是有效JSON'), { status: 400 }); }
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function startApplication({
  directory,
  port = 0,
  host = '127.0.0.1',
  sourceUrl = null,
  source = null,
  providerUrl = null,
  authorizedDomains = defaultAuthorizedDomains,
  domains = null,
  sourceTimeoutMs = 10_000,
} = {}) {
  const store = await openStore(directory);
  // source/providerUrl 是 sourceUrl 的别名；也接受已启动来源对象，便于本地演示与测试。
  const candidate = sourceUrl ?? source ?? providerUrl ?? null;
  const resolvedSourceUrl = candidate && typeof candidate === 'object' ? candidate.url : candidate;
  const resolvedDomains = Array.isArray(domains ?? authorizedDomains)
    ? (domains ?? authorizedDomains)
    : [domains ?? authorizedDomains];
  const client = resolvedSourceUrl
    ? new HsdsClient({ baseUrl: resolvedSourceUrl, authorizedDomains: resolvedDomains, timeoutMs: sourceTimeoutMs })
    : null;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { product, status: 'ok', autoCollection: client ? 'available' : 'not-configured' });
      if (request.method === 'POST' && url.pathname === '/api/manual') {
        const input = await readJson(request);
        const { key, record } = validateRecord(input.record);
        const receipt = await store.accept(key, record, input.evidence);
        return sendJson(response, receipt.duplicate ? 200 : 201, receipt);
      }
      if (request.method === 'POST' && url.pathname === '/api/collect') {
        if (!client) {
          throw Object.assign(new Error('未配置来源服务，自动采集不可用'), { status: 503, code: 'source_not_configured' });
        }
        const input = await readJson(request);
        const headerDomain = request.headers['x-hdf-domain'];
        const collect = validateCollectRequest({
          ...input,
          domain: input?.domain ?? headerDomain,
          selection: input?.selection ?? input?.window,
        });
        const sliceId = collect.sliceId ?? `auto-${randomUUID()}`;
        const result = await readSlice(client, {
          domain: collect.domain,
          paths: collect.paths,
          selection: collect.selection,
          maxCells: MAX_COLLECT_CELLS,
        });
        const arrays = result.objects.map(array => ({
          domain: array.domain,
          objectId: array.objectId,
          collection: array.collection,
          paths: array.paths,
          shape: array.shape,
          windowShape: array.windowShape,
          selection: array.selection,
          type: array.type,
          typeSummary: array.typeSummary,
          fillValue: array.fillValue,
          version: array.version,
          lastModified: array.lastModified,
          values: array.values,
        }));
        const single = arrays.length === 1 && result.coverage.status === 'complete';
        const firstResolved = result.targets.find(target => target.resolved);
        const record = {
          sliceId,
          dataset: arrays[0]?.paths[0] ?? firstResolved?.path ?? result.paths[0],
          selection: result.selection.expression,
          // 只有完整命中单个数组时才沿用人工收件的表结构；任何缺口或多目标都按数组
          // 分别保存身份与值，绝不把不同字段或缺失范围拼成一张看似完整的表。
          values: single ? arrays[0].values : arrays.map(array => ({
            domain: array.domain,
            objectId: array.objectId,
            paths: array.paths,
            values: array.values,
          })),
          origin: {
            kind: 'hsds',
            domain: result.domain,
            paths: result.paths,
            selection: result.selection.expression,
            targets: result.targets,
            arrays,
            gaps: result.gaps,
            boundaries: result.boundaries,
            coverage: result.coverage,
            stats: result.stats,
          },
        };
        const evidence = result.snapshots.map(snapshot => ({
          source: snapshot.source,
          mediaType: snapshot.mediaType,
          bytesBase64: snapshot.bytes.toString('base64'),
        }));
        const { key, record: validated } = validateRecord(record);
        const receipt = await store.accept(key, validated, evidence);
        return sendJson(response, receipt.duplicate ? 200 : 201, { ...receipt, complete: result.coverage.status === 'complete', coverage: result.coverage });
      }
      if (request.method === 'GET' && url.pathname === '/api/records') return sendJson(response, 200, store.list());
      if (request.method === 'GET' && url.pathname === '/api/history') return sendJson(response, 200, store.history(url.searchParams.get('key')));
      if (request.method === 'GET' && url.pathname.startsWith('/api/evidence/')) {
        const bytes = await store.evidence(url.pathname.slice('/api/evidence/'.length));
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(bytes);
      }
      sendJson(response, 404, { error: '入口不存在' });
    } catch (error) {
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
      const body = { error: status === 500 ? '收件服务内部错误' : error.message };
      if (error.code && status !== 500) body.code = error.code;
      if (error.details !== undefined && status !== 500) body.details = error.details;
      sendJson(response, status, body);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { store, server, url: `http://${host}:${server.address().port}`, async close() {
    await new Promise(resolve => server.close(resolve));
    await store.flush();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await startApplication({
    directory: process.env.DATA_DIR ?? './var',
    port: Number(process.env.PORT ?? 4310),
    host: process.env.HOST ?? '127.0.0.1',
    // 默认连接 README 中本机来源端的地址；无来源时可只使用人工入口。
    sourceUrl: process.env.SOURCE_URL ?? 'http://127.0.0.1:4311',
    authorizedDomains: process.env.AUTHORIZED_DOMAINS
      ? process.env.AUTHORIZED_DOMAINS.split(',').map(item => item.trim()).filter(Boolean)
      : defaultAuthorizedDomains,
  });
  console.log(JSON.stringify({ product, url: application.url }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => application.close().then(() => process.exit(0)));
}
