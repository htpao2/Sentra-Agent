// Function-call fallback utilities: parse <sentra-tools> blocks and build instructions
// Prompts are loaded from JSON under src/agent/prompts/ via loader.
import { loadPrompt, renderTemplate } from '../agent/prompts/loader.js';
import { XMLParser } from 'fast-xml-parser';

/**
 * Extract <sentra-tools> ... </sentra-tools> blocks from text and parse to calls
 * Returns array of { name: string, arguments: any } using the Sentra XML Protocol.
 *
 * XML format (Sentra XML Protocol):
 * <sentra-tools>
 *   <invoke name="tool_name">
 *     <parameter name="param1"><string>value1</string></parameter>
 *     <parameter name="param2"><object>...</object></parameter>
 *   </invoke>
 * </sentra-tools>
 */
export function parseFunctionCalls(text = '', opts = {}) {
  if (!text || typeof text !== 'string') return [];
  // Relaxed <sentra-tools> matching: allow spaces/dashes/underscores and attributes, case-insensitive
  const reSentra = /<\s*sentra[-_\s]*tools\b[^>]*>([\s\S]*?)<\s*\/\s*sentra[-_\s]*tools\s*>/gi;
  const out = [];
  let m;
  while ((m = reSentra.exec(text)) !== null) {
    const raw = (m[1] || '').trim();
    // Parse Sentra XML tool call
    const xmlCall = parseSentraXML(raw);
    if (xmlCall) {
      out.push(xmlCall);
    }
  }
  return out;
}

/**
 * Build instruction text to ask the model to emit a single <function_call> block for a given function
 */
export async function buildFunctionCallInstruction({ name, parameters, locale = 'zh-CN' } = {}) {
  const prettySchema = parameters ? JSON.stringify(parameters, null, 2) : '{}';
  const req = Array.isArray(parameters?.required) ? parameters.required : [];
  let reqHintZh = req.length ? `- 必须包含必填字段: ${req.join(', ')}` : '- 如 schema 未列出必填字段：仅包含必要字段，避免冗余';
  let reqHintEn = req.length ? `- Must include required fields: ${req.join(', ')}` : '- If no required fields: include only necessary fields, avoid extras';

  // Highlight batch / array-style parameters for higher efficiency
  const arrayFields = [];
  if (parameters && typeof parameters === 'object' && parameters.properties && typeof parameters.properties === 'object') {
    for (const [key, value] of Object.entries(parameters.properties)) {
      const type = value && value.type;
      if (type === 'array' || (Array.isArray(type) && type.includes('array'))) {
        arrayFields.push(key);
      }
    }
  }

  if (arrayFields.length > 0) {
    const list = arrayFields.join(', ');
    reqHintZh += `\n- 下列参数在 schema 中是数组类型，适合批量处理：${list}。当用户希望对多个同类实体执行相同操作时，必须将它们合并到这些数组参数中，一次性调用该工具，而不是拆成多次单独调用。即便当前只有一个实体，只要 schema 要求 array，也要传入数组形式（例如 ["北京"]、["关键词"]）。`;
    reqHintEn += `\n- The following parameters are array-typed in the schema and are intended for batch processing: ${list}. When the user wants to apply the same operation to multiple similar items, you MUST combine them into these array parameters in a single tool call instead of issuing many nearly identical calls. Even for a single item, if the schema requires an array, you MUST still pass an array (e.g., ["Beijing"], ["keyword"]).`;
  } else {
    reqHintZh += '\n- 如果 schema 中出现数组类型参数（例如表示城市列表、查询列表、关键词列表等），应优先将多个同类目标合并到该数组中，一次性批量调用该工具，而不是多次单独调用。';
    reqHintEn += '\n- When the schema contains array-typed parameters (for example lists of cities, queries, or keywords), you should prefer batching multiple similar targets into that array and calling the tool once, instead of issuing many separate calls.';
  }

  const pf = await loadPrompt('fc_function_sentra');
  const tpl = String(locale).toLowerCase().startsWith('zh') ? pf.zh : pf.en;
  const vars = {
    name,
    schema: prettySchema,
    req_hint: String(locale).toLowerCase().startsWith('zh') ? reqHintZh : reqHintEn,
  };
  return renderTemplate(tpl, vars);
}

