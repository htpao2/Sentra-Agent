/**
 * 用户画像管理器 - 基于 LLM 的渐进式用户认知构建系统
 * 
 * 核心功能：
 * 1. 按 sender_id 分类存储用户消息历史
 * 2. 每 N 条消息触发一次画像分析和优化
 * 3. 初期构建认知大纲，后续不断细化
 * 4. 使用 LLM 分析用户特征，生成中文画像
 * 
 * 设计参考：
 * - Episodic Memory: LLM-Generated Summaries
 * - Dynamic Persona Modeling: Incremental Refinement
 * - Hybrid Memory: Short-term + Long-term
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractXMLTag, extractAllXMLTags } from './xmlUtils.js';
import { createLogger } from './logger.js';
import { repairSentraPersona } from './formatRepair.js';
import { getEnv, getEnvInt, getEnvBool } from './envHotReloader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('PersonaManager');

// 移除 tools 定义，统一使用 XML 解析

class UserPersonaManager {
  constructor(options = {}) {
    // 配置参数
    this.agent = options.agent; // Agent 实例（必需）
    if (!this.agent) {
      throw new Error('UserPersonaManager requires an agent instance');
    }
    this.dataDir = options.dataDir || path.join(process.cwd(), 'userData');
    
    // 时间间隔控制（毫秒）- 默认 10 分钟
    this.updateIntervalMs = options.updateIntervalMs || getEnvInt('PERSONA_UPDATE_INTERVAL_MS', 600000);
    
    // 消息阈值 - 距离上次更新至少需要积累的消息数
    this.minMessagesForUpdate = options.minMessagesForUpdate || getEnvInt('PERSONA_MIN_MESSAGES', 10);
    
    this.maxHistorySize = options.maxHistorySize || 100; // 最多保留历史消息数
    this.model = options.model || getEnv('PERSONA_MODEL', 'gpt-4.1-mini');
    this.recentMessagesCount = options.recentMessagesCount || getEnvInt('PERSONA_RECENT_MESSAGES', 40);
    this.halfLifeMs = options.halfLifeMs || getEnvInt('PERSONA_HALFLIFE_MS', 172800000);
    this.maxTraits = options.maxTraits || getEnvInt('PERSONA_MAX_TRAITS', 6);
    this.maxInterests = options.maxInterests || getEnvInt('PERSONA_MAX_INTERESTS', 8);
    this.maxPatterns = options.maxPatterns || getEnvInt('PERSONA_MAX_PATTERNS', 6);
    this.maxInsights = options.maxInsights || getEnvInt('PERSONA_MAX_INSIGHTS', 6);
    
    // 内存缓存 - 减少文件读写
    this.cache = new Map(); // sender_id -> { persona, messages, messageCount }
    
    // 待执行更新的标记 - 防止同一时间多次触发
    this.pendingUpdates = new Set(); // sender_id
    
    // 确保数据目录存在
    this._ensureDataDir();
    
    logger.config('用户画像管理器初始化', {
      '数据目录': this.dataDir,
      '时间间隔': `${this.updateIntervalMs / 60000} 分钟`,
      '消息阈值': `至少 ${this.minMessagesForUpdate} 条新消息`,
      '使用模型': this.model,
      '最大历史': `${this.maxHistorySize} 条消息`,
      '最近消息窗口': `${this.recentMessagesCount} 条`,
      '半衰期(ms)': this.halfLifeMs,
      'TopK-特征/兴趣/模式/洞察': `${this.maxTraits}/${this.maxInterests}/${this.maxPatterns}/${this.maxInsights}`
    });
  }

  /**
   * 确保数据目录存在
   */
  _ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      logger.success(`创建数据目录: ${this.dataDir}`);
    }
  }

  /**
   * 获取用户数据文件路径
   */
  _getUserFilePath(senderId) {
    // 安全的文件名（移除特殊字符）
    const safeId = String(senderId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dataDir, `${safeId}.json`);
  }

  /**
   * 加载用户数据
   */
  _loadUserData(senderId) {
    // 先从缓存读取
    if (this.cache.has(senderId)) {
      return this.cache.get(senderId);
    }

    const filePath = this._getUserFilePath(senderId);
    
    if (!fs.existsSync(filePath)) {
      // 新用户，创建初始数据结构
      const initialData = {
        senderId,
        persona: null, // 尚未构建画像
        messages: [], // 消息历史
        messageCount: 0, // 总消息数
        lastUpdateCount: 0, // 上次更新时的消息数
        lastUpdateTime: null, // 上次更新的时间戳（毫秒）
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 0, // 画像版本号
        personaStats: {
          traits: {},
          interests: {},
          patterns: {},
          insights: {}
        }
      };
      this.cache.set(senderId, initialData);
      return initialData;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      if (!data.personaStats) {
        data.personaStats = { traits: {}, interests: {}, patterns: {}, insights: {} };
      }
      this.cache.set(senderId, data);
      return data;
    } catch (error) {
      logger.error(`加载用户数据失败 (${senderId})`, error);
      return null;
    }
  }

  /**
   * 保存用户数据
   */
  _saveUserData(senderId, data) {
    const filePath = this._getUserFilePath(senderId);
    
    try {
      data.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      this.cache.set(senderId, data); // 更新缓存
      return true;
    } catch (error) {
      logger.error(`保存用户数据失败 (${senderId})`, error);
      return false;
    }
  }

  /**
   * 记录用户消息
   * @param {string} senderId - 发送者 ID
   * @param {object} message - 消息对象 { text, timestamp, senderName, groupId, etc. }
   */
  async recordMessage(senderId, message) {
    const userData = this._loadUserData(senderId);
    if (!userData) return;

    // 添加消息到历史
    userData.messages.push({
      text: message.text || '',
      timestamp: message.timestamp || new Date().toISOString(),
      senderName: message.senderName || '未知',
      groupId: message.groupId || null,
      ...message
    });

    userData.messageCount++;

    // 限制历史消息大小
    if (userData.messages.length > this.maxHistorySize) {
      userData.messages = userData.messages.slice(-this.maxHistorySize);
    }

    // 保存数据
    this._saveUserData(senderId, userData);

    // 检查是否需要更新画像（基于时间间隔 + 消息阈值双重控制）
    this._checkAndScheduleUpdate(senderId, userData);
  }

  /**
   * 检查并调度画像更新
   * @private
   */
  _checkAndScheduleUpdate(senderId, userData) {
    // 1. 检查是否已有待执行的更新（防重）
    if (this.pendingUpdates.has(senderId)) {
      logger.debug(`[画像] ${senderId} 已有待执行的更新，跳过`);
      return;
    }

    // 2. 计算新增消息数
    const messagesSinceUpdate = userData.messageCount - userData.lastUpdateCount;
    
    // 3. 检查消息阈值
    if (messagesSinceUpdate < this.minMessagesForUpdate) {
      logger.debug(`[画像] ${senderId} 新增消息数 ${messagesSinceUpdate} < 阈值 ${this.minMessagesForUpdate}，跳过`);
      return;
    }

    // 4. 检查时间间隔
    const now = Date.now();
    const lastUpdateTime = userData.lastUpdateTime;
    
    // 如果不是首次更新，检查时间间隔
    if (lastUpdateTime && lastUpdateTime > 0) {
      const timeSinceUpdate = now - lastUpdateTime;
      
      if (timeSinceUpdate < this.updateIntervalMs) {
        const remainingMinutes = Math.ceil((this.updateIntervalMs - timeSinceUpdate) / 60000);
        logger.debug(`[画像] ${senderId} 距离上次更新仅 ${Math.floor(timeSinceUpdate / 60000)} 分钟，需等待 ${remainingMinutes} 分钟`);
        return;
      }
      
      // 5. 满足条件，触发更新（非首次）
      logger.info(`[画像] ${senderId} 触发更新 - 新增 ${messagesSinceUpdate} 条消息，距上次更新 ${Math.floor(timeSinceUpdate / 60000)} 分钟`);
    } else {
      // 5. 首次更新
      logger.info(`[画像] ${senderId} 触发首次更新 - 累积 ${messagesSinceUpdate} 条消息`);
    }
    
    // 标记为待执行，防止重复触发
    this.pendingUpdates.add(senderId);
    
    // 异步执行，不阻塞主流程
    setImmediate(() => {
      this.updatePersona(senderId).catch(err => {
        logger.error(`[画像] ${senderId} 异步更新失败`, err);
      }).finally(() => {
        // 清除待执行标记
        this.pendingUpdates.delete(senderId);
      });
    });
  }

  /**
   * 更新用户画像（使用 LLM 分析）
   */
  async updatePersona(senderId) {
    const userData = this._loadUserData(senderId);
    if (!userData || userData.messages.length === 0) return;

    try {
      logger.info(`[画像] 开始分析用户画像 (${senderId})...`);

      // 准备分析数据
      const recentMessages = userData.messages.slice(-this.recentMessagesCount);
      const isFirstTime = !userData.persona; // 是否首次构建

      // 调用 LLM 分析
      const newPersona = await this._analyzePersona(
        recentMessages,
        userData.persona,
        isFirstTime,
        senderId
      );

      if (newPersona) {
        const merged = this._mergePersonaWithStats(userData, newPersona);
        userData.persona = merged;
        userData.version++;
        userData.lastUpdateCount = userData.messageCount;
        userData.lastUpdateTime = Date.now(); // ✅ 记录更新时间
        
        this._saveUserData(senderId, userData);
        
        logger.info(`[画像] ${senderId} 画像更新成功 - 版本 ${userData.version}`);
        logger.info(this._getPersonaSummary(newPersona));
      }
    } catch (error) {
      logger.error('画像更新失败', error);
    }
  }

  /**
   * 使用 LLM 分析用户画像（统一使用 XML 解析）
   */
  async _analyzePersona(recentMessages, existingPersona, isFirstTime, senderId) {
    const prompt = this._buildAnalysisPrompt(recentMessages, existingPersona, isFirstTime, senderId);
    
    try {
      const response = await this.agent.chat(
        [
          {
            role: 'system',
            content: this._getSystemPrompt(isFirstTime)
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        {
          model: this.model,
          temperature: 1,
          max_tokens: 2000
        }
      );

      // 统一使用 XML 解析
      const responseText = response.content || (typeof response === 'string' ? response : '');
      
      if (!responseText) {
        throw new Error('LLM 返回内容为空');
      }
      
      logger.debug('使用 XML 解析模式');
      const parsed = await this._parsePersonaResponse(responseText, senderId);
      return parsed;
      
    } catch (error) {
      logger.error('LLM 分析失败', error);
      return null;
    }
  }

  /**
   * 获取系统提示词 - 使用 Sentra XML 协议
   */
  _getSystemPrompt(isFirstTime) {
    if (isFirstTime) {
      // 首次构建 - 关注大纲和框架
      return `# User Persona Analysis System - Initial Profile Construction

You are an expert user profiling analyst specialized in building comprehensive user personas from conversation patterns.

## Critical Protocols

**OUTPUT FORMAT**: You MUST use Sentra XML Protocol format
**LANGUAGE**: All content MUST be in Chinese (中文)
**EXECUTION**: Output XML directly in your response (NO explanations outside XML)

## Your Task

Analyze the provided conversation history and construct an **initial user persona profile**. Focus on establishing a solid framework that can be refined over time.

## Analysis Dimensions

Study the user across these dimensions:

1. **Core Essence** (核心本质)
   - One-sentence fundamental character summary
   - Must capture the user's defining essence

2. **Personality Traits** (性格特征)
   - Observable behavioral patterns
   - Psychological characteristics
   - 3-5 specific, evidence-based traits

3. **Communication Style** (沟通风格)
   - How they express themselves
   - Word choice, tone, formality
   - Interaction patterns (concise/verbose, direct/indirect)

4. **Interest Areas** (兴趣领域)
   - Topics they engage with
   - Domains of knowledge
   - Hobbies and passions

5. **Behavioral Patterns** (行为模式)
   - Recurring actions
   - Response tendencies
   - Activity patterns

6. **Emotional Profile** (情感画像)
   - Dominant emotions
   - Sensitivity areas
   - Expression tendencies

7. **Key Insights** (关键洞察)
   - Specific observations with evidence
   - Notable characteristics
   - Unique patterns

8. **Confidence Assessment** (可信度评估)
   - Data quality evaluation
   - Analysis confidence level

## Output Format - Sentra XML Protocol

**MANDATORY Structure** (with sender_id attribute):

<sentra-persona sender_id="USER_QQ_ID">
  <summary>一句话核心概括，捕捉此人的本质特征（15-30字）</summary>
  
  <traits>
    <personality>
      <trait>性格特征1（具体、可观察）</trait>
      <trait>性格特征2</trait>
      <trait>性格特征3</trait>
    </personality>
    
    <communication_style>
      详细描述用户的沟通风格：用词习惯、语气特点、表达方式等（50-100字）
    </communication_style>
    
    <interests>
      <interest category="类别1">兴趣1的具体描述</interest>
      <interest category="类别2">兴趣2的具体描述</interest>
      <interest category="类别3">兴趣3的具体描述</interest>
    </interests>
    
    <behavioral_patterns>
      <pattern type="类型1">行为模式1的描述</pattern>
      <pattern type="类型2">行为模式2的描述</pattern>
      <pattern type="类型3">行为模式3的描述</pattern>
    </behavioral_patterns>
    
    <emotional_profile>
      <dominant_emotions>主导情绪描述</dominant_emotions>
      <sensitivity_areas>情感敏感领域</sensitivity_areas>
      <expression_tendency>情感表达倾向</expression_tendency>
    </emotional_profile>
  </traits>
  
  <insights>
    <insight evidence="来自消息X的具体内容">
      洞察内容1：观察到的特定行为或特征
    </insight>
    <insight evidence="来自消息Y的具体内容">
      洞察内容2：另一个重要发现
    </insight>
    <insight evidence="来自消息Z的具体内容">
      洞察内容3：独特的观察
    </insight>
  </insights>
  
  <metadata>
    <confidence>high|medium|low</confidence>
    <data_quality>数据质量评估（样本数量、消息质量等）</data_quality>
    <update_priority>下次重点关注的分析维度</update_priority>
  </metadata>
</sentra-persona>

## Quality Standards

**Requirements**:
- Summary: 15-30 characters, capturing essence
- Each trait: Specific and observable, not vague
- Insights: MUST include evidence or examples
- Communication style: 50-100 characters with concrete details
- Emotional profile: All three sub-fields required
- NO explanations outside XML block
- NO markdown formatting inside XML tags

**DO NOT**:
- Use generic descriptions ("nice person", "friendly")
- Include analysis without evidence
- Add commentary outside the XML structure
- Use English in Chinese content fields
- Analyze or mention social roles (群主/admin/member status)

## Analysis Guidelines

- **Evidence-Based**: Every trait must be grounded in observable patterns
- **Specific over Generic**: "喜欢深入讨论技术细节" not "对技术感兴趣"
- **Pattern Recognition**: Identify recurring themes, word choices, interaction styles
- **Avoid Speculation**: Only what can be reasonably inferred from data
- **Natural Language**: Conversational Chinese, avoid clinical tone
- **Contextual Depth**: Consider WHAT, HOW, and WHEN they say things
- **Focus**: Personal traits, communication, interests, behaviors ONLY

**CRITICAL**: Your ENTIRE output must be valid XML wrapped in <sentra-persona> tags. Do not include explanations outside the XML block.`;

    } else {
      // 后续优化 - 关注细化和修正
      return `# User Persona Analysis System - Profile Refinement

You are an expert user profiling analyst. Your task is to **REFINE and OPTIMIZE** an existing persona based on new conversation data while maintaining continuity.

## Critical Protocols

**OUTPUT FORMAT**: You MUST use Sentra XML Protocol format
**LANGUAGE**: All content MUST be in Chinese (中文)
**EXECUTION**: Output XML directly in your response (NO explanations outside XML)

## Your Task

You will receive:
1. **Existing Persona**: The current user profile (for reference)
2. **New Messages**: Recent conversation data to analyze

Your goal: **Enhance the existing persona** with new insights while preserving core characteristics.

## Refinement Strategy

Apply these strategies systematically:

1. **Validate** (确认或调整)
   - Confirm previous observations that still hold true
   - Adjust traits that have evolved or changed
   - Mark status: confirmed, refined, new

2. **Deepen** (深化理解)
   - Add nuance and detail to existing traits
   - Replace vague descriptions with specific evidence
   - Provide concrete examples from messages

3. **Expand** (拓展视野)
   - Identify new patterns not previously observed
   - Discover emerging interests or behaviors
   - Note additional dimensions of personality

4. **Track Evolution** (追踪演变)
   - Compare current behavior with historical patterns
   - Note changes in interests, communication style, or emotions
   - Identify trends (increasing/decreasing/stable)

5. **Improve Precision** (提高精准度)
   - Replace general statements with specific observations
   - Use recent messages as primary evidence
   - Quantify patterns when possible

## Output Format - Sentra XML Protocol

**MANDATORY Structure with Evolution Tracking** (with sender_id attribute):

<sentra-persona sender_id="USER_QQ_ID">
  <summary>更新后的核心概括（可能比之前更精准）（15-30字）</summary>
  
  <traits>
    <personality>
      <trait status="confirmed">性格特征1（已确认，仍然适用）</trait>
      <trait status="refined">性格特征2（细化后的描述）</trait>
      <trait status="new">性格特征3（新发现的特征）</trait>
    </personality>
    
    <communication_style>
      更细致的沟通风格描述，包含新观察到的细节和变化（50-100字）
    </communication_style>
    
    <interests>
      <interest category="类别1" status="持续">兴趣1的描述（持续关注）</interest>
      <interest category="类别2" status="新增">兴趣2的描述（新发现）</interest>
      <interest category="类别3" status="减弱">兴趣3的描述（关注度降低）</interest>
    </interests>
    
    <behavioral_patterns>
      <pattern type="类型1" trend="稳定">行为模式1（保持稳定）</pattern>
      <pattern type="类型2" trend="增强">行为模式2（频率增加）</pattern>
      <pattern type="类型3" trend="减弱">行为模式3（出现减少）</pattern>
    </behavioral_patterns>
    
    <emotional_profile>
      <dominant_emotions>更新的主导情绪（注明变化）</dominant_emotions>
      <sensitivity_areas>情感敏感点（新发现或调整）</sensitivity_areas>
      <expression_tendency>情感表达倾向（观察到的演变）</expression_tendency>
    </emotional_profile>
  </traits>
  
  <insights>
    <insight evidence="最新消息证据" novelty="confirmed">
      洞察内容（确认之前的观察，提供新证据）
    </insight>
    <insight evidence="最新消息证据" novelty="deepened">
      洞察内容（深化理解，增加细节）
    </insight>
    <insight evidence="最新消息证据" novelty="new">
      洞察内容（全新发现，之前未观察到）
    </insight>
  </insights>
  
  <evolution>
    <change type="behavioral">
      具体变化描述1：对比之前的观察，新数据显示的演变
    </change>
    <change type="interest">
      具体变化描述2：成长、转变或新趋势
    </change>
    <continuity>
      保持一致的核心特征：哪些方面依然稳定，体现用户的本质
    </continuity>
  </evolution>
  
  <metadata>
    <confidence>high|medium|low</confidence>
    <data_quality>数据质量提升情况（如：样本增加、覆盖更多场景）</data_quality>
    <update_priority>下次重点关注的分析维度</update_priority>
  </metadata>
</sentra-persona>

## Quality Standards

**Status/Novelty/Trend Attributes**:
- Personality traits: status="confirmed|refined|new"
- Interests: status="持续|新增|减弱"
- Behavioral patterns: trend="稳定|增强|减弱"
- Insights: novelty="confirmed|deepened|new"
- Evolution: type="behavioral|interest|communication|emotional"

**Requirements**:
- Summary: Can be refined but preserve core essence (15-30 chars)
- Each trait/interest/pattern: MUST have status/trend indicator
- Evolution section: MUST explicitly compare with previous version
- Insights: MUST indicate novelty level
- Continuity: Identify what remains stable (core identity)
- Balanced update: ~70% continuity, ~30% new insights
- NO explanations outside XML block
- NO markdown formatting inside XML tags

**DO NOT**:
- Discard previous insights unless clearly contradicted
- Use English in Chinese content fields
- Ignore the existing persona structure
- Add commentary outside XML
- Analyze social roles (群主/admin/member)

## Refinement Guidelines

- **Preserve Continuity**: Build upon existing insights, don't start from scratch
- **Mark Changes**: Use status/novelty/trend attributes to track evolution
- **Compare & Contrast**: Explicitly note what's new vs. confirmed
- **Evidence Evolution**: Use recent messages as primary, historical as reference
- **Increase Specificity**: More precise than previous version
- **Track Trajectories**: Identify trends over time

**CRITICAL**: Your ENTIRE output must be valid XML wrapped in <sentra-persona> tags. Do not include explanations outside the XML block.`;
    }
  }

  /**
   * 构建分析提示词 - 使用 Sentra XML 协议
   */
  _buildAnalysisPrompt(recentMessages, existingPersona, isFirstTime, senderId) {
    let prompt = '';

    if (isFirstTime) {
      prompt += '# Initial Persona Construction\n\n';
      prompt += '**User Conversation History**:\n\n';
    } else {
      prompt += '# Persona Refinement\n\n';
      prompt += '**Existing Persona (XML Format)**:\n\n';
      
      // 将已有画像转为 XML 格式显示（直接 XML，不用代码块）
      prompt += this._serializePersonaToXML(existingPersona, senderId);
      prompt += '\n\n';
      
      prompt += '**New Conversation Data**:\n\n';
    }

    // 添加消息历史（结构化列表）
    prompt += '<conversation_history>\n';
    recentMessages.forEach((msg, idx) => {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const name = msg.senderName || '用户';
      const text = msg.text || '';
      prompt += `  <message index="${idx + 1}">\n`;
      prompt += `    <time>${time}</time>\n`;
      prompt += `    <sender>${name}</sender>\n`;
      prompt += `    <content>${text}</content>\n`;
      prompt += `  </message>\n`;
    });
    prompt += '</conversation_history>\n\n';

    prompt += '---\n\n';
    
    if (isFirstTime) {
      prompt += '**Your Task**: Analyze the conversation history above and construct an initial user persona using the <sentra-persona> XML format specified in the system prompt.\n\n';
      prompt += '**Focus on**: Observable patterns, recurring themes, communication characteristics, and behavioral tendencies.\n\n';
      prompt += '**Remember**: Output ONLY the <sentra-persona> XML block. Be specific and evidence-based.';
    } else {
      prompt += '**Your Task**: Refine the existing persona based on new conversation data. Output an enhanced <sentra-persona> XML block.\n\n';
      prompt += '**Focus on**: Validating previous insights, adding new observations, tracking changes, increasing specificity.\n\n';
      prompt += '**Remember**: Maintain ~70% continuity, ~30% new insights. Mark status/novelty/trend indicators. Output ONLY the <sentra-persona> XML block.';
    }

    return prompt;
  }

  /**
   * 解析 LLM 返回的画像数据 - 使用 Sentra XML 协议
   */
  async _parsePersonaResponse(content, senderId) {
    try {
      // 提取 <sentra-persona> 块
      let personaXML = extractXMLTag(content, 'sentra-persona');
      
      if (!personaXML) {
        // 尝试从 markdown 代码块中提取
        const xmlMatch = content.match(/```xml\s*([\s\S]*?)\s*```/);
        if (xmlMatch) {
          personaXML = extractXMLTag(xmlMatch[1], 'sentra-persona');
        }
      }
      
      if (!personaXML) {
        // 使用格式修复器尝试修复为 <sentra-persona>
        const enableRepair = getEnvBool('ENABLE_FORMAT_REPAIR', true);
        if (enableRepair && typeof content === 'string' && content.trim()) {
          try {
            const repaired = await repairSentraPersona(content, { agent: this.agent, model: getEnv('REPAIR_AI_MODEL') });
            const extracted = extractXMLTag(repaired, 'sentra-persona');
            if (extracted) {
              personaXML = extracted;
            }
          } catch (repairErr) {
            logger.warn('画像格式修复失败', repairErr);
          }
        }
      }
      
      if (!personaXML) {
        logger.error('解析画像失败：未找到 <sentra-persona> 标签');
        return null;
      }
      
      // 解析 XML 结构
      const persona = this._parsePersonaXML(personaXML);
      
      // 保存原始 XML 用于后续优化（包含 sender_id 属性）
      const senderIdAttr = senderId ? ` sender_id="${senderId}"` : '';
      persona._raw_xml = `<sentra-persona${senderIdAttr}>\n${personaXML}\n</sentra-persona>`;
      
      return persona;
      
    } catch (error) {
      logger.error('解析画像异常', error);
      
      // 最终降级方案
      return {
        summary: '解析失败，保留原始内容',
        _raw_content: content,
        _error: error.message,
        confidence: 'low'
      };
    }
  }
  
  /**
   * 解析 Sentra XML 格式的画像数据
   */
  _parsePersonaXML(personaXML) {
    const persona = {};
    
    // 提取 summary
    persona.summary = extractXMLTag(personaXML, 'summary')?.trim() || '';
    
    // 提取 traits 块
    const traitsBlock = extractXMLTag(personaXML, 'traits');
    if (traitsBlock) {
      persona.traits = {};
      
      // personality 特征
      const personalityBlock = extractXMLTag(traitsBlock, 'personality');
      if (personalityBlock) {
        persona.traits.personality = extractAllXMLTags(personalityBlock, 'trait');
      }
      
      // communication_style
      persona.traits.communication_style = extractXMLTag(traitsBlock, 'communication_style')?.trim() || '';
      
      // interests
      const interestsBlock = extractXMLTag(traitsBlock, 'interests');
      if (interestsBlock) {
        const interestTags = this._extractTagsWithAttributes(interestsBlock, 'interest');
        persona.traits.interests = interestTags;
      }
      
      // behavioral_patterns
      const patternsBlock = extractXMLTag(traitsBlock, 'behavioral_patterns');
      if (patternsBlock) {
        const patternTags = this._extractTagsWithAttributes(patternsBlock, 'pattern');
        persona.traits.behavioral_patterns = patternTags;
      }
      
      // emotional_profile
      const emotionalBlock = extractXMLTag(traitsBlock, 'emotional_profile');
      if (emotionalBlock) {
        persona.traits.emotional_profile = {
          dominant_emotions: extractXMLTag(emotionalBlock, 'dominant_emotions')?.trim() || '',
          sensitivity_areas: extractXMLTag(emotionalBlock, 'sensitivity_areas')?.trim() || '',
          expression_tendency: extractXMLTag(emotionalBlock, 'expression_tendency')?.trim() || ''
        };
      }
    }
    
    // 提取 insights
    const insightsBlock = extractXMLTag(personaXML, 'insights');
    if (insightsBlock) {
      persona.insights = this._extractTagsWithAttributes(insightsBlock, 'insight');
    }
    
    // 提取 evolution（仅在优化后的画像中存在）
    const evolutionBlock = extractXMLTag(personaXML, 'evolution');
    if (evolutionBlock) {
      persona.evolution = {
        changes: this._extractTagsWithAttributes(evolutionBlock, 'change'),
        continuity: extractXMLTag(evolutionBlock, 'continuity')?.trim() || ''
      };
    }
    
    // 提取 metadata
    const metadataBlock = extractXMLTag(personaXML, 'metadata');
    if (metadataBlock) {
      persona.metadata = {
        confidence: extractXMLTag(metadataBlock, 'confidence')?.trim() || 'medium',
        data_quality: extractXMLTag(metadataBlock, 'data_quality')?.trim() || '',
        update_priority: extractXMLTag(metadataBlock, 'update_priority')?.trim() || ''
      };
    }
    
    // 兼容性：提取 confidence（如果 metadata 不存在）
    if (!persona.metadata) {
      const confidence = extractXMLTag(personaXML, 'confidence')?.trim();
      if (confidence) {
        persona.confidence = confidence;
      }
    }
    
    return persona;
  }
  
  /**
   * 提取带属性的 XML 标签
   */
  _extractTagsWithAttributes(xmlBlock, tagName) {
    const results = [];
    const regex = new RegExp(`<${tagName}([^>]*)>([\\s\\S]*?)<\/${tagName}>`, 'g');
    let match;
    
    while ((match = regex.exec(xmlBlock)) !== null) {
      const attributesStr = match[1];
      const content = match[2].trim();
      
      // 解析属性
      const attributes = {};
      const attrRegex = /(\w+)="([^"]*)"/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
        attributes[attrMatch[1]] = attrMatch[2];
      }
      
      results.push({
        content,
        attributes
      });
    }
    
    return results;
  }
  
  _serializePersonaToXML(persona, senderId) {
    if (!persona) return '<sentra-persona></sentra-persona>';
    // 若已是 XML 字符串或对象内含原始XML，则直接返回
    if (typeof persona === 'string' && persona.includes('<sentra-persona')) {
      return persona;
    }
    if (persona._raw_xml && typeof persona._raw_xml === 'string') {
      return persona._raw_xml;
    }
    
    const lines = [];
    const s = (v) => (v == null ? '' : String(v));
    const arr = (a) => Array.isArray(a) ? a : (a ? [a] : []);
    const items = (a) => arr(a).map(x => (typeof x === 'object' && x && (x.content || x.attributes)) ? x : { content: s(x), attributes: {} }).filter(i => i.content);
    const attrs = (o, ks) => {
      const ps = [];
      ks.forEach(k => { if (o && o[k]) ps.push(`${k}="${o[k]}"`); });
      return ps.length ? ' ' + ps.join(' ') : '';
    };
    
    const senderAttr = senderId ? ` sender_id="${s(senderId)}"` : '';
    lines.push(`<sentra-persona${senderAttr}>`);
    
    if (persona.summary) lines.push(`  <summary>${s(persona.summary)}</summary>`);
    
    if (persona.traits) {
      lines.push('  <traits>');
      const pers = items(persona.traits.personality);
      if (pers.length) {
        lines.push('    <personality>');
        pers.forEach(t => lines.push(`      <trait${attrs(t.attributes, ['status'])}>${s(t.content)}</trait>`));
        lines.push('    </personality>');
      }
      if (persona.traits.communication_style) {
        lines.push(`    <communication_style>${s(persona.traits.communication_style)}</communication_style>`);
      }
      const ints = items(persona.traits.interests);
      if (ints.length) {
        lines.push('    <interests>');
        ints.forEach(it => lines.push(`      <interest${attrs(it.attributes, ['category', 'status'])}>${s(it.content)}</interest>`));
        lines.push('    </interests>');
      }
      const pats = items(persona.traits.behavioral_patterns);
      if (pats.length) {
        lines.push('    <behavioral_patterns>');
        pats.forEach(p => lines.push(`      <pattern${attrs(p.attributes, ['type', 'trend'])}>${s(p.content)}</pattern>`));
        lines.push('    </behavioral_patterns>');
      }
      const ep = persona.traits.emotional_profile || {};
      if (ep.dominant_emotions || ep.sensitivity_areas || ep.expression_tendency) {
        lines.push('    <emotional_profile>');
        if (ep.dominant_emotions) lines.push(`      <dominant_emotions>${s(ep.dominant_emotions)}</dominant_emotions>`);
        if (ep.sensitivity_areas) lines.push(`      <sensitivity_areas>${s(ep.sensitivity_areas)}</sensitivity_areas>`);
        if (ep.expression_tendency) lines.push(`      <expression_tendency>${s(ep.expression_tendency)}</expression_tendency>`);
        lines.push('    </emotional_profile>');
      }
      lines.push('  </traits>');
    }
    
    const insights = items(persona.insights);
    if (insights.length) {
      lines.push('  <insights>');
      insights.forEach(ins => lines.push(`    <insight${attrs(ins.attributes, ['evidence', 'novelty'])}>${s(ins.content)}</insight>`));
      lines.push('  </insights>');
    }
    
    if (persona.evolution) {
      const changes = items(persona.evolution.changes);
      const cont = persona.evolution.continuity;
      if (changes.length || cont) {
        lines.push('  <evolution>');
        changes.forEach(c => lines.push(`    <change${attrs(c.attributes, ['type'])}>${s(c.content)}</change>`));
        if (cont) lines.push(`    <continuity>${s(cont)}</continuity>`);
        lines.push('  </evolution>');
      }
    }
    
    const md = persona.metadata || {};
    if (md.confidence || md.data_quality || md.update_priority) {
      lines.push('  <metadata>');
      if (md.confidence) lines.push(`    <confidence>${s(md.confidence)}</confidence>`);
      if (md.data_quality) lines.push(`    <data_quality>${s(md.data_quality)}</data_quality>`);
      if (md.update_priority) lines.push(`    <update_priority>${s(md.update_priority)}</update_priority>`);
      lines.push('  </metadata>');
    }
    
    lines.push('</sentra-persona>');
    return lines.join('\n');
  }

  /**
   * 获取画像摘要（用于日志输出）
   */
  _getPersonaSummary(persona) {
    if (!persona) return '(无画像)';
    
    if (persona.summary) {
      const confidence = persona.metadata?.confidence || persona.confidence || 'medium';
      return `${persona.summary} [${confidence}]`;
    }
    
    return '  (画像数据异常)';
  }

  _mergePersonaWithStats(userData, newPersona) {
    const now = Date.now();
    if (!userData.personaStats) {
      userData.personaStats = { traits: {}, interests: {}, patterns: {}, insights: {} };
    }
    const stats = userData.personaStats;
    const readItems = (arr) => {
      if (!arr) return [];
      return arr.map(x => {
        if (typeof x === 'object' && x && (x.content || x.attributes)) return { content: (x.content || '').trim(), attributes: x.attributes || {} };
        return { content: String(x || '').trim(), attributes: {} };
      }).filter(it => it.content);
    };
    const decay = (w, lastSeen) => {
      const delta = Math.max(0, now - (lastSeen || now));
      if (!this.halfLifeMs || this.halfLifeMs <= 0) return w;
      const factor = Math.pow(0.5, delta / this.halfLifeMs);
      return w * factor;
    };
    const bump = (base, attrs) => {
      let b = base;
      const s = attrs?.status;
      if (s === 'confirmed') b += 0.2;
      else if (s === 'refined') b += 0.1;
      else if (s === 'new') b += 0.15;
      const n = attrs?.novelty;
      if (n === 'new') b += 0.15;
      const t = attrs?.trend;
      if (t === '增强') b += 0.1;
      return b;
    };
    const normKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
    const decayAll = (map) => {
      Object.keys(map).forEach(k => { map[k].weight = decay(map[k].weight || 0, map[k].lastSeen); });
    };
    const upsert = (map, item, base) => {
      const key = normKey(item.content);
      const prev = map[key] || { content: item.content, attributes: item.attributes || {}, firstSeen: now, lastSeen: now, count: 0, weight: 0 };
      const w = decay(prev.weight || 0, prev.lastSeen) + bump(base, item.attributes || {});
      map[key] = { content: item.content, attributes: item.attributes || {}, firstSeen: prev.firstSeen, lastSeen: now, count: (prev.count || 0) + 1, weight: w };
    };
    const topN = (map, n) => {
      return Object.values(map)
        .sort((a, b) => (b.weight - a.weight) || (b.lastSeen - a.lastSeen) || (b.count - a.count))
        .slice(0, Math.max(0, n))
        .map(v => ({ content: v.content, attributes: v.attributes }));
    };
    decayAll(stats.traits);
    decayAll(stats.interests);
    decayAll(stats.patterns);
    decayAll(stats.insights);
    const personality = readItems(newPersona?.traits?.personality);
    const interests = readItems(newPersona?.traits?.interests);
    const patterns = readItems(newPersona?.traits?.behavioral_patterns);
    const insights = readItems(newPersona?.insights);
    personality.forEach(it => upsert(stats.traits, it, 1.0));
    interests.forEach(it => upsert(stats.interests, it, 1.0));
    patterns.forEach(it => upsert(stats.patterns, it, 1.0));
    insights.forEach(it => upsert(stats.insights, it, 1.0));
    const result = {
      summary: (newPersona?.summary && newPersona.summary.trim()) || (userData.persona?.summary || ''),
      traits: {
        personality: topN(stats.traits, this.maxTraits),
        communication_style: (newPersona?.traits?.communication_style && newPersona.traits.communication_style.trim()) || (userData.persona?.traits?.communication_style || ''),
        interests: topN(stats.interests, this.maxInterests),
        behavioral_patterns: topN(stats.patterns, this.maxPatterns),
        emotional_profile: {
          dominant_emotions: newPersona?.traits?.emotional_profile?.dominant_emotions || userData.persona?.traits?.emotional_profile?.dominant_emotions || '',
          sensitivity_areas: newPersona?.traits?.emotional_profile?.sensitivity_areas || userData.persona?.traits?.emotional_profile?.sensitivity_areas || '',
          expression_tendency: newPersona?.traits?.emotional_profile?.expression_tendency || userData.persona?.traits?.emotional_profile?.expression_tendency || ''
        }
      },
      insights: topN(stats.insights, this.maxInsights),
      metadata: {
        confidence: newPersona?.metadata?.confidence || userData.persona?.metadata?.confidence || newPersona?.confidence || userData.persona?.confidence || 'medium',
        data_quality: newPersona?.metadata?.data_quality || userData.persona?.metadata?.data_quality || '',
        update_priority: newPersona?.metadata?.update_priority || userData.persona?.metadata?.update_priority || ''
      }
    };
    return result;
  }

  /**
   * 获取用户画像（供 AI 使用）
   */
  getPersona(senderId) {
    const userData = this._loadUserData(senderId);
    return userData?.persona || null;
  }

  /**
   * 格式化画像为 Sentra XML（用于插入到 AI 上下文）
   */
  formatPersonaForContext(senderId) {
    const persona = this.getPersona(senderId);
    if (!persona) return '';
    return this._serializePersonaToXML(persona, senderId);
  }

  /**
   * 强制更新画像（手动触发）
   */
  async forceUpdate(senderId) {
    logger.info(`手动触发画像更新 (${senderId})`);
    await this.updatePersona(senderId);
  }

  /**
   * 重置用户画像
   */
  resetPersona(senderId) {
    const userData = this._loadUserData(senderId);
    if (userData) {
      userData.persona = null;
      userData.version = 0;
      userData.lastUpdateCount = 0;
      this._saveUserData(senderId, userData);
      logger.success(`[画像] ${senderId} 画像重置成功`);
    }
  }

  /**
   * 获取用户统计信息
   */
  getUserStats(senderId) {
    const userData = this._loadUserData(senderId);
    if (!userData) return null;

    return {
      senderId,
      messageCount: userData.messageCount,
      hasPersona: !!userData.persona,
      version: userData.version,
      createdAt: userData.createdAt,
      updatedAt: userData.updatedAt,
      nextUpdateIn: Math.max(0, this.minMessagesForUpdate - (userData.messageCount - userData.lastUpdateCount))
    };
  }

  /**
   * 列出所有用户
   */
  listAllUsers() {
    if (!fs.existsSync(this.dataDir)) return [];

    const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      const senderId = f.replace('.json', '').replace(/_/g, ''); // 还原 ID
      return this.getUserStats(senderId);
    }).filter(Boolean);
  }
}

// 导出单例
export default UserPersonaManager;
