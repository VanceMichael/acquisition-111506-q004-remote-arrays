
import { readFile } from 'node:fs/promises';
import { serve, json } from './http.mjs';
const objects = JSON.parse(await readFile(new URL('../fixtures/objects.json', import.meta.url)));
const values = JSON.parse(await readFile(new URL('../fixtures/values.json', import.meta.url)));
export async function startProvider(options = {}) {
  return serve(async ({ request, response, url, state }) => {
    const domain = request.headers['x-hdf-domain'] ?? url.searchParams.get('domain');
    if (url.pathname === '/') {
      if (domain !== '/lab/authorized.h5') return json(response, { error: 'domain_forbidden' }, 403);
      return json(response, { root: 'g-root', domain, lastModified: 1794736800 });
    }
    if (domain !== '/lab/authorized.h5') return json(response, { error: 'domain_forbidden' }, 403);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'groups' && objects[parts[1]]) {
      const group = objects[parts[1]];
      return json(response, parts[2] === 'links' ? { links: group.links } : { id: group.id });
    }
    if (parts[0] === 'datasets' && parts[1] === 'd-observe') {
      state.requests = (state.requests ?? 0) + 1;
      const changed = options.scenario === 'grow' && state.requests > 1;
      const etag = changed ? '"array-v2"' : '"array-v1"';
      if (request.headers['if-match'] && request.headers['if-match'] !== etag) return json(response, { error: 'version_changed' }, 412);
      if (!parts[2]) return json(response, { ...objects['d-observe'], shape: { ...objects['d-observe'].shape, dims: changed ? [4, 2] : [3, 2] }, lastModified: changed ? 1794736801 : 1794736800 }, 200, { etag });
      if (parts[2] === 'value') {
        const selection = /^\[(\d+):(\d+),(\d+):(\d+)\]$/.exec(url.searchParams.get('select') ?? '');
        if (!selection) return json(response, { error: 'invalid_selection' }, 400);
        const [rowStart, rowEnd, colStart, colEnd] = selection.slice(1).map(Number);
        const data = changed ? [...values, [{ value: 6.5, quality: 'ok' }, { value: 7.5, quality: 'ok' }]] : values;
        if (rowStart > rowEnd || rowEnd > data.length || colStart > colEnd || colEnd > 2) return json(response, { error: 'outside_shape' }, 400);
        return json(response, { value: data.slice(rowStart, rowEnd).map(row => row.slice(colStart, colEnd)) }, 200, { etag });
      }
    }
    return false;
  }, options);
}