/**
 * Build planning instruction to emit emit_plan function call with plan schema and allowed tool names.
 */
export async function buildPlanFunctionCallInstruction({ allowedAiNames = [], locale = 'zh-CN' } = {}) {
  const allow = Array.isArray(allowedAiNames) && allowedAiNames.length ? allowedAiNames.join(', ') : '(无)';
  const hasAllow = Array.isArray(allowedAiNames) && allowedAiNames.length > 0;
  const schemaHint = JSON.stringify({
    overview: 'string (可选，总体目标与策略简述)',
    steps: [
      {
        aiName: 'string (必须在允许列表中)',
        reason: ['string', 'string', '...'] + ' (数组，每项为一个具体操作或理由)',
        nextStep: 'string',
        draftArgs: { '...': '...' },
        dependsOn: ['number 索引数组，可省略']
      }
    ]
  }, null, 2);
  const pf = await loadPrompt('fc_plan_sentra');
  const tpl = String(locale).toLowerCase().startsWith('zh') ? pf.zh : pf.en;

  // 加载规划约束提示（中英文+是否有 allowed 列表 两种分支）
  const pfReq = await loadPrompt('fc_plan_require_line');
  const isZh = String(locale).toLowerCase().startsWith('zh');
  const localeKey = isZh ? 'zh' : 'en';
  const reqBlock = (pfReq && pfReq[localeKey]) || {};
  const rawReqTpl = hasAllow ? reqBlock.has_allow : reqBlock.no_allow;
  const require_line = renderTemplate(rawReqTpl || '', { allowed_list: allow });

  const vars = {
    allowed_list: allow,
    require_line,
    schema_hint: schemaHint,
  };
  return renderTemplate(tpl, vars);
}

/**
 * Build policy text describing usage & constraints for function_call markers.
 */
export async function buildFCPolicy({ locale = 'en' } = {}) {
  const pf = await loadPrompt('fc_policy_sentra');
  const tpl = String(locale).toLowerCase().startsWith('zh') ? pf.zh : pf.en;
  const isZh = String(locale).toLowerCase().startsWith('zh');
  const base = renderTemplate(tpl, { tag: '<sentra-tools>' });

  const batchSectionZh = '\n\n## 批量调用与数组参数（效率优先）\n\n- 许多工具支持使用数组类型参数（例如 cities、queries、keywords 等）在一次调用中处理多个实体。\n- 在规划步骤和生成工具调用时，如果多个子需求可以由同一个工具完成，并且该工具有数组参数可用于批量输入，你必须优先将这些目标合并到一次批量调用中，而不是拆成多次几乎相同的调用。\n- 示例：用户要求“同时查询北京和上海的天气”，应规划并生成一次 weather 调用，参数形如 {"cities": ["北京", "上海"]}，而不是分别调用两次 weather。\n- 当某个工具已经将旧的单值参数升级为数组参数（例如 city → cities, query → queries, keyword → keywords），严禁继续使用旧的单值参数名称，也不要为每个实体分别创建步骤来模拟批量。\n- 始终关注用户体验与系统资源消耗，在保证正确性的前提下优先采用高效的批量调用方案。';

  const batchSectionEn = '\n\n## Batch Calls and Array Parameters (Efficiency First)\n\n- Many tools support array-typed parameters (for example cities, queries, keywords) to process multiple entities in a single call.\n- When planning steps and generating tool invocations, if multiple sub-tasks can be handled by the same tool and that tool exposes array parameters for batch input, you MUST prefer merging these targets into one batched call instead of issuing many nearly identical calls.\n- Example: when the user asks to "check the weather for both Beijing and Shanghai", you should plan and emit a single weather call with arguments like {"cities": ["Beijing", "Shanghai"]}, instead of calling weather twice.\n- When a tool has migrated from single-value parameters to array parameters (for example city → cities, query → queries, keyword → keywords), you MUST NOT keep using the old single-value parameter names, and you MUST NOT simulate batching by creating one step per entity.\n- Always care about user experience and resource usage: under correctness constraints, prefer efficient batched calls whenever possible.';

  return base + (isZh ? batchSectionZh : batchSectionEn);
}

