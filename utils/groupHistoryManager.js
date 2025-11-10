import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { createLogger } from './logger.js';

const logger = createLogger('GroupHistory');

/**
 * Per-Group
 * 确保同一个群内的操作串行执行，避免并发写入冲突
 */
class GroupTaskQueue extends EventEmitter {
  constructor() {
    super();
    this.running = 0;
    this.queue = [];
  }

  /**
   * 添加任务到队列
   * @param {Function} task - 异步任务函数，返回 Promise
   * @returns {Promise} 任务执行结果
   */
  async pushTask(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      process.nextTick(() => this.next());
    });
  }

  /**
   * 执行队列中的下一个任务
   */
  async next() {
    // 如果正在执行任务或队列为空，退出
    if (this.running > 0 || this.queue.length === 0) {
      if (this.running === 0 && this.queue.length === 0) {
        this.emit('empty');
      }
      return;
    }

    // 取出下一个任务
    const item = this.queue.shift();
    this.running++;

    try {
      const result = await item.task();
      item.resolve(result);
    } catch (error) {
      this.emit('error', error);
      item.reject(error);
    } finally {
      this.running--;
      process.nextTick(() => this.next());
    }
  }
}

/**
 * 群聊历史记录管理器
 * 
 * 核心特性：
 * 1. 按 group_id 分隔存储历史记录
 * 2. 每个群有独立的任务队列，确保串行执行
 * 3. 不同群之间可以并发处理
 * 4. 使用 UUID 标记每一对对话，支持精确撤销
 * 
 * 数据结构：
 * - conversations: [{ role: 'user'|'assistant', content: string, pairId: string }]
 * - pendingMessages: [{ summary: string, msgObj: Object }]
 * - currentAssistantMessage: string
 * - currentPairId: string | null
 */
class GroupHistoryManager {
  constructor(options = {}) {
    // 配置
    this.maxConversationPairs = options.maxConversationPairs || 20;
    
    // 每个群的历史数据
    // Map<groupId, { conversations, pendingMessages, currentAssistantMessage, currentPairId }>
    this.histories = new Map();
    
    // 每个群的任务队列（确保串行执行）
    // Map<groupId, GroupTaskQueue>
    this.queues = new Map();
  }

  /**
   * 为指定群执行任务（自动加入该群的队列）
   * @param {string} groupId - 群ID
   * @param {Function} task - 异步任务函数
   * @returns {Promise} 任务执行结果
   */
  async _executeForGroup(groupId, task) {
    // 确保该群有队列
    if (!this.queues.has(groupId)) {
      const queue = new GroupTaskQueue();
      queue.on('error', (error) => {
        logger.error(`队列错误: ${groupId}`, error);
      });
      this.queues.set(groupId, queue);
    }

    // 将任务加入队列（串行执行）
    const queue = this.queues.get(groupId);
    return queue.pushTask(task);
  }

  /**
   * 获取或初始化群组历史记录
   * @param {string} groupId - 群ID
   * @returns {Object} 群组历史对象
   */
  _getOrInitHistory(groupId) {
    if (!this.histories.has(groupId)) {
      this.histories.set(groupId, {
        conversations: [],              // 完整的对话历史（user/assistant对）
        pendingMessages: [],             // 待处理的消息列表（还未开始处理）
        processingMessages: [],          // 正在处理的消息列表（已开始处理，但未完成）
        currentAssistantMessage: '',     // 当前正在构建的助手消息
        currentPairId: null,             // 当前对话对的UUID
        senderLastMessageTime: new Map() // 记录每个sender的最后消息时间（用于超时清理）
      });
    }
    return this.histories.get(groupId);
  }

