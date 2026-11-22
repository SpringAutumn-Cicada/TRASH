import type { ChatAttachment } from './chat-attachments.js';

type ChatDraft = { text?: string; skill?: string; attachments?: ChatAttachment[] };
type SavedDrafts = { conversation?: string; messages: Record<string, ChatDraft> };
type DraftState = SavedDrafts & { uploading: boolean; sending: boolean };

function createDraftStore(projectId: string) {
  const key = `trash.chat-drafts:${projectId}`;
  const listeners = new Set<() => void>();
  let saved: SavedDrafts = { messages: {} };
  try {
    const stored = window.sessionStorage.getItem(key);
    const parsed: SavedDrafts | null = stored ? JSON.parse(stored) : null;
    if (parsed?.messages && typeof parsed.messages === 'object' && !Array.isArray(parsed.messages)) saved = parsed;
  } catch { /* Keep drafts in memory when browser storage is unavailable. */ }
  let state: DraftState = { ...saved, uploading: false, sending: false };

  function publish(next: DraftState) {
    const changed = state.conversation !== next.conversation || state.messages !== next.messages;
    state = next;
    if (changed) {
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ conversation: next.conversation, messages: next.messages }));
      } catch { /* In-memory drafts still survive navigation within the tab. */ }
    }
    for (const notify of listeners) notify();
  }

  return {
    getSnapshot: () => state,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => { listeners.delete(notify); };
    },
    choose(conversation: string) {
      publish({ ...state, conversation });
    },
    update(conversation: string, update: (draft: ChatDraft) => ChatDraft) {
      const messages = { ...state.messages };
      const next = update(messages[conversation] ?? {});
      if (next.text || next.skill || next.attachments?.length) messages[conversation] = next;
      else delete messages[conversation];
      publish({ ...state, messages, conversation: state.conversation ?? conversation });
    },
    discard(conversation: string, nextConversation: string) {
      const messages = { ...state.messages };
      delete messages[conversation];
      publish({ ...state, messages, conversation: state.conversation === conversation ? nextConversation : state.conversation });
    },
    setUploading(uploading: boolean) {
      publish({ ...state, uploading });
    },
    setSending(sending: boolean) {
      publish({ ...state, sending });
    }
  };
}

export type ChatDraftStore = ReturnType<typeof createDraftStore>;
const projects = new Map<string, ChatDraftStore>();

export function chatDraftStore(projectId: string): ChatDraftStore {
  let store = projects.get(projectId);
  if (!store) {
    store = createDraftStore(projectId);
    projects.set(projectId, store);
  }
  return store;
}
