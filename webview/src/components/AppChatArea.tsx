import HistoryView from './history/HistoryView';
import { ChatScreen } from './ChatScreen';
import type { ChatScreenProps } from './ChatScreen';
import { useCallback } from 'react';
import type { ClaudeMessage } from '../types';
import { useSession } from '../contexts/SessionContext';
import { useUIState } from '../contexts/UIStateContext';

/** HistoryView callbacks (HistoryViewProps is not exported; mirrored here). */
interface HistoryCallbacks {
  onLoadSession: (sessionId: string, provider?: string, model?: string, agent?: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onDeleteSessions: (sessionIds: string[]) => void;
  onExportSession: (sessionId: string, title: string) => void;
  onToggleFavorite: (sessionId: string) => void;
  onUpdateTitle: (sessionId: string, newTitle: string) => void;
  onConvertToCliSession: (sessionId: string) => void;
  onForkSession: (sessionId: string, options?: { forkPointUuid?: string }) => void;
}

interface AppChatAreaProps extends ChatScreenProps, HistoryCallbacks {}

/**
 * Main chat area extracted from App.tsx — the chat screen (kept mounted while
 * browsing history so model catalog, scroll position, and draft attachments
 * survive history ↔ chat) plus the history view. View/session state is
 * consumed from contexts directly (same convention as ChatScreen).
 */
export const AppChatArea = (props: AppChatAreaProps) => {
  const { currentView } = useUIState();
  const { historyData, currentSessionId } = useSession();
  const {
    onLoadSession,
    onDeleteSession,
    onDeleteSessions,
    onExportSession,
    onToggleFavorite,
    onUpdateTitle,
    onConvertToCliSession,
    onForkSession,
    ...chatScreenProps
  } = props;

  // Fork the active session at an assistant reply: the message carries the JSONL row
  // uuid the backend needs to cut the fork at that turn's end.
  const handleForkFromMessage = useCallback((message: ClaudeMessage) => {
    if (!currentSessionId || !onForkSession) return;
    const raw = message.raw;
    const uuid = raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>).uuid : undefined;
    if (typeof uuid !== 'string' || !uuid) return;
    onForkSession(currentSessionId, { forkPointUuid: uuid });
  }, [currentSessionId, onForkSession]);

  return (
    <>
      {/* Keep ChatScreen mounted while browsing history so model catalog,
          scroll position, and draft attachments survive history ↔ chat. */}
      <div
        style={currentView === 'chat'
          ? { display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden' }
          : { display: 'none' }}
      >
        <ChatScreen
          {...chatScreenProps}
          onForkFromMessage={handleForkFromMessage}
        />
      </div>
      {currentView === 'history' && (
        <HistoryView
          historyData={historyData}
          currentProvider={props.currentProvider}
          currentSessionId={currentSessionId}
          onLoadSession={onLoadSession}
          onDeleteSession={onDeleteSession}
          onDeleteSessions={onDeleteSessions}
          onExportSession={onExportSession}
          onToggleFavorite={onToggleFavorite}
          onUpdateTitle={onUpdateTitle}
          onConvertToCliSession={onConvertToCliSession}
          onForkSession={onForkSession}
        />
      )}
    </>
  );
};