  /**
   * 添加待回复消息（线程安全）
   * @param {string} groupId - 群ID
   * @param {string} summary - 消息摘要
   * @param {Object} msgObj - 原始消息对象
   * @returns {Promise<void>}
   */
  async addPendingMessage(groupId, summary, msgObj) {
    return this._executeForGroup(groupId, async () => {
      const history = this._getOrInitHistory(groupId);
      const senderId = String(msgObj.sender_id);
      const now = Date.now();
      
      // 清理超时的sender消息（超过2分钟没有新消息）
      const cleanupResult = this._cleanupTimeoutMessages(history, now);
      if (cleanupResult.cleaned > 0) {
        logger.debug(`超时清理: ${groupId} 清理了${cleanupResult.cleaned}个sender的消息`);
      }
      
      // 记录当前sender的最后消息时间
      history.senderLastMessageTime.set(senderId, now);
      
      // 添加消息到待回复队列
      history.pendingMessages.push({ summary, msgObj, timestamp: now });
      
      logger.debug(`待回复ADD: ${groupId} sender ${msgObj.sender_id}, msg ${msgObj.message_id}, 当前${history.pendingMessages.length}条待回复`);
    });
  }

  /**
   * 清理超时的sender消息（内部方法，不加锁）
   * @param {Object} history - 群组历史对象
   * @param {number} now - 当前时间戳
   * @param {number} timeoutMs - 超时时间（毫秒），默认2分钟
   * @returns {Object} 清理结果 {cleaned: number, details: string[]}
   * @private
   */
  _cleanupTimeoutMessages(history, now, timeoutMs = 2 * 60 * 1000) {
    const timeoutSenders = [];
    const cleaned = { cleaned: 0, details: [] };
    
    // 检查每个sender是否超时
    for (const [senderId, lastTime] of history.senderLastMessageTime.entries()) {
      if (now - lastTime > timeoutMs) {
        timeoutSenders.push(senderId);
      }
    }
    
    if (timeoutSenders.length === 0) {
      return cleaned;
    }
    
    // 清理超时sender的消息
    for (const senderId of timeoutSenders) {
      const beforeCount = history.pendingMessages.length;
      
      // 从 pendingMessages 中移除该sender的消息
      const removed = history.pendingMessages.filter(pm => String(pm.msgObj.sender_id) === senderId);
      history.pendingMessages = history.pendingMessages.filter(pm => String(pm.msgObj.sender_id) !== senderId);
      
      // 从 processingMessages 中移除该sender的消息
      const removedProcessing = history.processingMessages.filter(pm => String(pm.msgObj.sender_id) === senderId);
      history.processingMessages = history.processingMessages.filter(pm => String(pm.msgObj.sender_id) !== senderId);
      
      const totalRemoved = removed.length + removedProcessing.length;
      
      if (totalRemoved > 0) {
        // 计算超时时间（在删除前获取）
        const lastTime = history.senderLastMessageTime.get(senderId);
        const timeoutSeconds = Math.floor((now - (lastTime || now)) / 1000);
        
        // 从时间记录中删除
        history.senderLastMessageTime.delete(senderId);
        
        cleaned.cleaned++;
        cleaned.details.push(`sender:${senderId}, 清理${totalRemoved}条消息, 超时${timeoutSeconds}秒`);
      }
    }
    
    return cleaned;
  }

  /**
   * 获取所有待回复消息的内容（Sentra XML 格式）
   * @param {string} groupId - 群ID
   * @returns {string} Sentra XML 格式的待回复消息
   */
  getPendingMessagesXML(groupId) {
    const history = this.histories.get(groupId);
    if (!history || history.pendingMessages.length === 0) {
      return '';
    }

    // 构建 <sentra-pending-messages> XML 结构
    let xml = '<sentra-pending-messages>\n';
    xml += `  <total_count>${history.pendingMessages.length}</total_count>\n`;
    xml += '  <messages>\n';
    
    history.pendingMessages.forEach((pm, index) => {
      const msg = pm.msgObj;
      xml += `    <message index="${index + 1}">\n`;
      xml += `      <sender_id>${this._escapeXml(String(msg.sender_id || ''))}</sender_id>\n`;
      xml += `      <sender_name>${this._escapeXml(msg.sender_name || 'Unknown')}</sender_name>\n`;
      xml += `      <text>${this._escapeXml(msg.text || msg.summary || '')}</text>\n`;
      xml += `      <time>${this._escapeXml(msg.time_str || '')}</time>\n`;
      
      // 添加消息 ID（用于引用回复）
      if (msg.message_id) {
        xml += `      <message_id>${this._escapeXml(String(msg.message_id))}</message_id>\n`;
      }
      
      // 添加 at 信息
      if (msg.at_bot) {
        xml += `      <at_bot>true</at_bot>\n`;
      }
      if (msg.at_me) {
        xml += `      <at_me>true</at_me>\n`;
      }
      
      xml += `    </message>\n`;
    });
    
    xml += '  </messages>\n';
    xml += '</sentra-pending-messages>';
    
    return xml;
  }