function safeParseJson(s) {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s);
  } catch {
    // naive fallback: try best-effort extract from first { to last }
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) {
      const t = s.slice(i, j + 1);
      try { return JSON.parse(t); } catch {}
    }
  }
  return null;
}

// Simple XML entity unescape (kept local to avoid cross-module deps)
function unescapeXmlEntities(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

// Dedicated XML parser instance for <sentra-tools> blocks.
// We disable automatic value/attribute parsing so that type decoding is
// entirely controlled by our own typed node protocol
// (<string>/<number>/<boolean>/<null>/<array>/<object>).
const sentraToolsXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

// Best-effort parser for typed XML value blocks like
// <array><object>...</object></array> or <object><parameter ...>...</parameter></object>
function parseStructuredXmlValue(raw) {
  if (!raw) return { matched: false };
  const t = stripCodeFences(String(raw)).trim();
  if (!t) return { matched: false };

  // <array>...</array>
  const mArr = t.match(/<\s*array\b[^>]*>([\s\S]*?)<\s*\/\s*array\s*>/i);
  if (mArr) {
    const val = parseXmlArray(mArr[1] || '');
    return { matched: true, value: val };
  }

  // self-closing <array /> represents an empty array
  const mArrSelf = t.match(/<\s*array\b[^>]*\/\s*>/i);
  if (mArrSelf) {
    return { matched: true, value: [] };
  }

  // <object>...</object>
  const mObj = t.match(/<\s*object\b[^>]*>([\s\S]*?)<\s*\/\s*object\s*>/i);
  if (mObj) {
    const val = parseXmlObject(mObj[1] || '');
    return { matched: true, value: val };
  }

  // self-closing <object /> represents an empty object
  const mObjSelf = t.match(/<\s*object\b[^>]*\/\s*>/i);
  if (mObjSelf) {
    return { matched: true, value: {} };
  }

  // <string>...</string>
  const mStr = t.match(/<\s*string\b[^>]*>([\s\S]*?)<\s*\/\s*string\s*>/i);
  if (mStr) {
    const inner = mStr[1] || '';
    return { matched: true, value: unescapeXmlEntities(inner) };
  }

  // <number>...</number>
  const mNum = t.match(/<\s*number\b[^>]*>([\s\S]*?)<\s*\/\s*number\s*>/i);
  if (mNum) {
    const n = Number(String(mNum[1] || '').trim());
    if (!Number.isNaN(n)) {
      return { matched: true, value: n };
    }
  }

  // <boolean>...</boolean>
  const mBool = t.match(/<\s*boolean\b[^>]*>([\s\S]*?)<\s*\/\s*boolean\s*>/i);
  if (mBool) {
    const v = String(mBool[1] || '').trim().toLowerCase();
    if (v === 'true' || v === 'false') {
      return { matched: true, value: v === 'true' };
    }
  }

  // <null></null>
  const mNull = t.match(/<\s*null\b[^>]*>([\s\S]*?)<\s*\/\s*null\s*>/i);
  if (mNull) {
    return { matched: true, value: null };
  }

  return { matched: false };
}

function parseXmlArray(inner) {
  if (!inner || typeof inner !== 'string') return [];
  const items = [];
  const reChild = /<\s*(object|string|number|boolean|null|array)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
  let m;
  while ((m = reChild.exec(inner)) !== null) {
    const block = m[0] || '';
    const parsed = parseStructuredXmlValue(block);
    if (parsed && parsed.matched) {
      items.push(parsed.value);
    }
  }
  return items;
}

function parseXmlObject(inner) {
  const obj = {};
  if (!inner || typeof inner !== 'string') return obj;

  const seenKeys = new Set();

  // Object form: <object><parameter name="field">VALUE</parameter>...</object>
  const reParam = /<\s*parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;
  let m;
  while ((m = reParam.exec(inner)) !== null) {
    const key = String(m[1] || '').trim();
    const body = m[2] || '';
    if (!key || seenKeys.has(key)) continue;
    const parsed = parseStructuredXmlValue(body);
    if (parsed && parsed.matched) {
      obj[key] = parsed.value;
    } else {
      obj[key] = inferScalarType(body);
    }
    seenKeys.add(key);
  }

  return obj;
}

// Extract concatenated text content from a fast-xml-parser AST node.
function extractAstText(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((n) => extractAstText(n)).join('');
  }
  if (typeof node === 'object') {
    // Prefer explicit text node when present
    if (typeof node['#text'] === 'string') {
      return node['#text'];
    }
    let out = '';
    for (const [k, v] of Object.entries(node)) {
      if (k === '#text') continue;
      if (k.startsWith('@_')) continue;
      out += extractAstText(v);
    }
    return out;
  }
  return '';
}

