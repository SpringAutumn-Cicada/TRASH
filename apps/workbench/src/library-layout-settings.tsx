import React, { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { api, uiError } from './api.js';
import { ErrorNotice } from './error-notice.js';

type LayoutState = {
  state: 'ready' | 'moving' | 'completed' | 'rolling-back' | 'rolled-back';
  migrated: boolean;
  pending?: boolean;
  id?: string;
  fingerprint?: string;
  folders: { from: string; to: string; present: boolean; files: number; bytes: number }[];
  conflicts: string[];
  rewritten: { from: string; to: string }[];
};

export function LibraryLayoutSettings({ projectId, migrated, pending, disabled, onBrowse }: {
  projectId: string;
  migrated: boolean;
  pending: boolean;
  disabled: boolean;
  onBrowse: () => void;
}) {
  const endpoint = `/projects/${encodeURIComponent(projectId)}/workspace/library`;
  const [result, setResult] = useState<LayoutState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<'move' | 'rollback'>();
  const current = result?.migrated ?? migrated;
  const interrupted = result?.pending ?? pending;
  const busyLabel = confirmation ? '正在处理…' : '正在读取…';

  const load = async (action?: 'move' | 'rollback') => {
    setBusy(true);
    setError('');
    try {
      const next = await api<LayoutState>(endpoint + (action === 'rollback' ? '/rollback' : ''), action ? {
        method: 'POST',
        body: JSON.stringify({ confirm: true, fingerprint: action === 'move' ? result?.fingerprint : undefined }),
      } : undefined);
      setResult(next);
    } catch (cause) {
      setError(uiError(cause, '资料库目录操作失败，请重新查看迁移状态。'));
      setResult(undefined);
    } finally {
      setBusy(false);
      setConfirmation(undefined);
    }
  };

  return <section className="project-settings-section library-layout-settings">
    <h3>文献资料库</h3>
    <p role="status">{interrupted ? '目录迁移尚未结束，请继续上次操作。' : current
      ? <>原文、摘要和知识库已集中在 <code>library/</code>。</>
      : <>当前仍使用旧目录。可预览将它们移动到 <code>library/</code> 的变更。</>}</p>
    {result?.folders.length ? <ul className="library-layout-folders">{result.folders.map(folder => <li key={folder.from}>
      <code>{folder.to}/</code>
      <small>{folder.files} 个文件 · {(folder.bytes / 1048576).toFixed(1)} MiB</small>
    </li>)}</ul> : null}
    {result?.rewritten.length ? <details><summary>受影响的 Markdown 链接（{result.rewritten.length} 个文件）</summary>
      <ul className="library-layout-links">{result.rewritten.map(item => <li key={item.to}><code>{item.to}</code></li>)}</ul>
    </details> : null}
    {!!result?.conflicts.length && <ErrorNotice>请先处理冲突目录：{result.conflicts.join('、')}。</ErrorNotice>}
    {error && <ErrorNotice>{error}</ErrorNotice>}
    {confirmation && <p>{confirmation === 'move' ? '移动项目内的文献目录并校验文件。' : '恢复迁移前的目录和链接。迁移后有文件被修改或新增时，系统会保留当前目录。'}</p>}
    <div className="library-layout-actions">
      {current && !interrupted && !confirmation && <button type="button" className="secondary-button" disabled={disabled || busy} onClick={onBrowse}><FolderOpen size={15}/>打开资料库</button>}
      {!confirmation && <button type="button" className="secondary-button" disabled={disabled || busy} onClick={() => void load()}>{busy ? busyLabel : current || interrupted ? '查看迁移状态' : '预览迁移'}</button>}
      {!confirmation && result?.state === 'ready' && !result.conflicts.length && <button type="button" className="primary-button" disabled={disabled || busy} onClick={() => setConfirmation('move')}>迁移文献目录</button>}
      {!confirmation && result && (interrupted || result.state === 'moving' || result.state === 'rolling-back') &&
        <button type="button" className="primary-button" disabled={disabled || busy} onClick={() => void load(result.state === 'rolling-back' ? 'rollback' : 'move')}>继续上次操作</button>}
      {!confirmation && result?.state === 'completed' && result.id && !interrupted && <button type="button" className="secondary-button" disabled={disabled || busy} onClick={() => setConfirmation('rollback')}>恢复旧目录</button>}
      {confirmation && <>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmation(undefined)}>取消</button>
        <button type="button" className="primary-button" disabled={disabled || busy} onClick={() => void load(confirmation)}>{busy ? busyLabel : confirmation === 'move' ? '确认迁移' : '确认恢复'}</button>
      </>}
    </div>
  </section>;
}