  /**
   * XML 转义（基础转义，Sentra 协议不转义特殊字符）
   * @param {string} str - 要转义的字符串
   * @returns {string} 转义后的字符串
   */
  _escapeXml(str) {
    // Sentra XML 协议：不转义特殊字符，保持原样
    // 参考 Memory[5bc2a202]: Sentra XML 协议不转义 <、>、& 等
    return String(str || '');
  }

  /**
   * 获取所有待回复消息的内容（简单字符串格式，已废弃）
   * @deprecated 使用 getPendingMessagesXML() 代替
   * @param {string} groupId - 群ID
   * @returns {string} 组合后的消息内容
   */
  getPendingMessagesContent(groupId) {
    logger.warn('getPendingMessagesContent() 已废弃，请使用 getPendingMessagesXML()');
    const history = this.histories.get(groupId);
    if (!history || history.pendingMessages.length === 0) {
      return '';
    }
    return history.pendingMessages.map(pm => pm.summary).join('\n\n');
  }

  /**
   * 获取历史上下文消息（Sentra XML 格式）
   * 注意：这只是参考信息，真正需要回复的消息通过 <sentra-user-question> 提供
   * @param {string} groupId - 群ID
   * @param {string} [senderId] - 可选，发送者ID，如果提供则只返回该发送者的历史消息
   * @returns {string} Sentra XML 格式的历史上下文消息（如果没有则返回空字符串）
   */
  getPendingMessagesContext(groupId, senderId = null) {
    const history = this.histories.get(groupId);
    if (!history) {
      return '';
    }

    // 合并待处理和正在处理的消息
    const allMessages = [
      ...(history.pendingMessages || []),
      ...(history.processingMessages || [])
    ];

    // 如果指定了 senderId，只保留该 sender 的消息
    let contextMessages = allMessages;
    if (senderId) {
      contextMessages = allMessages.filter(pm => 
        String(pm.msgObj.sender_id) === String(senderId)
      );
      
      // 对于特定 sender，除了最后一条消息，其他都是历史上下文
      if (contextMessages.length <= 1) {
        return '';
      }
      contextMessages = contextMessages.slice(0, -1);
    } else {
      // 如果没有指定 senderId，返回所有消息的历史（除了最后一条）
      if (allMessages.length <= 1) {
        return '';
      }
      contextMessages = allMessages.slice(0, -1);
    }
    
    if (contextMessages.length === 0) {
      return '';
    }

    // 构建 Sentra XML 格式（只包含历史上下文）
    let xml = '<sentra-pending-messages>\n';
    xml += `  <total_count>${contextMessages.length}</total_count>\n`;
    if (senderId) {
      xml += `  <note>以下是该用户的历史消息，仅供参考。当前需要回复的消息见 &lt;sentra-user-question&gt;</note>\n`;
    } else {
      xml += `  <note>以下是近期对话上下文，仅供参考。当前需要回复的消息见 &lt;sentra-user-question&gt;</note>\n`;
    }
    xml += '  <context_messages>\n';
    
    contextMessages.forEach((pm, index) => {
      const msg = pm.msgObj;
      xml += `    <message index="${index + 1}">\n`;
      xml += `      <sender_name>${this._escapeXml(msg.sender_name || 'Unknown')}</sender_name>\n`;
      xml += `      <text>${this._escapeXml(msg.text || msg.summary || '')}</text>\n`;
      xml += `      <time>${this._escapeXml(msg.time_str || '')}</time>\n`;
      xml += `    </message>\n`;
    });
    
    xml += '  </context_messages>\n';
    xml += '</sentra-pending-messages>';
    
    return xml;
  }

