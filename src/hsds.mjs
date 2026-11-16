
import { fail } from './hdf.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    fail(422, 'invalid_source', '来源地址不能为空');
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    fail(422, 'invalid_source', '来源地址不是有效URL', { sourceUrl: input });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(422, 'invalid_source', '来源地址只支持 http 或 https', { sourceUrl: input });
  }
  return url;
}

function upstreamDetail(body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      return parsed.error ?? parsed.detail ?? null;
    }
  } catch {
    // 来源可能返回纯文本错误，只保留截断内容。
  }
  const text = body.toString('utf8').trim();
  return text ? text.slice(0, 300) : null;
}

/**
 * 最小 HSDS 读取客户端。只访问显式授权域；每次响应保留原始字节，
 * 供收件端作为来源依据回查。不解释 HDF5 二进制，只使用契约声明的 JSON 入口。
 */
export class HsdsClient {
  constructor({
    baseUrl, authorizedDomains, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = 16 * 1024 * 1024,
    fetchImpl = globalThis.fetch,
  }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.authorizedDomains = new Set(authorizedDomains);
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.fetchImpl = fetchImpl;
  }

  isAuthorized(domain) {
    return typeof domain === 'string' && this.authorizedDomains.has(domain);
  }

  assertAuthorized(domain) {
    if (!this.isAuthorized(domain)) {
      fail(403, 'domain_not_authorized', `域不在授权范围内：${String(domain)}`, {
        domain: domain ?? null,
        authorizedDomains: [...this.authorizedDomains],
      });
    }
  }

  async request(domain, pathname, { etag = null, query = null, accept = 'application/json' } = {}) {
    this.assertAuthorized(domain);
    const url = new URL(this.baseUrl.href);
    const basePath = url.pathname.replace(/\/+$/, '');
    // 拼在来源基地址之后，保留部署可能使用的路径前缀。
    url.pathname = basePath + pathname;
    url.search = '';
    if (query) {
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    }
    const headers = { 'x-hdf-domain': domain, accept };
    if (etag) headers['if-match'] = etag;

    let response;
    try {
      response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      fail(502, 'source_unreachable', '无法连接来源服务', {
        sourceUrl: this.baseUrl.href,
        domain,
        detail: error?.message ?? String(error),
      });
    }

    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > this.maxResponseBytes) {
      fail(502, 'source_response_too_large', '来源响应超过单次读取上限', {
        sourceUrl: this.baseUrl.href,
        domain,
        path: requestPath,
        size: raw.length,
        max: this.maxResponseBytes,
      });
    }
    const mediaType = response.headers.get('content-type') ?? 'application/octet-stream';
    const responseEtag = response.headers.get('etag') ?? null;
    const requestPath = `${pathname}${url.search}`;
    const snapshot = {
      // ETag 不在原始响应体里，写进来源说明才能从依据回查对象版本。
      source: `hsds:${domain}#GET ${requestPath}${responseEtag ? ` @${responseEtag}` : ''}`,
      bytes: raw,
      mediaType,
      status: response.status,
      etag: responseEtag,
      domain,
      path: pathname,
      query: url.search,
    };

    if (!response.ok) {
      const detail = upstreamDetail(raw);
      const details = { sourceUrl: this.baseUrl.href, domain, path: requestPath, status: response.status, detail };
      const reject = (status, code, message) => {
        throw Object.assign(new Error(message), { status, code, details, snapshot });
      };
      if (response.status === 403) reject(403, 'source_domain_forbidden', '来源拒绝该域的访问');
      if (response.status === 404) reject(404, 'source_not_found', '来源中不存在目标对象或路径');
      if (response.status === 412) reject(412, 'source_version_changed', '读取期间来源对象版本已变化');
      if (response.status === 400) reject(400, 'source_rejected_request', '来源拒绝了读取参数');
      if (response.status === 429) reject(429, 'source_busy', '来源暂时限流');
      if (response.status >= 500) reject(502, 'source_failure', '来源服务返回失败');
      reject(502, 'source_error', `来源返回意外状态：${response.status}`);
    }

    let data = null;
    if (raw.length !== 0) {
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch {
        fail(502, 'source_invalid_response', '来源返回的不是有效JSON', {
          sourceUrl: this.baseUrl.href,
          domain,
          path: requestPath,
          mediaType,
        });
      }
    }
    return { data, raw, mediaType, etag: responseEtag, snapshot, status: response.status };
  }

  async root(domain) {
    const result = await this.request(domain, '/');
    const id = result.data?.root;
    if (typeof id !== 'string' || !id) {
      fail(502, 'source_invalid_response', '来源根组响应缺少 root', { domain });
    }
    return { id, ...result };
  }

  async groupLinks(domain, id) {
    const result = await this.request(domain, `/groups/${encodeURIComponent(id)}/links`);
    const links = result.data?.links;
    if (!Array.isArray(links)) {
      fail(502, 'source_invalid_response', '来源组链接响应缺少 links 数组', { domain, group: id });
    }
    return { links, ...result };
  }

  async dataset(domain, id, { etag = null } = {}) {
    const result = await this.request(domain, `/datasets/${encodeURIComponent(id)}`, { etag });
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
      fail(502, 'source_invalid_response', '来源数组元数据不是对象', { domain, dataset: id });
    }
    return result;
  }

  async value(domain, id, expression, { etag = null } = {}) {
    const result = await this.request(domain, `/datasets/${encodeURIComponent(id)}/value`, {
      etag,
      query: { select: expression },
    });
    if (!result.data || !Array.isArray(result.data.value)) {
      fail(502, 'source_invalid_response', '来源窗口响应缺少 value 数组', { domain, dataset: id });
    }
    return result;
  }
}
