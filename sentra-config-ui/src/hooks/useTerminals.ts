import { useState } from 'react';
import { getAuthHeaders } from '../services/api';
import type { TerminalWin } from '../types/ui';
import type { ToastMessage } from '../components/Toast';

export type UseTerminalsParams = {
  addToast: (type: ToastMessage['type'], title: string, message?: string) => void;
  allocateZ?: () => number; // optional z-index allocator to align with desktop windows
};

export function useTerminals({ addToast, allocateZ }: UseTerminalsParams) {
  const [terminalWindows, setTerminalWindows] = useState<TerminalWin[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);

  const bringTerminalToFront = (id: string) => {
    const z = allocateZ ? allocateZ() : undefined;
    setTerminalWindows(prev => prev.map(t => t.id === id ? { ...t, z: z ?? (t.z + 1) } : t));
    setActiveTerminalId(id);
  };

  const spawnTerminal = (title: string, appKey: string, processId: string) => {
    const id = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const z = allocateZ ? allocateZ() : 1001;
    const terminal: TerminalWin = {
      id,
      title,
      processId,
      appKey,
      pos: { x: window.innerWidth / 2 - 350, y: window.innerHeight / 2 - 250 },
      z,
      minimized: false,
    };
    setTerminalWindows(prev => [...prev, terminal]);
    setActiveTerminalId(id);
    return id;
  };

  const runScript = async (path: string, title: string, appKey: string, args: string[]) => {
    const existing = terminalWindows.find(t => t.appKey === appKey);
    if (existing) {
      if (existing.minimized) {
        setTerminalWindows(prev => prev.map(t => t.id === existing.id ? { ...t, minimized: false } : t));
      }
      bringTerminalToFront(existing.id);
      return;
    }
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ args }),
      });
      const data = await response.json();
      if (data.success && data.processId) {
        spawnTerminal(title, appKey, data.processId);
      }
    } catch (error) {
      addToast('error', `Failed to run ${title}`, error instanceof Error ? error.message : undefined);
    }
  };

  const handleRunBootstrap = async () => runScript('/api/scripts/bootstrap', 'Bootstrap Script', 'bootstrap', ['--force']);
  const handleRunStart = async () => runScript('/api/scripts/start', 'Start Script', 'start', []);
  const handleRunNapcatBuild = async () => runScript('/api/scripts/napcat', 'Napcat Build', 'napcat-build', ['build']);
  const handleRunNapcatStart = async () => runScript('/api/scripts/napcat', 'Napcat Start', 'napcat-start', ['start']);
  const handleRunUpdate = async () => runScript('/api/scripts/update', 'Update Project', 'update', []);
  const handleRunForceUpdate = async () => runScript('/api/scripts/update', 'Force Update Project', 'force-update', ['force']);
  const handleRunSentiment = async () => runScript('/api/scripts/sentiment', '情感分析服务', 'sentiment', []);

  const handleCloseTerminal = async (id: string) => {
    const terminal = terminalWindows.find(t => t.id === id);
    if (terminal) {
      try {
        await fetch(`/api/scripts/kill/${terminal.processId}`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({})
        });
      } catch (e) {
        console.error('Failed to kill process on close', e);
      }
    }
    setTerminalWindows(prev => prev.filter(t => t.id !== id));
    if (activeTerminalId === id) setActiveTerminalId(null);
  };

  const handleMinimizeTerminal = (id: string) => {
    setTerminalWindows(prev => prev.map(t => t.id === id ? { ...t, minimized: true } : t));
    setActiveTerminalId(null);
  };

  return {
    terminalWindows,
    setTerminalWindows,
    activeTerminalId,
    bringTerminalToFront,
    handleRunBootstrap,
    handleRunStart,
    handleRunNapcatBuild,
    handleRunNapcatStart,
    handleRunUpdate,
    handleRunForceUpdate,
    handleRunSentiment,
    handleCloseTerminal,
    handleMinimizeTerminal,
  } as const;
}
