
export const fail = (status, code, message, details) => {
  throw Object.assign(new Error(message), { status, code, details });
};

/** 规范化组内路径。相对路径按授权域根组解释；`.`,`..` 和控制字符一律拒绝。 */
export function normalizeH5Path(input) {
  if (typeof input !== 'string' || !input.trim()) {
    fail(400, 'invalid_path', '目标路径不能为空');
  }
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    fail(400, 'invalid_path', '目标路径包含控制字符', { path: input });
  }
  const segments = input.split('/').filter(segment => segment !== '');
  if (segments.some(segment => segment === '.' || segment === '..')) {
    fail(400, 'invalid_path', '目标路径不能包含 . 或 ..', { path: input });
  }
  return `/${segments.join('/')}`;
}

/** 解析 `[起行:止行,起列:止列]` 的半开二维窗口，不改写来源返回的值。 */
export function parseSelection(input, { maxCells = 1_000_000 } = {}) {
  if (typeof input !== 'string') fail(400, 'invalid_selection', '窗口必须是 [起行:止行,起列:止列] 形式的字符串');
  const match = /^\s*\[\s*(\d+)\s*:\s*(\d+)\s*,\s*(\d+)\s*:\s*(\d+)\s*\]\s*$/.exec(input);
  if (!match) fail(400, 'invalid_selection', '窗口必须是 [起行:止行,起列:止列] 形式的字符串');
  const [rowStart, rowStop, colStart, colStop] = match.slice(1).map(Number);
  if (![rowStart, rowStop, colStart, colStop].every(Number.isSafeInteger)) {
    fail(400, 'invalid_selection', '窗口边界必须是安全整数');
  }
  if (rowStart > rowStop || colStart > colStop) fail(400, 'invalid_selection', '窗口起点不能大于终点');
  const rows = rowStop - rowStart;
  const columns = colStop - colStart;
  if (rows * columns > maxCells) {
    fail(413, 'selection_too_large', `窗口包含 ${rows * columns} 个元素，超过单次上限 ${maxCells}`, {
      windowShape: [rows, columns], maxCells,
    });
  }
  return {
    expression: `[${rowStart}:${rowStop},${colStart}:${colStop}]`,
    ranges: [
      { start: rowStart, stop: rowStop },
      { start: colStart, stop: colStop },
    ],
    windowShape: [rows, columns],
    cells: rows * columns,
  };
}

/** 只接受合作端声明支持的二维简单空间。 */
export function validateShape(shape) {
  if (!shape || typeof shape !== 'object' || shape.class !== 'H5S_SIMPLE'
    || !Array.isArray(shape.dims) || shape.dims.length !== 2
    || !shape.dims.every(value => Number.isSafeInteger(value) && value >= 0)) {
    fail(422, 'unsupported_shape', '不能解释该数组的形状：仅支持二维简单空间', { shape: shape ?? null });
  }
  return { dims: [...shape.dims] };
}

export function checkWindowWithinShape(selection, dims) {
  const outside = selection.ranges.some((range, dimension) => range.stop > dims[dimension]);
  if (outside) {
    fail(400, 'selection_out_of_bounds', '窗口超出来源数组的声明形状', {
      selection: selection.expression,
      shape: [...dims],
    });
  }
}

/**
 * maxdims 为 0 表示该维可无限扩展；其他值是硬上限。
 * 窗口超出硬上限时，等待扩展没有意义，应立即报告。
 */
export function checkWindowWithinMaxDims(selection, shape) {
  if (!Array.isArray(shape.maxdims) || shape.maxdims.length !== selection.ranges.length) return;
  const outside = selection.ranges.some((range, dimension) => {
    const limit = shape.maxdims[dimension];
    return Number.isSafeInteger(limit) && limit > 0 && range.stop > limit;
  });
  if (outside) {
    fail(400, 'selection_out_of_bounds', '窗口超出来源数组的最大维度', {
      selection: selection.expression,
      shape: Array.isArray(shape.dims) ? [...shape.dims] : null,
      maxdims: [...shape.maxdims],
    });
  }
}

const NUMERIC_NAME = /^H5T_(?:IEEE|STD)_[A-Z0-9_]+$/;
const STRING_NAME = /^H5T_(?:C_S1|FORTRAN_S1)$/;

/** 检查类型是否属于契约声明的范围：固定数值、字符串，以及由它们组成的复合类型。 */
export function validateType(type, { field = null, seen = new Set() } = {}) {
  const location = field ? { field } : {};
  if (typeof type === 'string') {
    if (NUMERIC_NAME.test(type) || type === 'H5T_INTEGER' || type === 'H5T_FLOAT' || STRING_NAME.test(type)) return;
    fail(422, 'unsupported_type', `不能解释来源类型：${type}`, { type, ...location });
  }
  if (!type || typeof type !== 'object' || Array.isArray(type)) {
    fail(422, 'unsupported_type', '不能解释来源类型', { type: type ?? null, ...location });
  }
  if (seen.has(type)) fail(422, 'unsupported_type', '来源类型存在循环引用', { type, ...location });
  seen.add(type);
  try {
    switch (type.class) {
      case 'H5T_INTEGER':
      case 'H5T_FLOAT':
        return;
      case 'H5T_STRING': {
        const variable = type.length === 'H5T_VARIABLE';
        const fixed = Number.isSafeInteger(type.length) && type.length > 0;
        if (!variable && !fixed) {
          fail(422, 'unsupported_type', '不能解释字符串类型长度', { type, ...location });
        }
        if (type.charSet !== undefined && type.charSet !== 'H5T_CSET_UTF8' && type.charSet !== 'H5T_CSET_ASCII') {
          fail(422, 'unsupported_type', `不能解释字符串字符集：${type.charSet}`, { type, ...location });
        }
        return;
      }
      case 'H5T_COMPOUND': {
        if (!Array.isArray(type.fields) || type.fields.length === 0) {
          fail(422, 'unsupported_type', '复合类型没有可解释的字段', { type, ...location });
        }
        const names = new Set();
        for (const item of type.fields) {
          if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name) {
            fail(422, 'unsupported_type', '复合类型字段缺少名称', { type, ...location });
          }
          if (names.has(item.name)) {
            fail(422, 'unsupported_type', `复合类型字段重名：${item.name}`, { type, ...location });
          }
          names.add(item.name);
          if (!('type' in item)) {
            fail(422, 'unsupported_type', `复合类型字段 ${item.name} 缺少类型`, { type, ...location });
          }
          validateType(item.type, { field: item.name, seen });
        }
        return;
      }
      default:
        fail(422, 'unsupported_type', `不能解释来源类型：${type.class ?? '未声明'}`, { type, ...location });
    }
  } finally {
    seen.delete(type);
  }
}

/** 便于收件端直接看到保留了哪些字段，不替代原始 type。 */
export function summarizeType(type) {
  if (!type || typeof type !== 'object') return { kind: 'numeric-or-string' };
  if (type.class === 'H5T_COMPOUND') {
    return {
      kind: 'compound',
      fields: type.fields.map(field => field.name),
      variableLengthStrings: type.fields
        .filter(field => field.type && typeof field.type === 'object'
          && field.type.class === 'H5T_STRING' && field.type.length === 'H5T_VARIABLE')
        .map(field => field.name),
    };
  }
  return { kind: type.class ?? 'unknown' };
}