function decodeAstTypedValue(node) {
  if (node == null) return null;
  if (typeof node !== 'object') {
    return inferScalarType(String(node));
  }

  if (Object.prototype.hasOwnProperty.call(node, 'string')) {
    // For tool arguments we expect XML-escaped special chars; decode them so
    // downstream tools receive raw text (HTML, code, etc.).
    const raw = extractAstText(node.string);
    return unescapeXmlEntities(raw);
  }
  if (Object.prototype.hasOwnProperty.call(node, 'number')) {
    const raw = extractAstText(node.number);
    const n = Number(String(raw).trim());
    return Number.isNaN(n) ? raw : n;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'boolean')) {
    const raw = String(extractAstText(node.boolean)).trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'null')) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'array')) {
    return decodeAstArray(node.array);
  }
  if (Object.prototype.hasOwnProperty.call(node, 'object')) {
    return decodeAstObject(node.object);
  }

  // Fallback: treat whole node as scalar text
  return inferScalarType(extractAstText(node));
}

function decodeAstArray(arrayNode) {
  if (arrayNode == null) return [];
  const values = [];
  const containers = Array.isArray(arrayNode) ? arrayNode : [arrayNode];
  const typeKeys = ['string', 'number', 'boolean', 'null', 'array', 'object'];

  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    for (const key of typeKeys) {
      if (!Object.prototype.hasOwnProperty.call(c, key)) continue;
      const raw = c[key];
      const items = Array.isArray(raw) ? raw : [raw];
      for (const it of items) {
        const wrapper = { [key]: it };
        values.push(decodeAstTypedValue(wrapper));
      }
    }
  }
  return values;
}

function decodeAstObject(objectNode) {
  const out = {};
  if (objectNode == null) return out;
  const containers = Array.isArray(objectNode) ? objectNode : [objectNode];

  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    const props = [];
    if (c.property !== undefined) {
      const list = Array.isArray(c.property) ? c.property : [c.property];
      props.push(...list);
    }
    if (c.parameter !== undefined) {
      const list = Array.isArray(c.parameter) ? c.parameter : [c.parameter];
      props.push(...list);
    }
    for (const p of props) {
      if (!p || typeof p !== 'object') continue;
      const key = String(p['@_name'] || '').trim();
      if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key] = decodeAstTypedValue(p);
    }
  }
  return out;
}

