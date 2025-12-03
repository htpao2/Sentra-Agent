import { useState, type Dispatch, type SetStateAction } from 'react';
import { MenuBar } from '../components/MenuBar';
import { MacWindow } from '../components/MacWindow';
import { EnvEditor } from '../components/EnvEditor';
import { PresetsEditor } from '../components/PresetsEditor';
import { Dock } from '../components/Dock';
import { Launchpad } from '../components/Launchpad';
import { TerminalWindow } from '../components/TerminalWindow';
import { ToastContainer, ToastMessage } from '../components/Toast';
import { Dialog } from '../components/Dialog';
import { Menu, Item, Submenu, useContextMenu } from 'react-contexify';
import { getDisplayName, getIconForType } from '../utils/icons';
import { IoCubeOutline, IoTerminalOutline, IoFolderOpen, IoServer } from 'react-icons/io5';
import { FileManager } from '../components/FileManager';
import type { DeskWindow, DesktopIcon, FileItem, TerminalWin, AppFolder } from '../types/ui';
import { AppFolderModal } from '../components/AppFolderModal';
import { RedisEditor } from '../components/RedisEditor/RedisEditor';

export type DesktopViewProps = {
  isSolidColor: boolean;
  currentWallpaper: string;
  wallpaperFit: 'cover' | 'contain';
  brightness: number;
  setBrightness: (val: number) => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  showDock: boolean;
  toggleDock: () => void;

  // windows
  openWindows: DeskWindow[];
  setOpenWindows: Dispatch<SetStateAction<DeskWindow[]>>;
  activeWinId: string | null;
  setActiveWinId: (id: string | null) => void;
  bringToFront: (id: string) => void;
  handleClose: (id: string) => void;
  handleSave: (id: string) => void | Promise<void>;
  handleVarChange: (id: string, index: number, field: 'key' | 'value' | 'comment', val: string) => void;
  handleAddVar: (id: string) => void;
  handleDeleteVar: (id: string, index: number) => void;
  saving: boolean;

  // icons and folders
  desktopIcons?: DesktopIcon[];
  desktopFolders?: AppFolder[];

  // terminals
  terminalWindows: TerminalWin[];
  setTerminalWindows: Dispatch<SetStateAction<TerminalWin[]>>;
  activeTerminalId: string | null;
  bringTerminalToFront: (id: string) => void;
  handleCloseTerminal: (id: string) => void;
  handleMinimizeTerminal: (id: string) => void;

  // launchpad & dock
  launchpadOpen: boolean;
  setLaunchpadOpen: (open: boolean) => void;
  allItems: FileItem[];
  recordUsage: (key: string) => void;
  openWindow: (file: FileItem) => void;
  dockFavorites: string[];
  setDockFavorites: Dispatch<SetStateAction<string[]>>;
  uniqueDockItems: any[];

  // toast
  toasts: ToastMessage[];
  removeToast: (id: string) => void;

  // dialog
  dialogOpen: boolean;
  dialogConfig: {
    title: string;
    message: string;
    onConfirm: () => void;
    type: 'info' | 'warning' | 'error';
  };
  setDialogOpen: (open: boolean) => void;

  // wallpaper & menu
  wallpapers: string[];
  defaultWallpapers: string[];
  BING_WALLPAPER: string;
  SOLID_COLORS: { name: string; value: string }[];
  handleWallpaperSelect: (wp: string) => void;
  handleUploadWallpaper: () => void;
  handleDeleteWallpaper: () => void;
  setWallpaperFit: (v: 'cover' | 'contain') => void;
  wallpaperInterval: number;
  setWallpaperInterval: Dispatch<SetStateAction<number>>;
  loadConfigs: () => void | Promise<void>;
  presetsEditorOpen: boolean;
  setPresetsEditorOpen: (open: boolean) => void;
  fileManagerOpen: boolean;
  setFileManagerOpen: (open: boolean) => void;
  addToast: (type: 'success' | 'error' | 'info', title: string, message?: string) => void;
  presetsState: any; // Type will be refined in component
  redisState: any;
};

