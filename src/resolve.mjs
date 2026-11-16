
import { createHash } from 'node:crypto';
import {
  fail, parseSelection, validateShape, checkWindowWithinShape, checkWindowWithinMaxDims,
  validateType, summarizeType, normalizeH5Path,
} from './hdf.mjs';

const MAX_PATH_STEPS = 512;
const MAX_VERSION_RETRIES = 2;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** 单次采集内共享的读取缓存：同一对象、同一组链接页只向来源取一次。 */
function createReadCache(client) {
  return {
    roots: new Map(),
    links: new Map(),
    snapshots: new Map(),
    groupPaths: new Map(),
    objects: new Map(),
    stats: { rootReads: 0, groupLinks: 0, datasetMetadata: 0, valueReads: 0 },
    remember(snapshot) {
      if (!snapshot?.bytes) return;
      // 同一来源、同一内容的响应只作为一份依据；同一地址的不同版本（ETag不同）都保留。
      const key = `${snapshot.source}\u0000${sha256(snapshot.bytes)}`;
      if (!this.snapshots.has(key)) this.snapshots.set(key, snapshot);
    },
    addGroupPath(domain, id, path) {
      const key = `${domain}\u0000${id}`;
      if (!this.groupPaths.has(key)) this.groupPaths.set(key, new Set());
      this.groupPaths.get(key).add(path);
    },
    addObjectPath(domain, id, collection, path) {
      const key = `${domain}\u0000${id}`;
      if (!this.objects.has(key)) {
        this.objects.set(key, { domain, id, collection, paths: new Set() });
      }
      this.objects.get(key).paths.add(path);
      return this.objects.get(key);
    },
  };
}

async function cachedRoot(client, cache, domain) {
  const key = `${domain}`;
  if (!cache.roots.has(key)) {
    const result = await client.root(domain);
    cache.stats.rootReads += 1;
    cache.remember(result.snapshot);
    cache.roots.set(key, { id: result.id, snapshot: result.snapshot });
    cache.addGroupPath(domain, result.id, '/');
  }
  return cache.roots.get(key);
}

async function cachedLinks(client, cache, domain, groupId) {
  const key = `${domain}\u0000${groupId}`;
  if (!cache.links.has(key)) {
    let page;
    try {
      page = await client.groupLinks(domain, groupId);
    } catch (error) {
      // 拒绝访问的响应也保留为来源依据，缺口可由原始字节复核。
      cache.remember(error.snapshot);
      cache.links.set(key, { error });
      return cache.links.get(key);
    }
    cache.stats.groupLinks += 1;
    cache.remember(page.snapshot);
    cache.links.set(key, { links: page.links, snapshot: page.snapshot });
  }
  return cache.links.get(key);
}

/** 同一个来源响应只保存一次；快照数量超出收件上限时明确失败，而不是丢掉依据。 */
function snapshotList(cache, maxSnapshots) {
  const snapshots = [...cache.snapshots.values()];
  if (snapshots.length > maxSnapshots) {
    fail(422, 'evidence_limit', `本次遍历产生 ${snapshots.length} 份原始依据，超过单次上限 ${maxSnapshots}`, {
      evidence: snapshots.length,
      max: maxSnapshots,
    });
  }
  return snapshots;
}

/**
 * 从授权域根组开始按组内路径查找目标数组。
 * 硬链接沿对象 id 继续；软链接按 h5path 从同域根组继续；外部链接仅在
 * h5domain 已授权且来源可读时继续，否则记录缺口并停止。
 */
