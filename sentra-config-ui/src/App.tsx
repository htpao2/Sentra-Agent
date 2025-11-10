import { useState, useEffect } from 'react';
import {
  AppBar,
  Button,
  Toolbar,
  Window,
  WindowContent,
  WindowHeader,
  TextField,
  MenuList,
  MenuListItem,
  Separator,
  Hourglass,
  Avatar,
} from 'react95';
import { ConfigData, ModuleConfig, PluginConfig, EnvVariable } from './types/config';
import { fetchConfigs, saveModuleConfig, savePluginConfig } from './services/api';
import styles from './App.module.css';

// 详细的插件和模块图标映射
const ICON_MAP: Record<string, string> = {
  // === 核心模块 ===
  'sentra-prompts': 'psychology',
  'sentra-mcp': 'hub',
  'sentra-emo': 'sentiment_satisfied',
  'sentra-adapter': 'settings_ethernet',
  'sentra-rag': 'storage',
  
  // === 搜索类 ===
  'bilibili_search': 'video_library',
  'github_repo_info': 'code',
  'image_search': 'image_search',
  'realtime_search': 'search',
  'web_parser': 'article',
  
  // === 图像类 ===
  'image_draw': 'brush',
  'image_vision_edit': 'auto_fix_high',
  'image_vision_read': 'visibility',
  'web_render_image': 'screenshot',
  
  // === 视频/音频类 ===
  'av_transcribe': 'subtitles',
  'video_generate': 'videocam',
  'video_vision_read': 'video_library',
  'custom_music_card': 'library_music',
  'music_card': 'music_note',
  'suno_music_generate': 'audio_file',
  
  // === QQ 消息类 ===
  'qq_message_emojilike': 'favorite',
  'qq_message_recall': 'undo',
  'qq_message_getfriendhistory': 'chat_bubble',
  'qq_message_getgrouphistory': 'forum',
  'qq_message_recentcontact': 'recent_actors',
  
  // === QQ 群组类 ===
  'qq_group_info': 'groups',
  'qq_group_list': 'group',
  'qq_group_memberinfo': 'person',
  'qq_group_memberlist': 'people',
  'qq_group_ban': 'block',
  'qq_group_kick': 'person_remove',
  'qq_group_leave': 'exit_to_app',
  'qq_group_setcard': 'badge',
  'qq_group_setname': 'edit',
  'qq_group_wholeban': 'voice_over_off',
  
  // === QQ 用户类 ===
  'qq_user_deletefriend': 'person_remove',
  'qq_user_getprofilelike': 'thumb_up',
  'qq_user_sendlike': 'favorite_border',
  'qq_user_sendpoke': 'touch_app',
  
  // === QQ 账户类 ===
  'qq_account_getqqprofile': 'account_circle',
  'qq_account_setqqavatar': 'account_box',
  'qq_account_setqqprofile': 'settings',
  'qq_account_setselflongnick': 'description',
  'qq_avatar_get': 'face',
  
  // === QQ 系统类 ===
  'qq_system_getmodelshow': 'phone_android',
  'qq_system_getuserstatus': 'online_prediction',
  'qq_system_setdiyonlinestatus': 'edit_note',
  'qq_system_setmodelshow': 'devices',
  'qq_system_setonlinestatus': 'circle',
  
  // === 文档/文件类 ===
  'document_read': 'description',
  'write_file': 'save',
  'mindmap_gen': 'account_tree',
  'html_to_app': 'web',
  
  // === 系统类 ===
  'system_info': 'computer',
  'desktop_control': 'desktop_windows',
  'weather': 'wb_sunny',
  
  // === 默认 ===
  'default': 'folder',
};


type FileItem = (ModuleConfig | PluginConfig) & { type: 'module' | 'plugin' };
type DeskWindow = {
  id: string;
  file: FileItem;
  pos: { x: number; y: number };
  z: number;
  minimized: boolean;
  editedVars: EnvVariable[];
  maximized?: boolean;
  restorePos?: { x: number; y: number };
};

