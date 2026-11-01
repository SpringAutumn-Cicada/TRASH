import { ErrorNotice } from "./error-notice.js";
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

  useEffect(() => {
    const controller = new AbortController(); let alive = true, connected = false;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace', scrollback: 5000, convertEol: false, theme: { background: "#10151d", foreground: "#d7e0eb", cursor: "#8bd5b0", selectionBackground: "#365678", black: "#253141", red: "#ed8796", green: "#a6da95", yellow: "#eed49f", blue: "#8aadf4", magenta: "#c6a0f6", cyan: "#8bd5ca", white: "#cad3f5", brightBlack: "#6e7e96", brightRed: "#f5a0ad", brightGreen: "#b8e5a9", brightYellow: "#f4deb3", brightBlue: "#a4bef8", brightMagenta: "#d5b7fa", brightCyan: "#a6e3db", brightWhite: "#f2f5fa" } });
    const fit = new FitAddon(); term.loadAddon(fit);
    term.open(container.current!);
    const element = container.current!;
    term.attachCustomKeyEventHandler(event => {
      if (event.code === "KeyD" && event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        if (event.type === "keydown" && !event.repeat && !callbacks.current.splitDisabled) callbacks.current.onSplit();
        return false;
      }
      return true;
    });
    const legacyCopy = (text: string) => {
      const previousFocus = document.activeElement;
      const field = document.createElement("textarea");
      field.value = text; field.readOnly = true;
      field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:2147483647";
      document.body.appendChild(field);
      try { field.focus(); field.select(); return document.execCommand("copy"); }
      catch { return false; }
      finally { field.remove(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); }
    };
    const copySelection = (event: MouseEvent) => {
      const selection = term.getSelection();
      if (!selection) return;
      event.preventDefault(); event.stopPropagation();
      // The synchronous fallback retains the right-click user gesture and works on HTTP LAN origins.
      if (legacyCopy(selection)) { setCopyNotice("已复制选中文字"); return; }
      void (async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(selection);
          if (alive) setCopyNotice("已复制选中文字");
        } catch { if (alive) setCopyNotice("浏览器阻止复制：请在选中文字后按 Ctrl+Shift+C，或通过 localhost / HTTPS 访问。"); }
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
    let resizeFrame: number | undefined;
    const resize = () => {
      if (!alive) return;
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        if (!alive || !element.clientWidth || !element.clientHeight) return;
        // Fit against the padding-free content box after the split layout has settled.
        fit.fit(); clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (connected) void post("/resize", { cols: Math.min(500, Math.max(2, term.cols)), rows: Math.min(200, Math.max(1, term.rows)) }).catch(() => {}); }, 120);
      });
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    void document.fonts.ready.then(() => { if (alive) resize(); });
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
        if (alive && !remoteClosed) throw new Error("终端输出连接已中断。请点击恢复终端显示；SSH 会话会在服务端保持。");
      } catch (cause) { if (alive) { connected = false; term.options.disableStdin = true; setError(cause instanceof Error ? cause.message : "终端连接中断。"); setState("终端显示已中断"); } }
    };
    void stream();
    return () => { alive = false; controller.abort(); clearTimeout(resizeTimer); if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame); observer.disconnect(); element.removeEventListener("contextmenu", copySelection, true); input.dispose(); term.dispose(); };
  }, [projectId, session.id, attempt]);
  return <section className="autodl-terminal-panel" aria-label={`终端窗口 ${number}`}><header><div className="autodl-terminal-identity"><TerminalSquare size={17}/><strong>Shell {number}</strong><span className="autodl-terminal-number">{String(number).padStart(2,"0")}</span></div><div className="autodl-terminal-actions"><button type="button" className="icon-button" title="新建分屏（Shift+Alt+D）" aria-label="新建终端分屏" disabled={splitDisabled} onClick={onSplit}><Columns2 size={15}/></button><button type="button" className="icon-button" title="恢复终端显示" aria-label="恢复终端显示" disabled={closed || session.ended} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15}/></button><button type="button" className="icon-button" title="关闭终端窗口" aria-label="关闭终端窗口" onClick={() => void fetch(base, { method: "DELETE", headers: { "x-terminal-token": session.token } }).then(response => { if (!response.ok && response.status !== 404) throw new Error(); callbacks.current.onDisconnect(); }).catch(() => setError("断开失败，请检查服务状态。"))}><X size={15}/></button></div></header><div className="autodl-terminal-connection"><span title={`${session.username}@${session.host}:${session.port}`}>{session.username}@{session.host}:{session.port}</span><span role="status" className="autodl-terminal-status">{state}</span></div>{error && <ErrorNotice  className="notice error-notice">{error}</ErrorNotice>}<div className="autodl-terminal-screen"><div ref={container} className="autodl-terminal-mount"/></div><footer><span>共享 SSH 连接 · 独立 Shell</span><span role="status">{copyNotice || "长任务请使用 tmux 或实验 Runner"}</span></footer></section>;
}
