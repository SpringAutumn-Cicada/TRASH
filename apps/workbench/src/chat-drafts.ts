import type { ChatAttachment } from './chat-attachments.js';

type ChatDraft = { text?: string; requestId?:string; skill?: string; attachments?: ChatAttachment[]; sandbox?:string; repositoryId?:string };
type SavedDrafts = { conversation?: string; messages: Record<string, ChatDraft> };
type DraftState = SavedDrafts & { uploading: Record<string,true|undefined>; sending: Record<string,true|undefined> };

type DraftView = Pick<DraftState, 'conversation' | 'uploading' | 'sending'> &
  Pick<ChatDraft, 'attachments' | 'skill' | 'sandbox' | 'repositoryId'>;

function draftView({ conversation, messages, uploading, sending }: DraftState): DraftView {
  const { attachments, skill, sandbox, repositoryId } = messages[conversation ?? ''] ?? {};
  return { conversation, uploading, sending, attachments, skill, sandbox, repositoryId };
}

function createDraftStore(key: string) {
  const listeners = new Set<() => void>();
  let saved: SavedDrafts = { messages: {} };
  try {
    const stored = window.sessionStorage.getItem(key);
    const parsed: SavedDrafts | null = stored ? JSON.parse(stored) : null;
    if (parsed?.messages && typeof parsed.messages === 'object' && !Array.isArray(parsed.messages)) saved = parsed;
  } catch { /* Keep drafts in memory when browser storage is unavailable. */ }
  let state: DraftState = { ...saved, uploading: {}, sending: {} };

  let view = draftView(state);

  function publish(next: DraftState) {
    const changed = state.conversation !== next.conversation || state.messages !== next.messages;
    state = next;
    const nextView = draftView(next);
    if (Object.keys(nextView).some(key => {
      const field = key as keyof DraftView;
      return view[field] !== nextView[field];
    })) view = nextView;
    if (changed) {
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ conversation: next.conversation, messages: next.messages }));
      } catch { /* In-memory drafts still survive navigation within the tab. */ }
    }
    for (const notify of listeners) notify();
  }

  function update(conversation: string, edit: (draft: ChatDraft) => ChatDraft) {
    const current = state.messages[conversation] ?? {};
    const next = edit(current);
    if (next === current) return;
    const messages = { ...state.messages };
    if (next.text || next.skill || next.attachments?.length || next.sandbox || next.repositoryId) messages[conversation] = next;
    else delete messages[conversation];
    publish({ ...state, messages, conversation: state.conversation ?? conversation });
  }

  return {
    getSnapshot: () => state,
    getViewSnapshot: () => view,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => { listeners.delete(notify); };
    },
    choose(conversation: string) {
      if (state.conversation !== conversation) publish({ ...state, conversation });
    },
    update,
    updateText(conversation: string, value: string | ((previous: string) => string)) {
      if (state.sending[conversation]) return;
      update(conversation, draft => {
        const previous = draft.text ?? '';
        const text = typeof value === 'string' ? value : value(previous);
        return previous === text ? draft : { ...draft, text, requestId: undefined };
      });
    },
    discard(conversation: string, nextConversation: string) {
      const messages = { ...state.messages };
      delete messages[conversation];
      publish({ ...state, messages, conversation: state.conversation === conversation ? nextConversation : state.conversation });
    },
    setPending(kind:'uploading'|'sending', conversation:string, pending:boolean) {
      const changes={...state[kind]};
      if(pending)changes[conversation]=true;
      else delete changes[conversation];
      publish({ ...state, [kind]: changes });
    }
  };
}

export type ChatDraftStore = ReturnType<typeof createDraftStore>;
const projects = new Map<string, ChatDraftStore>();

export function chatDraftStore(projectId: string, scope: "chat"|"coordination" = "chat"): ChatDraftStore {
  const key = scope === "chat" ? `trash.chat-drafts:${projectId}` : `trash.coordination-drafts:${projectId}`;
  let store = projects.get(key);
  if (!store) {
    store = createDraftStore(key);
    projects.set(key, store);
  }
  return store;
}