function App() {
  const [loading, setLoading] = useState(true);
  const [configData, setConfigData] = useState<ConfigData | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [startMenuOpen, setStartMenuOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [draggedIcon, setDraggedIcon] = useState<FileItem | null>(null);
  const [isDraggingWindow, setIsDraggingWindow] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [openWindows, setOpenWindows] = useState<DeskWindow[]>([]);
  const [activeWinId, setActiveWinId] = useState<string | null>(null);
  const [draggingWinId, setDraggingWinId] = useState<string | null>(null);
  const [zNext, setZNext] = useState(1000);
  const [aboutOpen, setAboutOpen] = useState(false);
  // 图标排序（拖拽放置）
  const [iconOrder, setIconOrder] = useState<string[]>([]);

  useEffect(() => {
    loadConfigs();
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 初始化读取本地图标顺序
  useEffect(() => {
    try {
      const saved = localStorage.getItem('sentra_config_ui_icon_order');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setIconOrder(parsed);
      }
    } catch {}
  }, []);

  // 持久化图标顺序
  useEffect(() => {
    try {
      localStorage.setItem('sentra_config_ui_icon_order', JSON.stringify(iconOrder));
    } catch {}
  }, [iconOrder]);

  const loadConfigs = async () => {
    try {
      setLoading(true);
      const data = await fetchConfigs();
      setConfigData(data);
    } catch (error) {
      alert('❌ 加载配置失败\n\n' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setLoading(false);
    }
  };

  const getIconForFile = (file: FileItem): string => {
    const name = file.name.toLowerCase().replace(/[-_]/g, '');
    
    // 精确匹配
    for (const [key, icon] of Object.entries(ICON_MAP)) {
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
      if (name === normalizedKey || name.includes(normalizedKey)) {
        return icon;
      }
    }
    
    return ICON_MAP.default;
  };

  const getItemKey = (file: FileItem) => `${file.type}:${file.name}`;

  const reorderIcons = (srcKey: string, destKey: string, all: FileItem[]) => {
    setIconOrder(prev => {
      // 以现有顺序为基准，补足缺失项
      const base = prev && prev.length > 0 ? [...prev] : all.map(getItemKey);
      const currentKeys = new Set(all.map(getItemKey));
      // 清理不存在的旧键
      const cleaned = base.filter(k => currentKeys.has(k));
      // 确保所有新项都在列表中（追加到末尾）
      for (const k of currentKeys) if (!cleaned.includes(k)) cleaned.push(k);

      const from = cleaned.indexOf(srcKey);
      const to = cleaned.indexOf(destKey);
      if (from === -1 || to === -1 || from === to) return cleaned;
      const [moved] = cleaned.splice(from, 1);
      cleaned.splice(to, 0, moved);
      return cleaned;
    });
  };

  const handleIconClick = (item: FileItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedFile(item);
  };

  const openWindow = (file: FileItem) => {
    const id = `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const defaultWidth = 650;
    const defaultHeight = 520;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 打开默认居中
    const pos = {
      x: Math.max(8, Math.floor((vw - defaultWidth) / 2)),
      y: Math.max(64, Math.floor((vh - defaultHeight) / 2))
    };
    const win: DeskWindow = {
      id,
      file,
      pos,
      z: zNext + 1,
      minimized: false,
      editedVars: file.variables ? [...file.variables] : [],
    };
    setOpenWindows(ws => [...ws, win]);
    setZNext(z => z + 1);
    setActiveWinId(id);
  };

  const bringToFront = (id: string) => {
    setOpenWindows(ws => {
      const nextZ = zNext + 1;
      const mapped = ws.map(w => (w.id === id ? { ...w, z: nextZ, minimized: false } : w));
      return mapped;
    });
    setZNext(z => z + 1);
    setActiveWinId(id);
  };

  const handleIconDoubleClick = (file: FileItem) => {
    openWindow(file);
  };

  const handleIconDragStart = (e: React.DragEvent, file: FileItem) => {
    setDraggedIcon(file);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', getItemKey(file)); } catch {}
  };

  const handleIconDragEnd = () => {
    setDraggedIcon(null);
  };

  const handleWindowMouseDown = (e: React.MouseEvent, id: string) => {
    const header = (e.target as HTMLElement).closest('.window-header');
    bringToFront(id);
    if (header) {
      const w = openWindows.find(x => x.id === id);
      if (!w) return;
      if (w.maximized) return; // 最大化时不允许拖动
      setIsDraggingWindow(true);
      setDraggingWinId(id);
      setDragStart({ x: e.clientX - w.pos.x, y: e.clientY - w.pos.y });
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingWindow && draggingWinId) {
        const grid = 8;
        const rawX = e.clientX - dragStart.x;
        const rawY = e.clientY - dragStart.y;
        let nx = Math.round(rawX / grid) * grid;
        let ny = Math.round(rawY / grid) * grid;
        // 边界限制（留出 8px 边距与 64px 顶部任务栏空间）
        const margin = 8;
        const topBar = 64;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        nx = Math.max(margin, Math.min(vw - 360, nx));
        ny = Math.max(topBar, Math.min(vh - 160, ny));
        setOpenWindows(ws => ws.map(w => (w.id === draggingWinId ? { ...w, pos: { x: nx, y: ny } } : w)));
      }
    };

    const handleMouseUp = () => {
      setIsDraggingWindow(false);
      setDraggingWinId(null);
      // 持久化当前窗口位置
      if (draggingWinId) {
        const w = openWindows.find(x => x.id === draggingWinId);
        if (w) {
          try { localStorage.setItem('sentra_config_ui_winpos_' + getItemKey(w.file), JSON.stringify(w.pos)); } catch {}
        }
      }
    };

    if (isDraggingWindow) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingWindow, dragStart]);

  const handleDesktopClick = () => {
    setSelectedFile(null);
    setStartMenuOpen(false);
  };

  const handleClose = (id: string) => {
    setOpenWindows(ws => ws.filter(w => w.id !== id));
    if (activeWinId === id) setActiveWinId(null);
  };

  const handleSave = async (id: string) => {
    const win = openWindows.find(w => w.id === id);
    if (!win) return;

    try {
      setSaving(true);
      const validVars = win.editedVars.filter(v => v.key.trim());
      if (win.file.type === 'module') {
        await saveModuleConfig(win.file.name, validVars);
      } else {
        await savePluginConfig(win.file.name, validVars);
      }
      alert(`✅ 保存成功！\n\n文件: ${win.file.name}/.env\n配置项: ${validVars.length} 个`);
      await loadConfigs();
    } catch (error) {
      alert('❌ 保存失败\n\n' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  const handleVarChange = (id: string, index: number, field: 'key' | 'value' | 'comment', val: string) => {
    setOpenWindows(ws => ws.map(w => {
      if (w.id !== id) return w;
      const newVars = [...w.editedVars];
      newVars[index] = { ...newVars[index], [field]: val };
      return { ...w, editedVars: newVars };
    }));
  };

  const handleAddVar = (id: string) => {
    setOpenWindows(ws => ws.map(w => w.id === id ? { ...w, editedVars: [...w.editedVars, { key: '', value: '', comment: '' }] } : w));
  };

  const handleDeleteVar = (id: string, index: number) => {
    if (confirm('确定要删除这个配置项吗？')) {
      setOpenWindows(ws => ws.map(w => w.id === id ? { ...w, editedVars: w.editedVars.filter((_, i) => i !== index) } : w));
    }
  };

  const toggleMaximize = (id: string) => {
    setOpenWindows(ws => ws.map(w => {
      if (w.id !== id) return w;
      if (w.maximized) {
        const rp = w.restorePos || { x: 120, y: 80 };
        return { ...w, maximized: false, pos: rp, restorePos: undefined };
      } else {
        return { ...w, maximized: true, restorePos: { ...w.pos } };
      }
    }));
    setActiveWinId(id);
    bringToFront(id);
  };

  const modules: FileItem[] = configData?.modules.map(m => ({ ...m, type: 'module' as const })) || [];
  const plugins: FileItem[] = configData?.plugins.map(p => ({ ...p, type: 'plugin' as const })) || [];
  // 统一显示：模块在前，插件在后
  const allItems: FileItem[] = [...modules, ...plugins];

  // 应用拖拽顺序
  const orderedItems: FileItem[] = [...allItems].sort((a, b) => {
    const aKey = getItemKey(a);
    const bKey = getItemKey(b);
    const ia = iconOrder.indexOf(aKey);
    const ib = iconOrder.indexOf(bKey);
    const fallbackA = allItems.indexOf(a);
    const fallbackB = allItems.indexOf(b);
    return (ia === -1 ? 100000 + fallbackA : ia) - (ib === -1 ? 100000 + fallbackB : ib);
  });

  const formatTime = (date: Date) => {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  };

  if (loading) {
    return (
      <div className={styles.loadingScreen}>
        <div className={styles.loadingBox}>
          <Hourglass size={32} />
          <div className={styles.loadingText}>正在加载配置文件...</div>
          <div className={styles.loadingHint}>请稍候</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.desktop} onClick={handleDesktopClick}>
        {/* 桌面图标区域 */}
        <div className={styles.desktopIcons}
             onDragOver={(e) => e.preventDefault()}>
          {orderedItems.map((file) => (
            <div
              key={`${file.type}-${file.name}`}
              className={`${styles.desktopIcon} ${
                selectedFile?.name === file.name && selectedFile?.type === file.type
                  ? styles.selected
                  : ''
              } ${draggedIcon?.name === file.name && draggedIcon?.type === file.type ? styles.dragging : ''}`}
              onClick={(e) => handleIconClick(file, e)}
              onDoubleClick={() => handleIconDoubleClick(file)}
              draggable
              onDragStart={(e) => handleIconDragStart(e, file)}
              onDragEnd={handleIconDragEnd}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const src = e.dataTransfer.getData('text/plain');
                const dest = getItemKey(file);
                if (src && dest && src !== dest) reorderIcons(src, dest, allItems);
                setDraggedIcon(null);
              }}
            >
              <span className={`material-icons ${styles.iconImage}`}>
                {getIconForFile(file)}
              </span>
              <div className={styles.iconLabel}>
                {file.name}
                {!file.hasEnv && ' *'}
              </div>
            </div>
          ))}
        </div>

        {/* 任务栏 */}
        <AppBar style={{ zIndex: 200 }}>
          <Toolbar className={styles.taskbar}>
            <div className={styles.taskbarLeft}>
              <Button
                variant="menu"
                size="sm"
                active={startMenuOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setStartMenuOpen(!startMenuOpen);
                }}
                style={{ fontWeight: 'bold', fontSize: 13 }}
              >
                <Avatar
                  size={20}
                  style={{ marginRight: 4 }}
                  src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect fill='%23f00' width='16' height='16'/%3E%3Cpath fill='%23ff0' d='M0,0 L8,8 L0,16 Z'/%3E%3Cpath fill='%230f0' d='M8,8 L16,0 L16,16 Z'/%3E%3C/svg%3E"
                />
                开始
              </Button>

              {openWindows.map(w => (
                <Button
                  key={w.id}
                  size="sm"
                  active={activeWinId === w.id && !w.minimized}
                  style={{ fontSize: 11 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (w.minimized) {
                      bringToFront(w.id);
                    } else {
                      // 最小化
                      setOpenWindows(ws => ws.map(x => x.id === w.id ? { ...x, minimized: true } : x));
                      if (activeWinId === w.id) setActiveWinId(null);
                    }
                  }}
                >
                  <span className="material-icons" style={{ fontSize: 14, marginRight: 4 }}>
                    {w.file.type === 'module' ? 'folder_special' : 'extension'}
                  </span>
                  {w.file.name}
                </Button>
              ))}
            </div>

            <div className={styles.taskbarRight}>
              <div className={styles.statusItem}>
                <span className="material-icons" style={{ fontSize: 14 }}>folder</span>
                {modules.length + plugins.length}
              </div>
              <div className={styles.statusItem}>
                <span className="material-icons" style={{ fontSize: 14 }}>folder_special</span>
                {modules.length}
              </div>
              <div className={styles.statusItem}>
                <span className="material-icons" style={{ fontSize: 14 }}>extension</span>
                {plugins.length}
              </div>
              <Separator orientation="vertical" />
              <div className={styles.statusItem}>
                <span className="material-icons" style={{ fontSize: 14 }}>volume_up</span>
              </div>
              <div className={`${styles.statusItem} ${styles.clock}`}>
                <span className="material-icons" style={{ fontSize: 14 }}>schedule</span>
                {formatTime(currentTime)}
              </div>
            </div>
          </Toolbar>
        </AppBar>

        {/* 开始菜单 */}
        {startMenuOpen && (
          <div className={styles.startMenu} onClick={(e) => e.stopPropagation()}>
            <Window>
              <WindowHeader style={{ background: '#000080', color: '#fff' }}>
                <span style={{ fontWeight: 'bold' }}>Sentra Agent</span>
              </WindowHeader>
              <WindowContent style={{ padding: 0, background: '#c0c0c0' }}>
                <MenuList style={{ background: '#c0c0c0' }}>
                  <MenuListItem
                    onClick={() => {
                      window.location.reload();
                      setStartMenuOpen(false);
                    }}
                  >
                    <span className="material-icons" style={{ fontSize: 16, marginRight: 8 }}>refresh</span>
                    刷新配置
                  </MenuListItem>
                  <MenuListItem
                    onClick={() => {
                      // 名称排序
                      const sorted = [...orderedItems].sort((a, b) => a.name.localeCompare(b.name));
                      setIconOrder(sorted.map(getItemKey));
                      setStartMenuOpen(false);
                    }}
                  >
                    <span className="material-icons" style={{ fontSize: 16, marginRight: 8 }}>sort_by_alpha</span>
                    按名称整理图标
                  </MenuListItem>
                  <MenuListItem
                    onClick={() => {
                      setAboutOpen(true);
                      setStartMenuOpen(false);
                    }}
                  >
                    <span className="material-icons" style={{ fontSize: 16, marginRight: 8 }}>info</span>
                    关于
                  </MenuListItem>
                  <Separator />
                  <MenuListItem
                    onClick={() => {
                      if (confirm('确定要关闭配置管理器吗？')) {
                        window.close();
                      }
                      setStartMenuOpen(false);
                    }}
                  >
                    <span className="material-icons" style={{ fontSize: 16, marginRight: 8 }}>power_settings_new</span>
                    关闭
                  </MenuListItem>
                </MenuList>
              </WindowContent>
            </Window>
          </div>
        )}

        {/* 多窗口：配置编辑器 */}
        {openWindows.filter(w => !w.minimized).map(w => (
          <div 
            key={w.id}
            className={styles.editorWindow}
            style={{
              left: w.maximized ? 8 : w.pos.x,
              top: w.maximized ? 48 : w.pos.y,
              width: w.maximized ? 'calc(100vw - 16px)' as any : 650,
              height: w.maximized ? 'calc(100vh - 64px)' as any : 'auto',
              maxHeight: w.maximized ? 'calc(100vh - 64px)' as any : '80vh',
              resize: w.maximized ? 'none' : 'both',
              cursor: isDraggingWindow && draggingWinId === w.id ? 'grabbing' : 'default',
              boxShadow: 'none',
              zIndex: w.z
            }}
            onClick={(e) => { e.stopPropagation(); bringToFront(w.id); }}
            onMouseDown={(e) => handleWindowMouseDown(e, w.id)}
          >
            <Window>
              <WindowHeader 
                className="window-header"
                style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center',
                  cursor: 'grab',
                  background: (activeWinId === w.id) ? '#000080' : '#808080',
                  color: '#fff'
                }}
                onDoubleClick={() => toggleMaximize(w.id)}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="material-icons" style={{ fontSize: 16 }}>
                    {w.file.type === 'module' ? 'folder_special' : 'extension'}
                  </span>
                  {w.file.name} - .env 配置文件
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button size="sm" onClick={() => setOpenWindows(ws => ws.map(x => x.id === w.id ? { ...x, minimized: true } : x))}>_</Button>
                  <Button size="sm" onClick={() => toggleMaximize(w.id)}>{w.maximized ? '[ ]' : '□'}</Button>
                  <Button size="sm" onClick={() => handleClose(w.id)}>X</Button>
                </div>
              </WindowHeader>
              <Toolbar className={styles.toolbar}>
                <Button size="sm" onClick={() => handleAddVar(w.id)}>
                  <span className="material-icons" style={{ fontSize: 14, marginRight: 4 }}>add</span>
                  新增
                </Button>
                <Button size="sm" primary onClick={() => handleSave(w.id)} disabled={saving}>
                  <span className="material-icons" style={{ fontSize: 14, marginRight: 4 }}>save</span>
                  {saving ? '保存中...' : '保存'}
                </Button>
                <Button size="sm" onClick={() => handleClose(w.id)}>
                  <span className="material-icons" style={{ fontSize: 14, marginRight: 4 }}>close</span>
                  关闭
                </Button>
                <Separator orientation="vertical" />
                <span className={styles.toolbarInfo}>
                  {w.editedVars.length} 个配置项
                </span>
              </Toolbar>
              <WindowContent className={styles.editorContent} style={{ maxHeight: w.maximized ? 'calc(100vh - 200px)' : undefined }}>
                {w.editedVars.length === 0 ? (
                  <div className={styles.emptyState}>
                    <div className={styles.emptyIcon}>
                      <span className="material-icons" style={{ fontSize: 64 }}>description</span>
                    </div>
                    <div className={styles.emptyText}>配置文件为空</div>
                    <div className={styles.emptyHint}>点击上方"新增"按钮添加配置项</div>
                  </div>
                ) : (
                  w.editedVars.map((v, idx) => (
                    <div key={idx} className={styles.configBlock}>
                      <div className={styles.codePreview}>
                        {v.comment && (
                          <>
                            <span className={styles.codeComment}># {v.comment}</span>
                            <br />
                          </>
                        )}
                        <span className={styles.codeVarName}>{v.key || '变量名'}</span>
                        <span className={styles.codeEquals}>=</span>
                        <span className={styles.codeVarValue}>{v.value || '值'}</span>
                      </div>

                      <div className={styles.inputLabel}>
                        <span className="material-icons" style={{ fontSize: 14 }}>comment</span>
                        注释说明
                      </div>
                      <textarea
                        className={styles.textArea}
                        value={v.comment || ''}
                        onChange={(e: any) => handleVarChange(w.id, idx, 'comment', e.target.value)}
                        placeholder="配置项的说明（可选）"
                      />

                      <div className={styles.inputLabel}>
                        <span className="material-icons" style={{ fontSize: 14 }}>vpn_key</span>
                        变量名
                      </div>
                      <TextField
                        value={v.key}
                        onChange={(e: any) => handleVarChange(w.id, idx, 'key', e.target.value)}
                        placeholder="API_KEY"
                        fullWidth
                        style={{ fontFamily: 'monospace' }}
                      />

                      <div className={styles.inputLabel}>
                        <span className="material-icons" style={{ fontSize: 14 }}>edit</span>
                        变量值
                      </div>
                      <TextField
                        value={v.value}
                        onChange={(e: any) => handleVarChange(w.id, idx, 'value', e.target.value)}
                        placeholder="your-value-here"
                        fullWidth
                        style={{ fontFamily: 'monospace' }}
                      />

                      <div style={{ marginTop: 12, textAlign: 'right' }}>
                        <Button size="sm" onClick={() => handleDeleteVar(w.id, idx)}>
                          <span className="material-icons" style={{ fontSize: 14, marginRight: 4 }}>delete</span>
                          删除
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </WindowContent>
            </Window>
          </div>
        ))}

        {/* 关于窗口 */}
        {aboutOpen && (
          <div
            className={styles.editorWindow}
            style={{
              left: Math.max(8, Math.floor((window.innerWidth - 480) / 2)),
              top: Math.max(64, Math.floor((window.innerHeight - 360) / 2)),
              width: 480,
              height: 'auto',
              maxHeight: '80vh',
              resize: 'none',
              boxShadow: 'none',
              zIndex: 9999
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Window>
              <WindowHeader
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: '#000080',
                  color: '#fff'
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="material-icons" style={{ fontSize: 16 }}>info</span>
                  关于 Sentra Agent
                </span>
                <Button size="sm" onClick={() => setAboutOpen(false)}>X</Button>
              </WindowHeader>
              <WindowContent style={{ padding: 16, background: '#c0c0c0', maxHeight: '60vh', overflow: 'auto' }}>
                <div style={{ fontFamily: 'MS Sans Serif', fontSize: 11, lineHeight: 1.6 }}>
                  <div style={{ marginBottom: 12, padding: 8, background: '#ffffff', border: '2px solid #808080' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: 8, fontSize: 12 }}>Sentra Config Manager</div>
                    <div>Version: 2.0.0</div>
                    <div>Build: 2024-11-10</div>
                  </div>
                  
                  <div style={{ marginBottom: 12, padding: 8, background: '#ffffff', border: '2px solid #808080' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: 6 }}>配置统计</div>
                    <div>核心模块: {modules.length} 个</div>
                    <div>MCP插件: {plugins.length} 个</div>
                    <div>配置文件: {modules.length + plugins.length} 个</div>
                    <div>已配置: {[...modules, ...plugins].filter(f => f.hasEnv).length} 个</div>
                    <div>待配置: {[...modules, ...plugins].filter(f => !f.hasEnv).length} 个</div>
                  </div>

                  <div style={{ marginBottom: 12, padding: 8, background: '#ffffff', border: '2px solid #808080' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: 6 }}>系统信息</div>
                    <div>平台: Windows 95 UI</div>
                    <div>框架: React + React95</div>
                    <div>图标库: Material Icons</div>
                  </div>

                  <div style={{ textAlign: 'center', marginTop: 16 }}>
                    <Button onClick={() => setAboutOpen(false)}>确定</Button>
                  </div>
                </div>
              </WindowContent>
            </Window>
          </div>
        )}
      </div>
  );
}

export default App;