async function resolvePath(client, cache, domain, requestedPath) {
  client.assertAuthorized(domain);
  const targetPath = normalizeH5Path(requestedPath);
  if (targetPath === '/') fail(400, 'invalid_path', '目标路径必须是数组，不能是根组');
  const root = await cachedRoot(client, cache, domain);
  const gaps = [];
  const seenLinks = new Set();
  let steps = 0;

  const addGap = (kind, affectsTarget, detail) => {
    gaps.push({ kind, affectsTarget, ...detail });
  };

  const resolve = async (segments, index, context) => {
    if (++steps > MAX_PATH_STEPS) {
      addGap('path_too_deep', true, {
        path: targetPath,
        detail: '链接跳转次数过多，无法确定目标',
        domain: context.domain,
      });
      return null;
    }
    if (index >= segments.length) {
      if (context.collection !== 'datasets') {
        fail(404, 'path_not_dataset', '目标路径指向的不是数组', {
          domain,
          path: targetPath,
          collection: context.collection,
          foundAt: `/${segments.join('/')}`,
        });
      }
      return context;
    }
    if (context.collection !== 'groups') {
      fail(404, 'path_not_dataset', '目标路径在数组处继续深入', {
        domain,
        path: targetPath,
        collection: context.collection,
        foundAt: `/${segments.slice(0, index).join('/')}`,
      });
    }

    const title = segments[index];
    const linkPath = `/${segments.slice(0, index + 1).join('/')}`;
    const linkKey = `${context.domain}\u0000${context.id}\u0000${title}`;
    if (seenLinks.has(linkKey)) {
      addGap('link_cycle', true, {
        path: linkPath,
        detail: '组内链接形成循环，已停止继续',
        domain: context.domain,
      });
      return null;
    }
    seenLinks.add(linkKey);

    const page = await cachedLinks(client, cache, context.domain, context.id);
    if (page.error) {
      addGap('group_unreadable', true, {
        path: `/${segments.slice(0, index).join('/')}` || '/',
        detail: page.error.message,
        domain: context.domain,
        status: page.error.status ?? null,
      });
      return null;
    }

    const link = page.links.find(item => item && item.title === title);
    if (!link) {
      addGap('missing_link', true, {
        path: linkPath,
        detail: '组内没有该名称的链接，无法确定后续内容',
        domain: context.domain,
        group: context.id,
      });
      return null;
    }

    if (link.class === 'H5L_TYPE_HARD') {
      if (typeof link.id !== 'string' || !link.id) {
        addGap('invalid_link', true, { path: linkPath, detail: '硬链接缺少对象 id', domain: context.domain });
        return null;
      }
      const collection = link.collection === 'groups' ? 'groups' : link.collection === 'datasets' ? 'datasets' : null;
      if (!collection) {
        addGap('invalid_link', true, {
          path: linkPath,
          detail: `硬链接的 collection 不能解释：${String(link.collection)}`,
          domain: context.domain,
        });
        return null;
      }
      if (collection === 'groups') cache.addGroupPath(context.domain, link.id, linkPath);
      const object = cache.addObjectPath(context.domain, link.id, collection, linkPath);
      return resolve(segments, index + 1, {
        id: link.id,
        collection,
        domain: context.domain,
        object,
      });
    }

    if (link.class === 'H5L_TYPE_SOFT') {
      if (typeof link.h5path !== 'string' || !link.h5path.trim()) {
        addGap('broken_soft_link', true, { path: linkPath, detail: '软链接缺少 h5path', domain: context.domain });
        return null;
      }
      let linked;
      try {
        linked = normalizeH5Path(link.h5path);
      } catch (error) {
        addGap('broken_soft_link', true, { path: linkPath, detail: error.message, domain: context.domain });
        return null;
      }
      const linkedSegments = linked.split('/').filter(Boolean);
      const result = await resolve([...linkedSegments, ...segments.slice(index + 1)], 0, {
        id: root.id,
        collection: 'groups',
        domain: context.domain,
        object: null,
      });
      if (!result) {
        addGap('broken_soft_link', true, {
          path: linkPath,
          detail: `软链接目标无法解析：${link.h5path}`,
          domain: context.domain,
          h5path: link.h5path,
        });
      }
      return result;
    }

    if (link.class === 'H5L_TYPE_EXTERNAL') {
      const externalDomain = link.h5domain;
      if (typeof externalDomain !== 'string' || !externalDomain.trim()) {
        addGap('external_unknown', true, {
          path: linkPath,
          detail: '外部链接缺少 h5domain，范围无法确定',
          domain: context.domain,
        });
        return null;
      }
      if (!client.isAuthorized(externalDomain)) {
        addGap('external_unauthorized', true, {
          path: linkPath,
          detail: '外部链接指向未授权域，未继续读取',
          domain: context.domain,
          externalDomain,
        });
        return null;
      }
      if (typeof link.h5path !== 'string' || !link.h5path.trim()) {
        addGap('external_unknown', true, {
          path: linkPath,
          detail: '外部链接缺少 h5path，范围无法确定',
          domain: context.domain,
          externalDomain,
        });
        return null;
      }
      let linked;
      try {
        linked = normalizeH5Path(link.h5path);
      } catch (error) {
        addGap('external_unknown', true, {
          path: linkPath, detail: error.message, domain: context.domain, externalDomain,
        });
        return null;
      }
      let externalRoot;
      try {
        externalRoot = await cachedRoot(client, cache, externalDomain);
      } catch (error) {
        cache.remember(error.snapshot);
        addGap(error.status === 403 ? 'external_forbidden' : 'external_unreadable', true, {
          path: linkPath,
          detail: error.message,
          domain: context.domain,
          externalDomain,
          status: error.status ?? null,
        });
        return null;
      }
      const result = await resolve([...linked.split('/').filter(Boolean), ...segments.slice(index + 1)], 0, {
        id: externalRoot.id,
        collection: 'groups',
        domain: externalDomain,
        object: null,
      });
      if (!result) {
        addGap('external_unresolved', true, {
          path: linkPath,
          detail: `授权范围内的外部链接无法解析：${externalDomain}${link.h5path}`,
          domain: context.domain,
          externalDomain,
          h5path: link.h5path,
        });
      }
      return result;
    }

    addGap('unsupported_link', true, {
      path: linkPath,
      detail: `不能解释的链接类型：${link.class ?? '未声明'}`,
      domain: context.domain,
    });
    return null;
  };

  let found;
  try {
    found = await resolve(targetPath.split('/').filter(Boolean), 0, {
      id: root.id,
      collection: 'groups',
      domain,
      object: null,
    });
  } catch (error) {
    if (error.status === 404) {
      throw Object.assign(error, { gaps });
    }
    throw error;
  }

  const boundaries = [];
  for (const [key, page] of cache.links) {
    if (!page.links) continue;
    const [pageDomain, groupId] = key.split('\u0000');
    const paths = cache.groupPaths.get(`${pageDomain}\u0000${groupId}`);
    if (!paths) continue;
    for (const link of page.links) {
      if (link.class !== 'H5L_TYPE_EXTERNAL') continue;
      if (link.h5domain && client.isAuthorized(link.h5domain)) continue;
      for (const base of paths) {
        boundaries.push({
          kind: 'external_unauthorized',
          path: `${base === '/' ? '' : base}/${link.title}`,
          domain: pageDomain,
          externalDomain: link.h5domain ?? null,
          detail: '遍历中见到的外部链接不在授权范围，未继续读取',
        });
      }
    }
  }

  if (!found) {
    return { domain, path: targetPath, object: null, gaps, boundaries };
  }

  const object = found.object;
  // 目标是通过软链接到达时，请求本身也是该对象在授权域内的一条组内路径。
  if (found.domain === domain) object.paths.add(targetPath);
  // 同一次遍历读到的组链接页里，指向同一对象 id 的硬链接都可作为别名记录，
  // 不额外读取数据块。
  for (const [key, page] of cache.links) {
    if (!page.links) continue;
    const [pageDomain, groupId] = key.split('\u0000');
    if (pageDomain !== found.domain) continue;
    const paths = cache.groupPaths.get(`${pageDomain}\u0000${groupId}`);
    if (!paths) continue;
    for (const link of page.links) {
      if (link.class !== 'H5L_TYPE_HARD' || link.collection !== 'datasets' || link.id !== found.id) continue;
      for (const base of paths) object.paths.add(`${base === '/' ? '' : base}/${link.title}`);
    }
  }

  return { domain, path: targetPath, object, gaps, boundaries };
}