function parseSentraXMLFast(raw) {
  if (!raw) return null;
  const inner = stripCodeFences(raw);
  const wrapped = `<sentra-tools>${inner}</sentra-tools>`;
  let ast;
  try {
    ast = sentraToolsXmlParser.parse(wrapped);
  } catch {
    return null;
  }
  if (!ast || typeof ast !== 'object') return null;

  const root = ast['sentra-tools'] || ast.sentra_tools || ast;
  if (!root || typeof root !== 'object') return null;

  let invoke = root.invoke;
  if (!invoke) return null;
  if (Array.isArray(invoke)) invoke = invoke[0];
  if (!invoke || typeof invoke !== 'object') return null;

  const name = String(invoke['@_name'] || '').trim();
  if (!name) return null;

  const rawParams = invoke.parameter;
  const paramsArr = Array.isArray(rawParams) ? rawParams : (rawParams ? [rawParams] : []);
  const args = {};

  for (const p of paramsArr) {
    if (!p || typeof p !== 'object') continue;
    const paramName = String(p['@_name'] || '').trim();
    if (!paramName || Object.prototype.hasOwnProperty.call(args, paramName)) continue;

    // First try JSON if the entire parameter body is a raw JSON string
    const txt = extractAstText(p).trim();
    if ((txt.startsWith('{') && txt.endsWith('}')) || (txt.startsWith('[') && txt.endsWith(']'))) {
      const parsed = safeParseJson(txt);
      if (parsed !== null) {
        args[paramName] = parsed;
        continue;
      }
    }

    // Then apply typed-node decoding (<string>/<number>/<boolean>/<null>/<array>/<object>)
    const val = decodeAstTypedValue(p);
    args[paramName] = val;
  }

  if (Object.keys(args).length === 0) return null;
  return { name, arguments: args };
}
/**
 * Main Sentra XML parser entry: use fast-xml-parser AST mapping
 * for well-formed <sentra-tools> blocks. Malformed or non-XML
 * content simply yields null and is ignored.
 */
function parseSentraXML(raw) {
  if (!raw) return null;
  return parseSentraXMLFast(raw);
}

/**
 * Infer scalar type from string value
 * - Numbers: convert to number
 * - Booleans: convert to boolean
 * - null: convert to null
 * - Others: keep as string (preserve spaces)
 */
