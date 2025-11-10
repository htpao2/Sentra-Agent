// Function-call fallback utilities: parse <sentra-tools> blocks and build instructions
// Prompts are loaded from JSON under src/agent/prompts/ via loader.
import { loadPrompt, renderTemplate } from '../agent/prompts/loader.js';

/**
 * Extract <sentra-tools> ... </sentra-tools> blocks from text and parse to calls
 * Returns array of { name: string, arguments: any }
 * Supports both XML format (preferred) and legacy ReAct format
 * 
 * XML format (Sentra XML Protocol):
 * <sentra-tools>
 *   <invoke name="tool_name">
 *     <parameter name="param1">value1</parameter>
 *     <parameter name="param2">{"key": "value"}</parameter>
 *   </invoke>
 * </sentra-tools>
 * 
 * Legacy ReAct format (backward compatibility):
 * <sentra-tools>
 * Action: tool_name
 * Action Input: {...JSON...}
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
    // Try XML format first (preferred)
    const xmlCall = parseSentraXML(raw);
    if (xmlCall) {
      out.push(xmlCall);
      continue;
    }
    // Fallback to legacy ReAct format for backward compatibility
    const reactCall = parseSentraReAct(raw);
    if (reactCall) out.push(reactCall);
  }
  return out;
}

/**
 * Build instruction text to ask the model to emit a single <function_call> block for a given function
 */
export async function buildFunctionCallInstruction({ name, parameters, locale = 'zh-CN' } = {}) {
  const prettySchema = parameters ? JSON.stringify(parameters, null, 2) : '{}';
  const req = Array.isArray(parameters?.required) ? parameters.required : [];
  const reqHintZh = req.length ? `- 必须包含必填字段: ${req.join(', ')}` : '- 如 schema 未列出必填字段：仅包含必要字段，避免冗余';
  const reqHintEn = req.length ? `- Must include required fields: ${req.join(', ')}` : '- If no required fields: include only necessary fields, avoid extras';
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
    plan: {
      overview: 'string (可选)',
      steps: [
        {
          aiName: 'string (必须在允许列表中)',
          reason: ['string', 'string', '...'] + ' (数组，每项为一个具体操作或理由)',
          nextStep: 'string',
          draftArgs: { '...': '...' },
          dependsOn: ['number 索引数组，可省略']
        }
      ]
    }
  }, null, 2);
  const pf = await loadPrompt('fc_plan_sentra');
  const tpl = String(locale).toLowerCase().startsWith('zh') ? pf.zh : pf.en;
  const vars = {
    allowed_list: allow,
    require_line: hasAllow
      ? (String(locale).toLowerCase().startsWith('zh') ? '- 允许列表非空：steps 至少包含 1 步；若无法直接完成，请选择最接近的工具用于信息收集/授权/诊断等前置步骤。' : '- When allowed tools exist: include at least 1 step; if direct completion is not possible, pick the closest tool to gather info/request authorization/diagnose.')
      : (String(locale).toLowerCase().startsWith('zh') ? '- 若确无合适工具，可输出空 steps 数组。' : '- If truly no tool fits, you may output an empty steps array.'),
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
  return renderTemplate(tpl, { tag: '<sentra-tools>' });
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

/**
 * Parse Sentra XML Protocol format:
 * <invoke name="tool_name">
 *   <parameter name="param1">value1</parameter>
 *   <parameter name="param2">{"key": "value"}</parameter>
 * </invoke>
 * 
 * Key features:
 * - String/scalar parameters: specified directly (no escaping needed)
 * - Lists/objects: use JSON format
 * - Spaces in string values are preserved
 * - Parsed with regex (not strict XML validation)
 */
function parseSentraXML(raw) {
  if (!raw) return null;
  const withoutFences = stripCodeFences(raw);
  
  // Match <invoke name="..."> ... </invoke>
  const reInvoke = /<\s*invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*invoke\s*>/i;
  const mInvoke = withoutFences.match(reInvoke);
  if (!mInvoke) return null;
  
  const name = String(mInvoke[1] || '').trim();
  const paramsBlock = mInvoke[2] || '';
  
  // Extract all <parameter name="...">...</parameter> pairs
  const reParam = /<\s*parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;
  const args = {};
  let paramMatch;
  
  while ((paramMatch = reParam.exec(paramsBlock)) !== null) {
    const paramName = String(paramMatch[1] || '').trim();
    const paramValue = paramMatch[2] || '';
    
    if (!paramName) continue;
    
    // Try to parse as JSON first (for objects/arrays)
    const trimmed = paramValue.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || 
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      const parsed = safeParseJson(trimmed);
      if (parsed !== null) {
        args[paramName] = parsed;
        continue;
      }
    }
    
    // Otherwise treat as string/scalar (preserve spaces, try type inference)
    const value = inferScalarType(paramValue);
    args[paramName] = value;
  }
  
  if (Object.keys(args).length === 0) return null;
  return { name, arguments: args };
}

/**
 * Parse legacy ReAct format (backward compatibility):
 * Action: tool_name
 * Action Input: {...JSON...}
 */
function parseSentraReAct(raw) {
  if (!raw) return null;
  const withoutFences = stripCodeFences(raw);
  // Allow Chinese colon, varying spaces/cases
  const mName = withoutFences.match(/^\s*Action\s*[:：]\s*(.+)$/mi);
  if (!mName) return null;
  const name = String(mName[1] || '').trim();
  // Find start of Action Input
  const reInput = /^\s*Action\s*[-_]*\s*Input\s*[:：]\s*/mi;
  const mi = withoutFences.match(reInput);
  if (!mi) return null;
  const idx = withoutFences.search(reInput);
  const start = idx + mi[0].length;
  const jsonText = String(withoutFences.slice(start)).trim();
  const args = (typeof jsonText === 'string') ? safeParseJson(jsonText) : null;
  if (!args || typeof args !== 'object') return null;
  return { name, arguments: args };
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
  const args = mArgs ? safeParseJson(mArgs[1]) : {};
  const data = mData ? safeParseJson(mData[1]) : null;
  
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
