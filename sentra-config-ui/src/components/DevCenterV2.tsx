import React, { useMemo, useState, type ReactNode } from 'react';
import type { FileItem } from '../types/ui';
import { getDisplayName, getIconForType } from '../utils/icons';
import { IoApps, IoConstruct, IoExtensionPuzzle } from 'react-icons/io5';
import styles from './DevCenter.module.css';

type ToolItem = {
  id: string;
  name: string;
  subtitle?: string;
  icon?: ReactNode;
  onOpen: () => void;
};

type SectionItem = ToolItem | FileItem;

export interface DevCenterProps {
  allItems: FileItem[];
  tools?: ToolItem[];
  onOpenItem: (file: FileItem) => void;
  onOpenDeepWiki?: () => void;
}

type TabKey = 'tools' | 'apps' | 'workers';

export const DevCenterV2: React.FC<DevCenterProps> = ({ allItems, tools = [], onOpenItem, onOpenDeepWiki }) => {
  const [activeTab, setActiveTab] = useState<TabKey>('tools');
  const [query, setQuery] = useState('');

  const norm = (s: string) => (s || '').toLowerCase().trim();
  const q = norm(query);
  const match = (label: string, name: string) => {
    if (!q) return true;
    const a = norm(label);
    const b = norm(name);
    return a.includes(q) || b.includes(q);
  };

  const toolItems = useMemo(() => {
    return tools.filter(t => match(getDisplayName(t.name), t.id));
  }, [tools, q]);

  const apps = useMemo(() => {
    return allItems
      .filter(i => i.type === 'module')
      .filter(i => match(getDisplayName(i.name), i.name));
  }, [allItems, q]);

  const workers = useMemo(() => {
    return allItems
      .filter(i => i.type === 'plugin')
      .filter(i => match(getDisplayName(i.name), i.name));
  }, [allItems, q]);

  const sections: Record<TabKey, SectionItem[]> = {
    tools: toolItems,
    apps,
    workers,
  };

  const currentList = sections[activeTab];

  const renderTabLabel = (key: TabKey) => {
    if (key === 'tools') return '工具模块';
    if (key === 'apps') return '应用模块';
    return '后台插件';
  };

  const renderTabIcon = (key: TabKey) => {
    
    if (key === 'tools') return <IoExtensionPuzzle size={16} />;
    if (key === 'apps') return <IoApps size={16} />;
    return <IoConstruct size={16} />;
  };

  const getCount = (key: TabKey) => sections[key].length;

  const sortByName = (a: FileItem, b: FileItem) =>
    getDisplayName(a.name).localeCompare(getDisplayName(b.name), 'zh-Hans-CN');

  const groupApps = useMemo(() => {
    const core: FileItem[] = [];
    const others: FileItem[] = [];

    apps.forEach(it => {
      const n = (it.name || '').toLowerCase();
      if (n.startsWith('sentra-') || n.includes('sentra/')) core.push(it);
      else others.push(it);
    });

    core.sort(sortByName);
    others.sort(sortByName);

    return [
      { title: '核心模块', items: core },
      { title: '其他模块', items: others },
    ].filter(g => g.items.length > 0);
  }, [apps]);

  const groupWorkers = useMemo(() => {
    const qq: FileItem[] = [];
    const web: FileItem[] = [];
    const image: FileItem[] = [];
    const video: FileItem[] = [];
    const music: FileItem[] = [];
    const mindmap: FileItem[] = [];
    const others: FileItem[] = [];

    workers.forEach(it => {
      const n = (it.name || '').toLowerCase();
      if (n.startsWith('qq_') || n.startsWith('qq-') || n.includes('qq_')) qq.push(it);
      else if (n.includes('mindmap')) mindmap.push(it);
      else if (n.includes('video')) video.push(it);
      else if (n.includes('image')) image.push(it);
      else if (n.includes('music') || n.includes('suno')) music.push(it);
      else if (n.includes('web')) web.push(it);
      else others.push(it);
    });

    qq.sort(sortByName);
    web.sort(sortByName);
    image.sort(sortByName);
    video.sort(sortByName);
    music.sort(sortByName);
    mindmap.sort(sortByName);
    others.sort(sortByName);

    return [
      { title: 'QQ 插件', items: qq },
      { title: '网页 / 浏览插件', items: web },
      { title: '图像插件', items: image },
      { title: '视频插件', items: video },
      { title: '音乐插件', items: music },
      { title: '思维导图插件', items: mindmap },
      { title: '其他插件', items: others },
    ].filter(g => g.items.length > 0);
  }, [workers]);

  return (
    <div className={styles.root}>
      {/* 顶部工具栏：标题 + 全局操作 */}
      <div className={styles.topBar}>
        <div className={styles.titleGroup}>
          <div className={styles.title}>开发中心</div>
          <div className={styles.subtitle}>
            统一管理 Sentra Agent 的应用模块与插件，一键跳转到对应的环境配置界面。
          </div>
        </div>
        <div className={styles.topActions}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索工具 / 模块 / 插件..."
            style={{
              height: 30,
              width: 240,
              borderRadius: 10,
              border: '1px solid rgba(15, 23, 42, 0.12)',
              padding: '0 10px',
              fontSize: 12,
              outline: 'none',
              background: 'rgba(255, 255, 255, 0.85)',
            }}
          />
        </div>
      </div>

      <div className={styles.body}>
        {/* 左侧导航：工具模块 / 应用模块 / 后台插件 */}
        <div className={styles.sidebar}>
          <div className={styles.sidebarHeader}>导航</div>
          <div className={styles.navList}>
            {(['tools', 'apps', 'workers'] as TabKey[]).map(key => (
              <div
                key={key}
                className={`${styles.navItem} ${activeTab === key ? styles.navItemActive : ''}`}
                onClick={() => setActiveTab(key)}
              >
                <div className={styles.navName}>
                  {renderTabIcon(key)}
                  <span>{renderTabLabel(key)}</span>
                </div>
                <span className={styles.navBadge}>{getCount(key)}</span>
              </div>
            ))}
          </div>

          {/* 底部文档入口 */}
          <div style={{ marginTop: 'auto', fontSize: 11, color: '#9ca3af' }}>
            <div style={{ opacity: 0.8 }}>开发文档与指南</div>
            <div
              style={{ cursor: 'pointer', marginTop: 4, color: '#2563eb' }}
              onClick={() => {
                if (onOpenDeepWiki) return onOpenDeepWiki();
                window.open('https://github.com/JustForSO/Sentra-Agent', '_blank');
              }}
            >
              打开 DeepWiki · Sentra Agent
            </div>
          </div>
        </div>

        {/* 右侧内容区域：列表 + 空状态 */}
        <div className={styles.content}>
          <div className={styles.sectionHeader}>
            <div>
              <div className={styles.sectionTitle}>{renderTabLabel(activeTab)}</div>
              <div className={styles.sectionDesc}>
                {activeTab === 'tools'
                  ? '工具模块（内置应用），用于管理与开发相关的辅助能力。'
                  : activeTab === 'apps'
                    ? '应用模块（modules），通常对应一个 Agent 或完整的业务功能入口。'
                    : '后台插件（plugins），负责具体工具能力、系统集成与功能扩展。'}
              </div>
            </div>
          </div>

          {currentList.length === 0 ? (
            <div className={styles.emptyState}>
              {activeTab === 'tools'
                ? '当前分类下还没有可用的工具模块。'
                : (
                  <>
                    当前分类下还没有可管理的项目。
                    <br />
                    请先在后端仓库中添加新的模块或插件，并在桌面顶部菜单中点击“刷新配置”后重新打开此窗口。
                  </>
                )}
            </div>
          ) : (
            <div className={styles.cards}>
              {activeTab === 'tools' ? (
                (currentList as ToolItem[]).map(tool => (
                  <div
                    key={`tool:${tool.id}`}
                    className={styles.appCard}
                  >
                    <div className={styles.appLeft}>
                      <div className={styles.appIcon}>
                        {tool.icon ?? getIconForType(tool.id, 'module')}
                      </div>
                      <div className={styles.appMeta}>
                        <div className={styles.appName}>{getDisplayName(tool.name)}</div>
                        <div className={styles.appPath}>{tool.subtitle || '内置工具'}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={styles.appType}>工具</span>
                      <button
                        className={styles.appActionBtn}
                        onClick={() => tool.onOpen()}
                      >
                        打开
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                (activeTab === 'apps' ? groupApps : groupWorkers).map(group => (
                  <div key={group.title}>
                    <div style={{
                      marginTop: 10,
                      marginBottom: 6,
                      fontSize: 12,
                      fontWeight: 600,
                      color: '#6b7280',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}>
                      <span>{group.title}</span>
                      <span style={{
                        fontSize: 11,
                        background: 'rgba(15, 23, 42, 0.06)',
                        borderRadius: 999,
                        padding: '1px 8px',
                        color: '#4b5563',
                      }}>
                        {group.items.length}
                      </span>
                    </div>

                    {group.items.map(item => (
                      <div
                        key={`${item.type}:${item.name}`}
                        className={styles.appCard}
                      >
                        <div className={styles.appLeft}>
                          <div className={styles.appIcon}>
                            {getIconForType(item.name, item.type)}
                          </div>
                          <div className={styles.appMeta}>
                            <div className={styles.appName}>{getDisplayName(item.name)}</div>
                            <div className={styles.appPath}>{item.path}</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className={styles.appType}>
                            {item.type === 'module' ? '模块' : '插件'}
                          </span>
                          <button
                            className={styles.appActionBtn}
                            onClick={() => onOpenItem(item)}
                          >
                            打开环境配置
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