export function DesktopView(props: DesktopViewProps) {
  const {
    isSolidColor,
    currentWallpaper,
    wallpaperFit,
    brightness,
    setBrightness,
    theme,
    toggleTheme,
    showDock,
    toggleDock,
    openWindows,
    setOpenWindows,
    activeWinId,
    setActiveWinId,
    bringToFront,
    handleClose,
    handleSave,
    handleVarChange,
    handleAddVar,
    handleDeleteVar,
    saving,
    desktopIcons,
    desktopFolders,
    terminalWindows,
    setTerminalWindows,
    activeTerminalId,
    bringTerminalToFront,
    handleCloseTerminal,
    handleMinimizeTerminal,
    launchpadOpen,
    setLaunchpadOpen,
    allItems,
    recordUsage,
    openWindow,
    dockFavorites,
    setDockFavorites,
    uniqueDockItems,
    toasts,
    removeToast,
    dialogOpen,
    dialogConfig,
    setDialogOpen,
    wallpapers,
    defaultWallpapers,
    BING_WALLPAPER,
    SOLID_COLORS,
    handleWallpaperSelect,
    handleUploadWallpaper,
    handleDeleteWallpaper,
    setWallpaperFit,
    wallpaperInterval,
    setWallpaperInterval,
    loadConfigs,
    presetsEditorOpen,
    setPresetsEditorOpen,
    fileManagerOpen,
    setFileManagerOpen,
    presetsState,
    addToast,
    redisState,
  } = props;

  // Folder state
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);

  const { show } = useContextMenu({ id: 'desktop-menu' });
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    show({ event: e });
  };

  return (
    <div
      className="desktop-container"
      style={{
        backgroundImage: isSolidColor ? 'none' : `url(${currentWallpaper})`,
        backgroundColor: isSolidColor ? currentWallpaper : '#000',
        backgroundSize: wallpaperFit,
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        position: 'relative',
        filter: `brightness(${brightness}%)`
      }}
      onContextMenu={handleContextMenu}
    >
      <MenuBar
        menus={[
          {
            label: '文件',
            items: [
              { label: '刷新配置', onClick: () => loadConfigs() },
              { label: '关闭所有窗口', onClick: () => setOpenWindows([]) }
            ]
          },
          {
            label: '视图',
            items: [
              { label: showDock ? '隐藏常用应用 Dock' : '显示常用应用 Dock', onClick: () => toggleDock() },
              { label: '最小化所有', onClick: () => setOpenWindows(ws => ws.map(w => ({ ...w, minimized: true }))) },
              { label: '恢复所有', onClick: () => setOpenWindows(ws => ws.map(w => ({ ...w, minimized: false }))) },
              {
                label: '切换壁纸', onClick: () => {
                  const currentIndex = wallpapers.indexOf(currentWallpaper);
                  const nextIndex = (currentIndex + 1) % wallpapers.length;
                  props.handleWallpaperSelect(wallpapers[nextIndex]);
                }
              }
            ]
          },
          {
            label: '帮助',
            items: [
              { label: '关于 Sentra Agent', onClick: () => window.open('https://github.com/JustForSO/Sentra-Agent', '_blank') }
            ]
          }
        ]}
        onAppleClick={() => { }}
        brightness={brightness}
        setBrightness={setBrightness}
        theme={theme}
        onToggleTheme={toggleTheme}
        showDock={showDock}
        onToggleDock={toggleDock}
      />

      {openWindows.map(w => (
        <MacWindow
          key={w.id}
          id={w.id}
          title={`${getDisplayName(w.file.name)}`}
          icon={getIconForType(w.file.name, w.file.type)}
          zIndex={w.z}
          isActive={activeWinId === w.id}
          isMinimized={w.minimized}
          initialPos={w.pos}
          onClose={() => handleClose(w.id)}
          onMinimize={() => {
            setOpenWindows(ws => ws.map(x => x.id === w.id ? { ...x, minimized: true } : x));
            setActiveWinId(null);
          }}
          onMaximize={() => { }}
          onFocus={() => bringToFront(w.id)}
          onMove={(x, y) => {
            setOpenWindows(ws => ws.map(win => win.id === w.id ? { ...win, pos: { x, y } } : win));
          }}
        >
          <EnvEditor
            appName={getDisplayName(w.file.name)}
            vars={w.editedVars}
            onUpdate={(idx, field, val) => handleVarChange(w.id, idx, field, val)}
            onAdd={() => handleAddVar(w.id)}
            onDelete={(idx) => handleDeleteVar(w.id, idx)}
            onSave={() => handleSave(w.id)}
            saving={saving}
            isExample={!w.file.hasEnv && w.file.hasExample}
            theme={theme}
          />
        </MacWindow>
      ))}

      {presetsEditorOpen && (
        <MacWindow
          id="presets-editor"
          title="预设撰写"
          icon={getIconForType('agent-presets', 'module')}
          zIndex={100}
          isActive={true}
          isMinimized={false}
          initialPos={{ x: 100, y: 50 }}
          initialSize={{ width: 900, height: 600 }}
          onClose={() => setPresetsEditorOpen(false)}
          onMinimize={() => setPresetsEditorOpen(false)}
          onMaximize={() => { }}
          onFocus={() => bringToFront('presets-editor')}
          onMove={() => { }}
        >
          <PresetsEditor
            onClose={() => setPresetsEditorOpen(false)}
            theme={theme}
            addToast={addToast}
            state={presetsState}
          />
        </MacWindow>
      )}

      {fileManagerOpen && (
        <MacWindow
          id="file-manager"
          title="文件管理"
          icon={<IoFolderOpen style={{ color: '#dcb67a' }} />}
          zIndex={101}
          isActive={true}
          isMinimized={false}
          initialPos={{ x: 150, y: 80 }}
          initialSize={{ width: 1000, height: 700 }}
          onClose={() => setFileManagerOpen(false)}
          onMinimize={() => setFileManagerOpen(false)}
          onMaximize={() => { }}
          onFocus={() => bringToFront('file-manager')}
          onMove={() => { }}
        >
          <FileManager
            onClose={() => setFileManagerOpen(false)}
            theme={theme}
            addToast={addToast}
          />
        </MacWindow>
      )}

      {redisState.redisEditorOpen && (
        <MacWindow
          id="redis-editor"
          title="Redis 连接编辑器"
          icon={<IoServer style={{ color: '#dd2476' }} />}
          zIndex={102}
          isActive={true}
          isMinimized={false}
          initialPos={{ x: 120, y: 60 }}
          initialSize={{ width: 1000, height: 650 }}
          onClose={() => redisState.setRedisEditorOpen(false)}
          onMinimize={() => redisState.setRedisEditorOpen(false)}
          onMaximize={() => { }}
          onFocus={() => bringToFront('redis-editor')}
          onMove={() => { }}
        >
          <RedisEditor theme={theme} state={redisState} />
        </MacWindow>
      )}

      {/* Desktop Folders or Icons */}
      {desktopFolders ? (
        <>
          {/* Render Folders */}
          {desktopFolders.map(folder => (
            <div
              key={folder.id}
              onClick={() => setOpenFolderId(folder.id)}
              style={{
                position: 'absolute',
                left: folder.position.x,
                top: folder.position.y,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                cursor: 'pointer',
                padding: '8px',
                borderRadius: '12px',
                transition: 'all 0.2s',
                width: 90,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              <div style={{ marginBottom: 8 }}>{folder.icon}</div>
              <div style={{
                fontSize: 12,
                color: 'white',
                textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                fontWeight: 500,
                textAlign: 'center',
                lineHeight: 1.2,
              }}>
                {folder.name}
              </div>
            </div>
          ))}

          {/* File Manager Icon */}
          {desktopIcons?.find(i => i.id === 'desktop-filemanager') && (
            (() => {
              const icon = desktopIcons.find(i => i.id === 'desktop-filemanager')!;
              // Calculate position based on folders layout
              // startX = 30, gap = 120, startY = 80 (from buildDesktopIcons.tsx)
              const folderCount = desktopFolders.length;
              const leftPos = 30 + (folderCount * 120);

              return (
                <div
                  key={icon.id}
                  style={{
                    position: 'absolute',
                    left: leftPos,
                    top: 80,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    cursor: 'pointer',
                    padding: '8px',
                    borderRadius: '12px',
                    transition: 'all 0.2s',
                    width: 90,
                  }}
                  onClick={icon.onClick}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                    e.currentTarget.style.transform = 'translateY(-2px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  <div style={{ marginBottom: 8 }}>{icon.icon}</div>
                  <div style={{
                    fontSize: 12,
                    color: 'white',
                    textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                    fontWeight: 500,
                    textAlign: 'center',
                    lineHeight: 1.2,
                  }}>
                    {icon.name}
                  </div>
                </div>
              );
            })()
          )}

          {/* Redis Editor Icon */}
          {desktopIcons?.find(i => i.id === 'desktop-redis') && (
            (() => {
              const icon = desktopIcons.find(i => i.id === 'desktop-redis')!;
              const folderCount = desktopFolders.length;
              const leftPos = 30 + (folderCount * 120) + 120; // After File Manager

              return (
                <div
                  key={icon.id}
                  style={{
                    position: 'absolute',
                    left: leftPos,
                    top: 80,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    cursor: 'pointer',
                    padding: '8px',
                    borderRadius: '12px',
                    transition: 'all 0.2s',
                    width: 90,
                  }}
                  onClick={icon.onClick}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                    e.currentTarget.style.transform = 'translateY(-2px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  <div style={{ marginBottom: 8 }}>{icon.icon}</div>
                  <div style={{
                    fontSize: 12,
                    color: 'white',
                    textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                    fontWeight: 500,
                    textAlign: 'center',
                    lineHeight: 1.2,
                  }}>
                    {icon.name}
                  </div>
                </div>
              );
            })()
          )}

          {/* Folder Modal */}
          {openFolderId && (
            <AppFolderModal
              folder={desktopFolders.find(f => f.id === openFolderId)!}
              onAppClick={(_, onClick) => onClick()}
              onClose={() => setOpenFolderId(null)}
            />
          )}
        </>
      ) : desktopIcons && (
        /* Fallback to icons if no folders */
        desktopIcons.map(icon => (
          <div
            key={icon.id}
            style={{
              position: 'absolute',
              left: icon.position.x,
              top: icon.position.y,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              cursor: 'pointer',
              padding: '8px',
              borderRadius: '8px',
              transition: 'background 0.2s',
              width: 80,
            }}
            onClick={icon.onClick}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{ marginBottom: 4 }}>{icon.icon}</div>
            <div style={{
              fontSize: 12,
              color: 'white',
              textShadow: '0 1px 3px rgba(0,0,0,0.8)',
              fontWeight: 500,
              textAlign: 'center',
              lineHeight: 1.2,
            }}>
              {icon.name}
            </div>
          </div>
        ))
      )}


      {terminalWindows.map(terminal => (
        <MacWindow
          key={terminal.id}
          id={terminal.id}
          title={terminal.title}
          icon={<span style={{ fontSize: '16px', display: 'flex', alignItems: 'center' }}>{terminal.title.includes('Bootstrap') ? <IoCubeOutline /> : <IoTerminalOutline />}</span>}
          initialPos={terminal.pos}
          zIndex={terminal.z}
          isActive={activeTerminalId === terminal.id}
          isMinimized={terminal.minimized}
          onClose={() => handleCloseTerminal(terminal.id)}
          onMinimize={() => { handleMinimizeTerminal(terminal.id); }}
          onMaximize={() => { }}
          onFocus={() => bringTerminalToFront(terminal.id)}
          onMove={(x, y) => { setTerminalWindows(prev => prev.map(w => w.id === terminal.id ? { ...w, pos: { x, y } } : w)); }}
        >
          <TerminalWindow processId={terminal.processId} />
        </MacWindow>
      ))}

      <Launchpad
        isOpen={launchpadOpen}
        onClose={() => setLaunchpadOpen(false)}
        items={allItems.map(item => ({
          name: item.name,
          type: item.type,
          onClick: () => {
            recordUsage(`${item.type}:${item.name}`);
            openWindow(item);
            const key = `${item.type}-${item.name}`;
            if (!dockFavorites.includes(key)) {
              setDockFavorites(prev => [...prev, key]);
            }
          }
        }))}
      />

      {showDock && <Dock items={uniqueDockItems.slice(0, 16)} />}

      <ToastContainer toasts={toasts} removeToast={removeToast} />

      <Dialog
        isOpen={dialogOpen}
        title={dialogConfig.title}
        message={dialogConfig.message}
        onConfirm={dialogConfig.onConfirm}
        onCancel={() => setDialogOpen(false)}
        type={dialogConfig.type}
        confirmText="删除"
      />

      <Menu id="desktop-menu" theme="light" animation="scale">
        <Submenu label="切换壁纸">
          {wallpapers.map((wp, i) => (
            <Item key={i} onClick={() => handleWallpaperSelect(wp)}>
              壁纸 {i + 1}
            </Item>
          ))}
          <Item onClick={() => handleWallpaperSelect(BING_WALLPAPER)}>Bing 每日壁纸</Item>
          <Submenu label="纯色背景">
            {SOLID_COLORS.map(c => (
              <Item key={c.name} onClick={() => handleWallpaperSelect(c.value)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 12, height: 12, background: c.value, border: '1px solid #ddd' }} />
                  {c.name}
                </div>
              </Item>
            ))}
          </Submenu>
        </Submenu>
        <Item onClick={handleUploadWallpaper}>上传壁纸...</Item>
        <Item
          onClick={() => handleDeleteWallpaper()}
          disabled={defaultWallpapers.includes(currentWallpaper) || currentWallpaper === BING_WALLPAPER || SOLID_COLORS.some(c => c.value === currentWallpaper)}
        >
          删除当前壁纸
        </Item>
        <Item onClick={() => setWallpaperFit(wallpaperFit === 'cover' ? 'contain' : 'cover')}>
          壁纸填充: {wallpaperFit === 'cover' ? '覆盖 (Cover)' : '包含 (Contain)'}
        </Item>
        <Item onClick={() => setWallpaperInterval(i => (i === 0 ? 60 : 0))}>
          {wallpaperInterval > 0 ? '停止壁纸轮播' : '开启壁纸轮播 (1min)'}
        </Item>
        <Item onClick={() => loadConfigs()}>刷新</Item>
      </Menu>
    </div>
  );
}
