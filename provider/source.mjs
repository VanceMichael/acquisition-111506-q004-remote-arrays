
import { readFile } from 'node:fs/promises';
import { serve, json } from './http.mjs';

const defaultObjects = JSON.parse(await readFile(new URL('../fixtures/objects.json', import.meta.url)));
const defaultValues = JSON.parse(await readFile(new URL('../fixtures/values.json', import.meta.url)));

const DEFAULT_DOMAIN = '/lab/authorized.h5';

function datasetRequests(state, domain, id) {
  const key = `${domain}\u0000${id}`;
  state.datasets ??= new Map();
  state.datasets.set(key, (state.datasets.get(key) ?? 0) + 1);
  return state.datasets.get(key);
}

/**
 * 本地合作来源，只实现 docs/source-contract.md 声明的交互：
 * 根组、组链接、数组元数据、二维窗口取值，以及可选的强ETag/If-Match。
 * 默认资料是虚构的；测试可用 options 提供额外的授权域或覆盖资料。
 */
export async function startProvider(options = {}) {
  const primaryDomain = options.domain ?? DEFAULT_DOMAIN;
  const primary = {
    objects: options.objects ?? defaultObjects,
    values: options.values ?? defaultValues,
  };
  const extras = new Map(Object.entries(options.externalDomains ?? {}));
  // 该合作部署默认提供强ETag/If-Match；可用 etag:false 模拟没有版本扩展的来源。
  const versioned = options.etag !== false;
  const growRows = options.growRows ?? (() => [[
    { value: 6.5, quality: 'ok' },
    { value: 7.5, quality: 'ok' },
  ]]);

  const lookup = domain => {
    if (domain === primaryDomain) return primary;
    return extras.get(domain) ?? null;
  };

  return serve(async ({ request, response, url, state }) => {
    const domain = request.headers['x-hdf-domain'] ?? url.searchParams.get('domain');
    const fixture = lookup(domain);
    if (!fixture) return json(response, { error: 'domain_forbidden' }, 403);
    const objects = fixture.objects;

    if (url.pathname === '/') {
      const root = objects['g-root'] ?? Object.values(objects).find(item => item.id && item.links && item.id.startsWith('g-'));
      if (!root) return json(response, { error: 'not_found' }, 404);
      return json(response, { root: root.id, domain, lastModified: 1794736800 });
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'groups' && objects[parts[1]]) {
      const group = objects[parts[1]];
      if (!group.links) return json(response, { error: 'not_found' }, 404);
      if (parts[2] === 'links') return json(response, { links: group.links });
      if (!parts[2]) return json(response, { id: group.id });
      return false;
    }

    if (parts[0] === 'datasets' && objects[parts[1]] && !objects[parts[1]].links) {
      const dataset = objects[parts[1]];
      const values = fixture.values ?? [];
      const count = datasetRequests(state, domain, dataset.id);
      const grow = options.scenario === 'grow' && count > 1;
      const replace = options.scenario === 'replace' && count > 1;
      const changed = grow || replace;
      const etag = changed ? '"array-v2"' : '"array-v1"';
      const headers = versioned ? { etag } : {};
      if (versioned && request.headers['if-match'] && request.headers['if-match'] !== etag) {
        return json(response, { error: 'version_changed' }, 412);
      }

      let shape = dataset.shape;
      let data = values;
      if (grow) {
        shape = { ...shape, dims: [shape.dims[0] + 1, shape.dims[1]] };
        data = [...values, ...growRows(shape)];
      } else if (replace) {
        data = options.replaceValues?.(values) ?? values;
      }

      if (!parts[2]) {
        return json(response, {
          ...dataset,
          shape,
          lastModified: changed ? 1794736801 : 1794736800,
        }, 200, headers);
      }

      if (parts[2] === 'value') {
        const selection = /^\[(\d+):(\d+),(\d+):(\d+)\]$/.exec(url.searchParams.get('select') ?? '');
        if (!selection) return json(response, { error: 'invalid_selection' }, 400);
        const [rowStart, rowEnd, colStart, colEnd] = selection.slice(1).map(Number);
        if (rowStart > rowEnd || rowEnd > data.length || colStart > colEnd || colEnd > shape.dims[1]) {
          return json(response, { error: 'outside_shape' }, 400);
        }
        return json(response, { value: data.slice(rowStart, rowEnd).map(row => row.slice(colStart, colEnd)) }, 200, headers);
      }
      return false;
    }

    return false;
  }, options);
}