async function readObjectWindow(client, cache, target, selection) {
  const { domain, id } = target;
  const observations = [];
  let attempt = 0;
  let metadata;
  let shape;

  for (;;) {
    try {
      metadata = await client.dataset(domain, id);
    } catch (error) {
      // 解析时对象还在，读取时消失：说明对象在读取期间被更换，不能装作读到旧内容。
      if (error.status === 404) {
        throw Object.assign(new Error('对象在读取期间消失或被替换'), {
          status: 409,
          code: 'object_changed_during_read',
          details: { domain, objectId: id, stage: 'metadata', observations, cause: error.message },
        });
      }
      throw error;
    }
    cache.stats.datasetMetadata += 1;
    cache.remember(metadata.snapshot);
    shape = validateShape(metadata.data.shape);
    validateType(metadata.data.type);
    checkWindowWithinMaxDims(selection, metadata.data.shape);
    try {
      checkWindowWithinShape(selection, shape.dims);
    } catch (error) {
      // 数组可能在读取期间扩展。再观察一次元数据；只有观察到形状或版本确实变化
      // 才重试，否则按越界报告，而不是用旧形状拼出窗口。
      const previous = observations.filter(item => item.stage === 'metadata').at(-1);
      const mayHaveGrown = !previous
        || previous.etag !== metadata.etag
        || JSON.stringify(previous.shape) !== JSON.stringify(shape.dims);
      if (mayHaveGrown && attempt < MAX_VERSION_RETRIES) {
        observations.push({
          stage: 'metadata',
          attempt,
          etag: metadata.etag,
          shape: [...shape.dims],
          lastModified: metadata.data.lastModified ?? null,
          windowOutOfBounds: true,
        });
        attempt += 1;
        continue;
      }
      throw Object.assign(error, {
        details: { ...(error.details ?? {}), observations, domain, objectId: id },
      });
    }
    const etag = metadata.etag;
    observations.push({
      stage: 'metadata',
      attempt,
      etag,
      shape: [...shape.dims],
      lastModified: metadata.data.lastModified ?? null,
    });

    let value;
    try {
      value = await client.value(domain, id, selection.expression, { etag });
      cache.stats.valueReads += 1;
      cache.remember(value.snapshot);
    } catch (error) {
      if (error.status === 404) {
        throw Object.assign(new Error('对象在读取期间消失或被替换'), {
          status: 409,
          code: 'object_changed_during_read',
          details: { domain, objectId: id, stage: 'value', etag, observations, cause: error.message },
        });
      }
      if (error.status === 400 && !etag && attempt < MAX_VERSION_RETRIES) {
        // 没有版本证明时，数组更换/收缩只能从窗口被拒看出来：重看元数据再判断。
        observations.push({ stage: 'value', attempt, etag: null, status: 400, detail: error.message });
        attempt += 1;
        continue;
      }
      if (error.code === 'source_version_changed' && attempt < MAX_VERSION_RETRIES) {
        observations.push({ stage: 'value', attempt, etag, status: 412, detail: error.message });
        attempt += 1;
        continue;
      }
      if (error.code === 'source_version_changed') {
        throw Object.assign(error, {
          details: { ...(error.details ?? {}), observations, shape: [...shape.dims], etag },
        });
      }
      throw error;
    }

    if (etag && value.etag && value.etag !== etag) {
      observations.push({ stage: 'value', attempt, etag, observedEtag: value.etag, status: 200 });
      if (attempt < MAX_VERSION_RETRIES) {
        attempt += 1;
        continue;
      }
      fail(412, 'source_version_changed', '读取期间来源对象版本已变化', {
        domain,
        objectId: id,
        expectedEtag: etag,
        observedEtag: value.etag,
        observations,
      });
    }

    const rows = value.data.value;
    if (!Array.isArray(rows) || rows.length !== selection.windowShape[0]
      || rows.some(row => !Array.isArray(row) || row.length !== selection.windowShape[1])) {
      const observed = {
        rows: Array.isArray(rows) ? rows.length : null,
        columns: Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0].length : null,
      };
      observations.push({ stage: 'value', attempt, etag: value.etag ?? null, status: 200, unexpectedShape: observed });
      // 返回形状与请求不一致本身就是矛盾：重看一次元数据并按新形状重读；
      // 重试次数有限，仍不一致就报告无法确认。
      if (attempt < MAX_VERSION_RETRIES) {
        attempt += 1;
        continue;
      }
      fail(502, 'source_invalid_response', '来源窗口形状与请求不一致，无法确认这份切片', {
        domain,
        objectId: id,
        requestedShape: selection.windowShape,
        observed,
        observations,
      });
    }

    observations.push({ stage: 'value', attempt, etag: value.etag ?? null, status: 200 });
    const changedDuringRead = observations.some(item => item.etag && item.etag !== value.etag);
    const finalEtag = value.etag ?? etag ?? null;
    return {
      selection,
      metadata: metadata.data,
      shape: { ...metadata.data.shape, dims: [...shape.dims] },
      value: rows,
      etag: finalEtag,
      version: {
        etag: finalEtag,
        // 有版本证明时，这份切片可回溯到确定的对象版本；
        // 没有时只能说“这是本次实际观察到的窗口”，不宣称原子快照。
        verified: !!finalEtag,
        scope: finalEtag ? 'object-version' : 'observed-window',
        atomicSnapshot: false,
        changedDuringRead,
        observations,
      },
      type: metadata.data.type,
      typeSummary: summarizeType(metadata.data.type),
      fillValue: metadata.data.creationProperties?.fillValue ?? null,
      lastModified: metadata.data.lastModified ?? null,
    };
  }
}