  /**
   * 格式化待回复消息（已废弃，使用 getPendingMessagesContext 代替）
   * @deprecated 使用 getPendingMessagesContext() + buildSentraUserQuestionBlock() 代替
   */
  formatPendingMessagesForAI(groupId, targetSenderId = null) {
    logger.warn('formatPendingMessagesForAI() 已废弃，请使用 getPendingMessagesContext()');
    const history = this.histories.get(groupId);
    if (!history || history.pendingMessages.length === 0) {
      return { xml: '', objective: '完成用户请求', hasContext: false, targetMsg: null };
    }

    const lastMsg = history.pendingMessages[history.pendingMessages.length - 1];
    const contextXml = this.getPendingMessagesContext(groupId);
    
    return {
      xml: contextXml,
      objective: lastMsg.msgObj.text || lastMsg.msgObj.summary || '完成用户请求',
      hasContext: contextXml.length > 0,
      targetMsg: lastMsg.msgObj
    };
  }

  /**
   * 获取最后一条待回复消息（用于构建 sentra-user-question）
   * @param {string} groupId - 群ID
   * @returns {Object|null} 消息对象或null
   */
  getLastPendingMessage(groupId) {
    const history = this.histories.get(groupId);
    if (!history || history.pendingMessages.length === 0) {
      return null;
    }
    return history.pendingMessages[history.pendingMessages.length - 1].msgObj;
  }

  /**
   * 查找指定sender的最后一条消息（用于引用回复）
   * @param {string} groupId - 群ID
   * @param {string} senderId - 发送者ID
   * @returns {Object|null} 消息对象或null
   */
  findLastMessageBySender(groupId, senderId) {
    const history = this.histories.get(groupId);
    if (!history) {
      return null;
    }

    // 从后往前查找该sender的消息
    for (let i = history.pendingMessages.length - 1; i >= 0; i--) {
      const pm = history.pendingMessages[i];
      if (pm.msgObj.sender_id === senderId) {
        logger.debug(`引用查找: ${groupId} 找到sender ${senderId} 消息 ${pm.msgObj.message_id}`);
        return pm.msgObj;
      }
    }

    logger.warn(`引用查找: ${groupId} 未找到sender ${senderId}`);
    return null;
  }

  /**
   * 开始处理指定sender_id的消息：将其从待处理队列移到正在处理队列（线程安全）
   * @param {string} groupId - 群ID
   * @param {string} senderId - 发送者ID
   * @returns {Promise<Array<Object>>} 被移动的消息对象数组
   */
  async startProcessingMessages(groupId, senderId) {
    return this._executeForGroup(groupId, async () => {
      const history = this._getOrInitHistory(groupId);
      
      // 筛选该sender的所有待处理消息
      const senderPending = history.pendingMessages.filter(pm => 
        String(pm.msgObj.sender_id) === String(senderId)
      );
      
      // 从待处理队列中移除
      history.pendingMessages = history.pendingMessages.filter(pm => 
        String(pm.msgObj.sender_id) !== String(senderId)
      );
      
      // 添加到正在处理队列
      history.processingMessages.push(...senderPending);
      
      logger.debug(`开始处理: ${groupId} sender ${senderId} 移动${senderPending.length}条消息 pending(${history.pendingMessages.length}) -> processing(${history.processingMessages.length})`);
      
      return senderPending.map(pm => pm.msgObj);
    });
  }

  /**
   * 获取指定sender_id在待回复队列中的所有消息（按时间顺序）
   * 包括待处理和正在处理的消息
   * 用于动态感知用户的连续输入和修正
   * @param {string} groupId - 群ID
   * @param {string} senderId - 发送者ID
   * @returns {Array<Object>} 消息对象数组
   */
  getPendingMessagesBySender(groupId, senderId) {
    const history = this.histories.get(groupId);
    const pendingCount = history?.pendingMessages?.length || 0;
    const processingCount = history?.processingMessages?.length || 0;
    logger.debug(`动态感知GET: ${groupId} pending ${pendingCount}, processing ${processingCount}`);
    
    if (!history || (pendingCount === 0 && processingCount === 0)) {
      logger.debug(`动态感知GET: ${groupId} sender ${senderId} 队列为空`);
      return [];
    }

    // 合并待处理和正在处理的消息
    const allMessages = [
      ...(history.pendingMessages || []),
      ...(history.processingMessages || [])
    ];
    
    // logger.debug(`动态感知GET: 查询senderId ${senderId}`);
    
    // 筛选该sender的所有消息（待处理 + 正在处理）
    const senderMessages = allMessages
      .filter(pm => {
        const match = String(pm.msgObj.sender_id) === String(senderId);
        // logger.debug(`比较: ${pm.msgObj.sender_id} === ${senderId} ? ${match}`);
        return match;
      })
      .map(pm => pm.msgObj);

    //logger.debug(`动态感知GET: ${groupId} sender ${senderId} 有${senderMessages.length}条消息`);
    return senderMessages;
  }