function inferScalarType(value) {
  if (typeof value !== 'string') return value;
  
  const trimmed = value.trim();
  
  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  
  // null
  if (trimmed === 'null') return null;
  
  // Number
  if (trimmed !== '' && !isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  
  // String (preserve original spacing)
  return value;
}

function stripCodeFences(s) {
  const t = String(s || '').trim();
  if (t.startsWith('```')) {
    // remove starting fence line
    const firstNl = t.indexOf('\n');
    if (firstNl >= 0) {
      const rest = t.slice(firstNl + 1);
      // remove ending fence if present
      const endIdx = rest.lastIndexOf('```');
      return endIdx >= 0 ? rest.slice(0, endIdx).trim() : rest.trim();
    }
  }
  return t;
}

/**
 * Format a tool call to Sentra XML format
 * @param {string} name - Tool name
 * @param {Object} args - Tool arguments
 * @returns {string} XML formatted tool call
 */
export function formatSentraToolCall(name, args = {}) {
  const params = Object.entries(args || {}).map(([key, value]) => {
    let content;
    if (typeof value === 'object' && value !== null) {
      content = JSON.stringify(value);
    } else if (typeof value === 'string') {
      content = value;
    } else {
      content = String(value);
    }
    return `    <parameter name="${key}">${content}</parameter>`;
  }).join('\n');
  
  return `<sentra-tools>
  <invoke name="${name}">
${params}
  </invoke>
</sentra-tools>`;
}

/**
 * Format a tool result to Sentra XML format
 * @param {Object} params
 * @param {number} params.stepIndex - Step index
 * @param {string} params.aiName - Tool name
 * @param {string|Array} params.reason - Reason for using the tool
 * @param {Object} params.args - Tool arguments
 * @param {Object} params.result - Tool execution result
 * @returns {string} XML formatted result
 */
export function formatSentraResult({ stepIndex, aiName, reason, args, result }) {
  const reasonText = Array.isArray(reason) ? reason.join('; ') : String(reason || '');
  const argsJson = JSON.stringify(args || {});
  const resultData = result?.data !== undefined ? result.data : result;
  const resultJson = JSON.stringify(resultData);
  const success = result?.success !== false;
  
  return `<sentra-result step="${stepIndex}" tool="${aiName}" success="${success}">
  <reason>${reasonText}</reason>
  <arguments>${argsJson}</arguments>
  <data>${resultJson}</data>
</sentra-result>`;
}

/**
 * Format user question to Sentra XML format
 * @param {string} question - User question text
 * @returns {string} XML formatted question
 */
export function formatSentraUserQuestion(question) {
  return `<sentra-user-question>${question}</sentra-user-question>`;
}

/**
 * Parse <sentra-result> XML format
 * Returns { stepIndex, aiName, reason, args, result, success }
 */
export function parseSentraResult(text) {
  if (!text || typeof text !== 'string') return null;
  const withoutFences = stripCodeFences(text);
  
  // Match <sentra-result step="..." tool="..." success="..."> ... </sentra-result>
  const reResult = /<\s*sentra-result\s+step\s*=\s*["']([^"']+)["']\s+tool\s*=\s*["']([^"']+)["'](?:\s+success\s*=\s*["']([^"']+)["'])?[^>]*>([\s\S]*?)<\s*\/\s*sentra-result\s*>/i;
  const mResult = withoutFences.match(reResult);
  if (!mResult) return null;
  
  const stepIndex = parseInt(mResult[1], 10);
  const aiName = String(mResult[2] || '').trim();
  const success = String(mResult[3] || 'true').toLowerCase() === 'true';
  const contentBlock = mResult[4] || '';
  
  // Extract <reason>, <arguments>, <data>
  const reReason = /<\s*reason\s*>([\s\S]*?)<\s*\/\s*reason\s*>/i;
  const reArgs = /<\s*arguments\s*>([\s\S]*?)<\s*\/\s*arguments\s*>/i;
  const reData = /<\s*data\s*>([\s\S]*?)<\s*\/\s*data\s*>/i;
  
  const mReason = contentBlock.match(reReason);
  const mArgs = contentBlock.match(reArgs);
  const mData = contentBlock.match(reData);
  
  const reason = mReason ? String(mReason[1] || '').trim() : '';
  let args = {};
  if (mArgs) {
    const rawArgs = mArgs[1] || '';
    const jsonArgs = safeParseJson(rawArgs);
    if (jsonArgs && typeof jsonArgs === 'object') {
      args = jsonArgs;
    } else {
      const parsed = parseStructuredXmlValue(rawArgs);
      if (parsed && parsed.matched) {
        args = parsed.value;
      } else {
        args = {};
      }
    }
  }

  let data = null;
  if (mData) {
    const rawData = mData[1] || '';
    const jsonData = safeParseJson(rawData);
    if (jsonData !== null) {
      data = jsonData;
    } else {
      const parsed = parseStructuredXmlValue(rawData);
      if (parsed && parsed.matched) {
        data = parsed.value;
      } else {
        data = rawData;
      }
    }
  }
  
  return { stepIndex, aiName, reason, args, result: { success, data }, success };
}

/**
 * Parse <sentra-user-question> XML format
 * Returns the question text
 */
export function parseSentraUserQuestion(text) {
  if (!text || typeof text !== 'string') return null;
  const withoutFences = stripCodeFences(text);
  
  const reQuestion = /<\s*sentra-user-question\s*>([\s\S]*?)<\s*\/\s*sentra-user-question\s*>/i;
  const mQuestion = withoutFences.match(reQuestion);
  if (!mQuestion) return null;
  
  return String(mQuestion[1] || '').trim();
}

export default { 
  parseFunctionCalls, 
  buildFunctionCallInstruction, 
  buildPlanFunctionCallInstruction, 
  buildFCPolicy,
  formatSentraToolCall,
  formatSentraResult,
  formatSentraUserQuestion,
  parseSentraResult,
  parseSentraUserQuestion
};
