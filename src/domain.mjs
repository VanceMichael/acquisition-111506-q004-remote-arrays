export const product = "实验切片收件服务";
export const requiredFields = ["sliceId", "dataset", "selection", "values"];
export const businessKey = "sliceId";
export const defaultAuthorizedDomains = ["/lab/authorized.h5"];

export function validateRecord(input) {
  const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('收件内容必须是对象');
  for (const field of requiredFields) if (!(field in input) || input[field] === null) fail(`缺少业务字段：${field}`);
  if (typeof input[businessKey] !== 'string' || !input[businessKey].trim() || input[businessKey].length > 512) fail('业务标识无效');
  const record = structuredClone(input);
  return { key: record[businessKey], record };
}

function collectFail(message, details) {
  throw Object.assign(new Error(message), { status: 422, details });
}

/** 校验自动采集请求：授权域、一个或多个组内路径、以及二维窗口。 */
export function validateCollectRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('采集请求必须是对象'), { status: 400 });
  }
  if (typeof input.domain !== 'string' || !input.domain.trim()) collectFail('采集请求缺少授权域 domain');
  if (input.domain.length > 4096) collectFail('授权域名称过长');
  const rawPaths = Array.isArray(input.paths) ? input.paths : [input.path];
  if (rawPaths.some(path => typeof path !== 'string' || !path.trim())) collectFail('采集请求缺少目标路径');
  const paths = [];
  for (const path of rawPaths) if (!paths.includes(path.trim())) paths.push(path.trim());
  if (paths.length === 0) collectFail('至少需要一个目标路径');
  if (paths.length > 50) collectFail('单次目标路径不能超过50个');
  if (typeof input.selection !== 'string' || !input.selection.trim()) collectFail('采集请求缺少窗口 selection');
  if (input.sliceId !== undefined) {
    if (typeof input.sliceId !== 'string' || !input.sliceId.trim() || input.sliceId.length > 512) collectFail('业务标识无效');
  }
  return { domain: input.domain.trim(), paths, selection: input.selection.trim(), sliceId: input.sliceId?.trim() ?? null };
}

