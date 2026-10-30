import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ToastAction, ToastMessage } from '../components/Toast';
import type { SettingsTab } from '../components/settings/SettingsSidebar';
import type { ProviderManageTab } from '../components/settings/ProviderTabSection';
import type { ContextInfo, ViewMode } from '../hooks';
import { APP_VERSION } from '../version/version';
import { DEFAULT_STATUS } from './MessagesContext';
import { forceWebviewRepaint } from '../utils/forceWebviewRepaint';
import { expandQuoteTokens } from '../components/ChatInputBox/utils/quoteRegistry';

const LAST_SEEN_VERSION_KEY = 'lastSeenChangelogVersion';
const DRAFT_CACHE_NAME = 'ccgui-drafts-v1';
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let draftWrites = Promise.resolve();

function draftCacheUrl(): string | null {
  const key = window.__CCGUI_DRAFT_CACHE_KEY__;
  return key ? `https://cc-gui-webview.local/drafts/${encodeURIComponent(key)}` : null;
}

/** Cache Storage is shared by JCEF's file-backed documents; localStorage may be split by file URL. */
async function readDraftCache(): Promise<string> {
  const url = draftCacheUrl();
  if (!url) return '';
  try {
    const cache = await caches.open(DRAFT_CACHE_NAME);
    const response = await cache.match(url);
    if (!response) return '';
    const cached = await response.json();
    if (typeof cached?.text === 'string' && typeof cached.savedAt === 'number'
      && Date.now() - cached.savedAt <= DRAFT_MAX_AGE_MS) return cached.text;
    await cache.delete(url);
  } catch {
    // A denied or unavailable browser cache must not disable editing.
  }
  return '';
}

function writeDraftCache(text: string): void {
  const url = draftCacheUrl();
  if (!url) return;
  // Quote chips use an in-memory registry; persist their Markdown before the document disappears.
  const snapshot = expandQuoteTokens(text);
  draftWrites = draftWrites.then(async () => {
    const cache = await caches.open(DRAFT_CACHE_NAME);
    if (snapshot) {
      await cache.put(url, new Response(JSON.stringify({ text: snapshot, savedAt: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      }));
      const keys = await cache.keys();
      await Promise.all(keys.slice(0, -32).map((key) => cache.delete(key)));
    } else {
      await cache.delete(url);
    }
  }).catch(() => {});
}

export interface UIStateContextValue {
  // Navigation
  currentView: ViewMode;
  setCurrentView: React.Dispatch<React.SetStateAction<ViewMode>>;
  settingsInitialTab: SettingsTab | undefined;
  setSettingsInitialTab: React.Dispatch<React.SetStateAction<SettingsTab | undefined>>;
  /** Deep link into Settings → Providers sub-tab (claude/codex/cli) */
  settingsProviderSubTab: ProviderManageTab | undefined;
  setSettingsProviderSubTab: React.Dispatch<React.SetStateAction<ProviderManageTab | undefined>>;

  // Toasts
  toasts: ToastMessage[];
  addToast: (message: string, type?: ToastMessage['type'], action?: ToastAction) => void;
  dismissToast: (id: string) => void;
  clearToasts: () => void;

  // Misc dialogs that don't belong to useDialogManagement
  addModelDialogOpen: boolean;
  setAddModelDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  showChangelogDialog: boolean;
  closeChangelogDialog: () => void;
  openChangelogDialog: () => void;

  // Active editor context (file + selection)
  contextInfo: ContextInfo | null;
  setContextInfo: React.Dispatch<React.SetStateAction<ContextInfo | null>>;

  // Chat input draft (kept here for cross-view persistence)
  draftInput: string;
  setDraftInput: React.Dispatch<React.SetStateAction<string>>;

  // In-conversation search panel (Cmd/Ctrl+F)
  searchOpen: boolean;
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const UIStateContext = createContext<UIStateContextValue | null>(null);

/**
 * Provides view-level UI state: navigation (currentView), toast queue,
 * miscellaneous dialogs, active editor context info, and the chat input draft.
 *
 * Stage 3 of TASK-P1-01.
 */
export function UIStateProvider({ children }: { children: ReactNode }) {
  const [currentView, setCurrentView] = useState<ViewMode>('chat');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);
  const [settingsProviderSubTab, setSettingsProviderSubTab] = useState<ProviderManageTab | undefined>(undefined);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [addModelDialogOpen, setAddModelDialogOpen] = useState<boolean>(false);
  const [showChangelogDialog, setShowChangelogDialog] = useState<boolean>(() => {
    const lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY);
    return lastSeen !== APP_VERSION;
  });
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [draftInput, updateDraftInput] = useState<string>('');
  const [draftReady, setDraftReady] = useState(!window.__CCGUI_DRAFT_CACHE_KEY__);
  const draftRef = useRef(draftInput);
  const setDraftInput = useCallback<React.Dispatch<React.SetStateAction<string>>>((value) => {
    const next = typeof value === 'function' ? value(draftRef.current) : value;
    draftRef.current = next;
    updateDraftInput(next);
    if (!next || document.visibilityState === 'hidden') writeDraftCache(next);
  }, []);
  const [searchOpen, setSearchOpen] = useState<boolean>(false);

  useEffect(() => {
    if (!window.__CCGUI_DRAFT_CACHE_KEY__) return;
    let disposed = false;
    void readDraftCache().then((text) => {
      if (disposed) return;
      draftRef.current = text;
      updateDraftInput(text);
      setDraftReady(true);
    });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!draftReady) return;
    const timer = window.setTimeout(() => writeDraftCache(draftInput), 200);
    return () => window.clearTimeout(timer);
  }, [draftInput, draftReady]);
  useEffect(() => {
    if (!draftReady) return;
    const persist = () => writeDraftCache(draftRef.current);
    window.addEventListener('pagehide', persist);
    return () => window.removeEventListener('pagehide', persist);
  }, [draftReady]);

  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info', action?: ToastAction) => {
    if (message === DEFAULT_STATUS || !message) return;
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type, action }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const clearToasts = useCallback(() => { setToasts([]); }, []);

  const closeChangelogDialog = useCallback(() => {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, APP_VERSION);
    setShowChangelogDialog(false);
    // The fixed-position fullscreen overlay can leave ghosting after unmount on macOS JCEF.
    forceWebviewRepaint('changelog-dialog-close');
  }, []);

  const openChangelogDialog = useCallback(() => { setShowChangelogDialog(true); }, []);

  const value = useMemo<UIStateContextValue>(
    () => ({
      currentView, setCurrentView,
      settingsInitialTab, setSettingsInitialTab,
      settingsProviderSubTab, setSettingsProviderSubTab,
      toasts, addToast, dismissToast, clearToasts,
      addModelDialogOpen, setAddModelDialogOpen,
      showChangelogDialog, closeChangelogDialog, openChangelogDialog,
      contextInfo, setContextInfo,
      draftInput, setDraftInput,
      searchOpen, setSearchOpen,
    }),
    [
      currentView, settingsInitialTab,
      settingsProviderSubTab,
      toasts, addToast, dismissToast, clearToasts,
      addModelDialogOpen,
      showChangelogDialog, closeChangelogDialog, openChangelogDialog,
      contextInfo, draftInput,
      searchOpen,
    ],
  );

  return <UIStateContext.Provider value={value}>{draftReady ? children : null}</UIStateContext.Provider>;
}

export function useUIState(): UIStateContextValue {
  const ctx = useContext(UIStateContext);
  if (ctx === null) {
    throw new Error('useUIState must be used within a UIStateProvider');
  }
  return ctx;
}

export { UIStateContext };