  /**
   * 开始构建助手回复（生成UUID标记本次对话对）（线程安全）
   * @param {string} groupId - 群ID
   * @returns {Promise<string>} 本次对话对的UUID
   */
  async startAssistantMessage(groupId) {
    return this._executeForGroup(groupId, async () => {
      const history = this._getOrInitHistory(groupId);
      history.currentAssistantMessage = '';
      history.currentPairId = randomUUID();

      logger.debug(`生成对话对UUID: ${groupId} ID ${history.currentPairId}`);
      return history.currentPairId;
    });
  }

  /**
   * 追加内容到当前助手消息（线程安全）
   * @param {string} groupId - 群ID
   * @param {string} content - 要追加的内容
   * @returns {Promise<void>}
   */
  async appendToAssistantMessage(groupId, content) {
    return this._executeForGroup(groupId, async () => {
      const history = this._getOrInitHistory(groupId);
      if (history.currentAssistantMessage) {
        history.currentAssistantMessage += '\n' + content;
      } else {
        history.currentAssistantMessage = content;
      }
    });
  }

  /**
   * 取消当前助手消息（放弃发送）（线程安全）
   * 用于当检测到新消息时，放弃当前生成的回复
   * @param {string} groupId - 群ID
   * @returns {Promise<void>}
   */
  async cancelCurrentAssistantMessage(groupId) {
    return this._executeForGroup(groupId, async () => {
      const history = this._getOrInitHistory(groupId);
      logger.debug(`取消消息: ${groupId} 放弃${history.currentAssistantMessage?.length || 0}字符`);
      history.currentAssistantMessage = '';
      history.currentPairId = null;
    });
  }

  /**
   * 完成当前对话对，保存到历史（线程安全）
   * @param {string} groupId - 群ID
   * @param {string} userContent - 用户消息内容（完整的 XML 格式，可选）
   * @returns {Promise<boolean>} 是否保存成功
   */
  async finishConversationPair(groupId, userContent = null) {
    return this._executeForGroup(groupId, async () => {
      const history = this._getOrInitHistory(groupId);

      // 如果没有传入 userContent，使用旧的逻辑（简单拼接，已废弃）
      if (!userContent) {
        logger.warn(`保存检查: ${groupId} 未传入userContent，使用旧逻辑`);
        userContent = history.processingMessages.map(pm => pm.summary).join('\n\n');
      }

      // 严格检查状态一致性
      const pairId = history.currentPairId;
      const assistantMsg = history.currentAssistantMessage;
      
      // 状态检查：必须同时满足所有条件
      if (!pairId) {
        logger.warn(`保存跳过: ${groupId} 没有pairId (状态未初始化或已取消)`);
        return false;
      }
      
      if (!userContent || userContent.trim().length === 0) {
        logger.warn(`保存跳过: ${groupId} pairId ${pairId.substring(0, 8)} userContent为空`);
        // 清理不完整的状态
        history.currentPairId = null;
        history.currentAssistantMessage = '';
        return false;
      }
      
      if (!assistantMsg || assistantMsg.trim().length === 0) {
        logger.warn(`保存跳过: ${groupId} pairId ${pairId.substring(0, 8)} assistantMsg为空`);
        // 清理不完整的状态
        history.currentPairId = null;
        history.currentAssistantMessage = '';
        return false;
      }

      // 所有检查通过，保存对话对
      history.conversations.push(
        { role: 'user', content: userContent, pairId },
        { role: 'assistant', content: assistantMsg, pairId }
      );

      // 保持最多N组对话（2N条消息）
      const maxMessages = this.maxConversationPairs * 2;
      while (history.conversations.length > maxMessages) {
        history.conversations.shift();
        history.conversations.shift(); // 删除一对
      }

      const pairCount = history.conversations.length / 2;
      const processingCount = history.processingMessages.length;
      const pendingCount = history.pendingMessages.length;
      
      logger.info(`保存成功: ${groupId} pairId ${pairId.substring(0, 8)} 包含${processingCount}条processing, ${pairCount}/${this.maxConversationPairs}组历史, ${pendingCount}条pending`);

      // 清空正在处理的消息、当前助手消息和pairId
      // 注意：只清空 processingMessages，保留 pendingMessages（这些是任务完成后才到达的新消息）
      history.processingMessages = [];
      history.currentAssistantMessage = '';
      history.currentPairId = null;

      return true;
    });
  }

