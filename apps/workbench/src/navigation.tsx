import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { ProjectPage } from "@trash/protocol";

export const projectPages: { id: ProjectPage; label: string }[] = [
  { id: "overview", label: "概览" }, { id: "literature", label: "文献" }, { id: "cards", label: "卡片" },
  { id: "wiki", label: "Wiki" }, { id: "data", label: "数据" }, { id: "reproductions", label: "文献复现" }, { id: "experiments", label: "实验" }, { id: "autodl", label: "AutoDL 工作区" }, { id: "results", label: "实验结果" }, { id: "paper", label: "论文" }, { id: "tasks", label: "任务" }, { id: "chat", label: "Agent 对话" }
];
export const DirtyContext = createContext<(id: string, dirty: boolean) => void>(() => {});
export function useUnsavedChanges(dirty: boolean): () => void {
  const id = useId(), register = useContext(DirtyContext);
  useEffect(() => { register(id, dirty); return () => register(id, false); }, [id, dirty, register]);
  return useCallback(() => register(id, false), [id, register]);
}
export function readPreference(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function writePreference(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Browser storage may be disabled. */ }
}
export function parseProjectRoute(value: string): { projectId: string; page?: ProjectPage; action?: string; focusId?: string; status?: string } | undefined {
  try {
    const url = new URL(value, window.location.origin);
    const match = url.pathname.match(/^\/projects\/([^/]+)(?:\/([^/]+))?\/?$/);
    if (!match) return undefined;
    const page = projectPages.find(p => p.id === match[2])?.id;
    if (match[2] && !page) return undefined;
    return { projectId: decodeURIComponent(match[1]), page, action: url.searchParams.get("action") ?? undefined, focusId: url.searchParams.get("focus") ?? undefined, status: url.searchParams.get("status") ?? undefined };
  } catch { return undefined; }
}
export function projectPath(id: string, page: ProjectPage, options?: { action?: string; focus?: string; status?: string }): string {
  const params = new URLSearchParams();
  if (options?.action) params.set("action", options.action);
  if (options?.focus) params.set("focus", options.focus);
  if (options?.status) params.set("status", options.status);
  return `/projects/${encodeURIComponent(id)}/${page}${params.size ? `?${params}` : ""}`;
}
export function useWorkspaceNavigation() {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);
  const current = useRef(path), index = useRef(0), undoing = useRef(false);
  const dirty = useRef(new Set<string>());
  const register = useCallback((id: string, changed: boolean) => { if (changed) dirty.current.add(id); else dirty.current.delete(id); }, []);
  const canLeave = useCallback(() => !dirty.current.size || window.confirm("有尚未保存的内容，确定放弃修改并离开吗？"), []);
  const navigate = useCallback((next: string, replace = false, force = false): boolean => {
    if (next === current.current) return true;
    if (!force && !canLeave()) return false;
    if (!replace) index.current += 1;
    window.history[replace ? "replaceState" : "pushState"]({ trashIndex: index.current }, "", next);
    current.current = next; setPath(next); return true;
  }, [canLeave]);
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, trashIndex: 0 }, "");
    const pop = (event: PopStateEvent) => {
      if (undoing.current) { undoing.current = false; return; }
      const target = typeof event.state?.trashIndex === "number" ? event.state.trashIndex : undefined;
      if (!canLeave()) {
        if (target !== undefined && target !== index.current) { undoing.current = true; window.history.go(index.current - target); }
        else window.history.replaceState({ trashIndex: index.current }, "", current.current);
        return;
      }
      index.current = target ?? 0;
      current.current = window.location.pathname + window.location.search; setPath(current.current);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.current.size) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("popstate", pop); window.addEventListener("beforeunload", beforeUnload);
    return () => { window.removeEventListener("popstate", pop); window.removeEventListener("beforeunload", beforeUnload); };
  }, [canLeave]);
  return { path, navigate, register, canLeave };
}