/**
 * 解析并读取一组目标路径的同一窗口。返回结构化记录与用于收件的证据快照。
 * 别名路径按对象身份合并，只读取一次元数据和一次数据。
 */
export async function readSlice(client, { domain, paths, selection: selectionInput, maxCells, maxSnapshots = 30 }) {
  client.assertAuthorized(domain);
  if (!Array.isArray(paths) || paths.length === 0) fail(400, 'invalid_path', '至少需要一个目标路径');
  if (paths.length > 50) fail(422, 'too_many_paths', '单次目标路径不能超过50个');
  const selection = parseSelection(selectionInput, { maxCells });
  const normalizedPaths = [];
  for (const path of paths) {
    const normalized = normalizeH5Path(path);
    if (!normalizedPaths.includes(normalized)) normalizedPaths.push(normalized);
  }

  const cache = createReadCache(client);
  const resolutions = [];
  for (const path of normalizedPaths) {
    try {
      resolutions.push(await resolvePath(client, cache, domain, path));
    } catch (error) {
      if (error.status !== 404) throw error;
      // 单目标请求指向组或越过数组时直接报告；多目标时记为缺口，不拖垮其他目标。
      if (normalizedPaths.length === 1) throw error;
      resolutions.push({
        domain,
        path,
        object: null,
        gaps: [{
          kind: 'not_a_dataset',
          affectsTarget: true,
          path,
          domain,
          detail: error.message,
          collection: error.details?.collection ?? null,
        }],
        boundaries: [],
      });
    }
  }

  const gaps = [];
  const boundaries = [];
  const seenBoundaries = new Set();
  const byObject = new Map();
  const targets = [];
  for (const resolution of resolutions) {
    for (const gap of resolution.gaps) gaps.push({ ...gap, requestedPath: resolution.path });
    for (const boundary of resolution.boundaries) {
      const key = `${boundary.domain}\u0000${boundary.path}\u0000${boundary.externalDomain}`;
      if (seenBoundaries.has(key)) continue;
      seenBoundaries.add(key);
      boundaries.push({ ...boundary, requestedPath: resolution.path });
    }
    if (!resolution.object) {
      targets.push({ path: resolution.path, domain, objectId: null, resolved: false });
      continue;
    }
    const identity = `${resolution.object.domain}\u0000${resolution.object.id}`;
    targets.push({
      path: resolution.path,
      domain: resolution.object.domain,
      objectId: resolution.object.id,
      resolved: true,
    });
    if (!byObject.has(identity)) byObject.set(identity, resolution.object);
  }

  if (byObject.size === 0) {
    fail(404, 'target_unresolved', '无法在授权域内解析目标数组', {
      domain,
      paths: normalizedPaths,
      targets,
      gaps,
      boundaries,
      coverage: { status: 'unresolved', requested: normalizedPaths.length, resolved: 0, gaps, boundaries },
    });
  }

  const objects = [];
  for (const target of byObject.values()) {
    const read = await readObjectWindow(client, cache, target, selection);
    objects.push({
      domain: target.domain,
      objectId: target.id,
      collection: target.collection,
      paths: [...target.paths],
      shape: read.shape,
      windowShape: selection.windowShape,
      selection: selection.expression,
      version: read.version,
      lastModified: read.lastModified,
      type: read.type,
      typeSummary: read.typeSummary,
      fillValue: read.fillValue,
      values: read.value,
      metadata: read.metadata,
    });
  }

  const unresolved = targets.filter(target => !target.resolved);
  // 缺口只影响对应目标；请求范围内的所有目标都解析成功才算完整。
  // 授权范围外的外部链接单列为边界，不影响本次请求的完整性。
  const complete = unresolved.length === 0;
  return {
    domain,
    selection,
    paths: normalizedPaths,
    targets,
    objects,
    gaps,
    boundaries,
    coverage: {
      status: complete ? 'complete' : 'partial',
      requested: normalizedPaths.length,
      resolved: targets.length - unresolved.length,
      unresolvedPaths: unresolved.map(target => target.path),
      arrays: objects.length,
      gaps,
      boundaries,
    },
    stats: { ...cache.stats },
    snapshots: snapshotList(cache, maxSnapshots),
  };
}

/** 兼容单路径调用。 */
export async function locateDataset(client, domain, path, { maxSnapshots = 30 } = {}) {
  const cache = createReadCache(client);
  const resolution = await resolvePath(client, cache, domain, path);
  return {
    domain,
    path: resolution.path,
    objectId: resolution.object?.id ?? null,
    collection: resolution.object?.collection ?? null,
    paths: resolution.object ? [...resolution.object.paths] : [],
    gaps: resolution.gaps,
    boundaries: resolution.boundaries,
    snapshots: snapshotList(cache, maxSnapshots),
  };
}