  /**
   * 撤销指定的对话对（线程安全，通过pairId精确删除）
   * @param {string} groupId - 群ID
   * @param {string} pairId - 要删除的对话对UUID
   * @returns {Promise<boolean>} 是否删除成功
   */
  async cancelConversationPairById(groupId, pairId) {
    return this._executeForGroup(groupId, async () => {
      const history = this.histories.get(groupId);
      if (!history) {
        return false;
      }

      // 找到并删除所有带有此pairId的消息
      const initialLength = history.conversations.length;
      history.conversations = history.conversations.filter(msg => msg.pairId !== pairId);
      const deletedCount = initialLength - history.conversations.length;

      if (deletedCount > 0) {
        logger.debug(`撤销对话对: ${groupId} pairId ${pairId.substring(0, 8)} 删除${deletedCount}条`);

        // 如果删除的是当前正在构建的对话对，清空状态
        if (history.currentPairId === pairId) {
          history.currentAssistantMessage = '';
          history.currentPairId = null;
          logger.debug(`撤销: ${groupId} 清空当前构建中的对话对`);
        }

        return true;
      }

      logger.warn(`撤销失败: ${groupId} 未找到pairId ${pairId.substring(0, 8)}`);
      return false;
    });
  }

  /**
   * 获取完整的对话历史数组（用于API请求）（只读操作）
   * @param {string} groupId - 群ID
   * @returns {Array} 对话历史数组 [{ role, content }, ...]（不包含pairId）
   */
  getConversationHistory(groupId) {
    const history = this.histories.get(groupId);
    if (!history) {
      return [];
    }

    // 返回副本，去除pairId字段（API不需要）
    return history.conversations.map(({ role, content }) => ({ role, content }));
  }

  /**
   * 获取待回复消息数量
   * @param {string} groupId - 群ID
   * @returns {number} 待回复消息数量
   */
  getPendingMessageCount(groupId) {
    const history = this.histories.get(groupId);
    return history ? history.pendingMessages.length : 0;
  }

  /**
   * 获取历史对话对数量
   * @param {string} groupId - 群ID
   * @returns {number} 历史对话对数量
   */
  getConversationPairCount(groupId) {
    const history = this.histories.get(groupId);
    return history ? history.conversations.length / 2 : 0;
  }

  /**
   * 清空指定群的所有数据（线程安全）
   * @param {string} groupId - 群ID
   * @returns {Promise<void>}
   */
  async clearGroup(groupId) {
    return this._executeForGroup(groupId, async () => {
      this.histories.delete(groupId);
      logger.info(`清空群历史: ${groupId}`);
    });
  }

  /**
   * 获取所有群ID列表
   * @returns {Array<string>} 群ID列表
   */
  getAllGroupIds() {
    return Array.from(this.histories.keys());
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    const stats = {
      totalGroups: this.histories.size,
      groups: {}
    };

    for (const [groupId, history] of this.histories) {
      stats.groups[groupId] = {
        conversationPairs: history.conversations.length / 2,
        pendingMessages: history.pendingMessages.length,
        isReplying: !!history.currentPairId
      };
    }

    return stats;
  }
}

// 导出
export default GroupHistoryManager;
export { GroupHistoryManager, GroupTaskQueue };
