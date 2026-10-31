import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RefreshCw, TerminalSquare, Columns2, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

export interface TerminalSession { id: string; token: string; profile_id: string; name: string; host: string; port: number; username: string; ended?: boolean }
export function AutoDlTerminal({ projectId, session, onDisconnect, onEnded, onSplit, splitDisabled, number }: { projectId: string; session: TerminalSession; onDisconnect: () => void; onEnded: () => void; onSplit: () => void; splitDisabled: boolean; number: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState("正在打开终端…"), [error, setError] = useState(""), [attempt, setAttempt] = useState(0), [closed, setClosed] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const callbacks = useRef({ onDisconnect, onEnded, onSplit, splitDisabled }); callbacks.current = { onDisconnect, onEnded, onSplit, splitDisabled };
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/terminals/${session.id}`;
  const headers = { "x-terminal-token": session.token, "content-type": "application/json" };
  useEffect(() => () => { void fetch(base, { method: "DELETE", headers: { "x-terminal-token": session.token }, keepalive: true }).catch(() => {}); }, [projectId, session.id]);
  useEffect(() => {
    const controller = new AbortController(); let alive = true, connected = false;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace', scrollback: 5000, convertEol: false, theme: { background: "#ffffff", foreground: "#26352e", cursor: "#27764d", selectionBackground: "#a8cdb780", black: "#26352e", red: "#b34747", green: "#27764d", yellow: "#926c15", blue: "#366db0", magenta: "#89549d", cyan: "#277f8b", white: "#657570", brightBlack: "#77877e", brightRed: "#c34b4b", brightGreen: "#328254", brightYellow: "#9d761a", brightBlue: "#467dc0", brightMagenta: "#9964ad", brightCyan: "#378f9b", brightWhite: "#36453e" } });
    const fit = new FitAddon(); term.loadAddon(fit);
    term.open(container.current!);
    const element = container.current!;
    const updateTheme = () => {
      const style = getComputedStyle(element);
      term.options.theme = { ...term.options.theme, background: style.backgroundColor, foreground: style.color, cursor: getComputedStyle(document.documentElement).getPropertyValue("--green").trim() || "#27764d" };
    };
    updateTheme();
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    term.attachCustomKeyEventHandler(event => {
      if (event.code === "KeyD" && event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        if (event.type === "keydown" && !event.repeat && !callbacks.current.splitDisabled) callbacks.current.onSplit();
        return false;
      }
      return true;
    });
    const copySelection = (event: MouseEvent) => {
      const selection = term.getSelection();
      if (!selection) return;
      event.preventDefault(); event.stopPropagation();
      void (async () => {
        try { await navigator.clipboard.writeText(selection); if (alive) setCopyNotice("已复制选中文字"); }
        catch { if (alive) setCopyNotice("复制失败，请按 Ctrl+Shift+C 复制选区，或检查浏览器剪贴板权限。"); }
      })();
    };
    element.addEventListener("contextmenu", copySelection, true);
    let queue = Promise.resolve(); let queued = 0;
    const post = async (path: string, value: unknown) => {
      const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(value), signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 404 ? "终端会话已结束，请重新连接。" : "终端输入或尺寸更新失败，请检查连接。");
    };
    const input = term.onData(text => {
      if (!connected) return;
      if (queued + text.length > 65536) { setError("输入发送过快，请等待后再输入。"); return; }
      queued += text.length;
      queue = queue.then(async () => { if (controller.signal.aborted) return; for (let i = 0; i < text.length;) { if (!connected) return; let end = Math.min(i + 8192, text.length); const last = text.charCodeAt(end - 1); if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--; await post("/input", { text: text.slice(i, end) }); i = end; } }).catch(cause => { if (alive) { connected = false; setError(cause instanceof Error ? cause.message : "输入失败。"); term.options.disableStdin = true; } }).finally(() => { queued -= text.length; });
    });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resize = () => {
      if (!alive || !container.current?.clientWidth || !container.current.clientHeight) return;
      fit.fit(); clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (connected) void post("/resize", { cols: Math.min(500, Math.max(2, term.cols)), rows: Math.min(200, Math.max(1, term.rows)) }).catch(() => {}); }, 120);
    };
    const observer = new ResizeObserver(resize); observer.observe(container.current!); resize();
    const stream = async () => {
      setError(""); setClosed(false); setState("正在读取终端输出…"); term.options.disableStdin = true;
      try {
        const response = await fetch(base + "/events?after=0", { headers: { "x-terminal-token": session.token }, cache: "no-store", signal: controller.signal });
        if (!response.ok || !response.body) {
          if (response.status === 404) { callbacks.current.onEnded(); setClosed(true); }
          throw new Error("无法打开终端输出，若会话已过期请重新连接。");
        }
        connected = true; term.options.disableStdin = false; setState("SSH 已连接"); resize(); term.focus();
        const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "", remoteClosed = false;
        while (alive) {
          const chunk = await reader.read(); if (chunk.done) break; pending += decoder.decode(chunk.value, { stream: true });
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            for (const line of frame.split("\n")) if (line.startsWith("data: ")) {
              const event = JSON.parse(line.slice(6));
              if (event.type === "output") { const bytes = atob(event.data); term.write(Uint8Array.from(bytes, char => char.charCodeAt(0))); }
              else if (event.type === "notice") term.writeln(`\r\n[${event.message}]`);
              else if (event.type === "closed") { remoteClosed = true; connected = false; term.options.disableStdin = true; setClosed(true); setState(event.message); callbacks.current.onEnded(); }
            }
          }
        }
        if (alive && !remoteClosed) throw new Error("终端输出连接已中断。请在一分钟内恢复显示，或重新连接。");
      } catch (cause) { if (alive) { connected = false; term.options.disableStdin = true; setError(cause instanceof Error ? cause.message : "终端连接中断。"); setState("终端显示已中断"); } }
    };
    void stream();
    return () => { alive = false; controller.abort(); clearTimeout(resizeTimer); observer.disconnect(); themeObserver.disconnect(); element.removeEventListener("contextmenu", copySelection, true); input.dispose(); term.dispose(); };
  }, [projectId, session.id, attempt]);
  return <section className="autodl-terminal-panel" aria-label={`终端窗口 ${number}`}><header><div className="autodl-terminal-identity"><TerminalSquare size={17}/><strong>{session.name}</strong><span className="autodl-terminal-number">{String(number).padStart(2,"0")}</span></div><div className="autodl-terminal-actions"><button type="button" className="icon-button" title="新建分屏（Shift+Alt+D）" aria-label="新建终端分屏" disabled={splitDisabled} onClick={onSplit}><Columns2 size={15}/></button><button type="button" className="icon-button" title="恢复终端显示" aria-label="恢复终端显示" disabled={closed || session.ended} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15}/></button><button type="button" className="icon-button" title="关闭终端窗口" aria-label="关闭终端窗口" onClick={() => void fetch(base, { method: "DELETE", headers: { "x-terminal-token": session.token } }).then(response => { if (!response.ok && response.status !== 404) throw new Error(); callbacks.current.onDisconnect(); }).catch(() => setError("断开失败，请检查服务状态。"))}><X size={15}/></button></div></header><div className="autodl-terminal-connection"><span title={`${session.username}@${session.host}:${session.port}`}>{session.username}@{session.host}:{session.port}</span><span role="status" className="autodl-terminal-status">{state}</span></div>{error && <p role="alert" className="notice error-notice">{error}</p>}<div ref={container} className="autodl-terminal-screen"/><footer><span>独立 Shell · Ctrl+C 中断前台命令</span><span role="status">{copyNotice || "长任务请使用 tmux 或实验 Runner"}</span></footer></section>;
}
