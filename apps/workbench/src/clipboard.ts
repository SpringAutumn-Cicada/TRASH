// Invoke directly from a click handler so the synchronous fallback retains user activation.
export async function copyText(text: string): Promise<void> {
  const previous = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = document.createElement("textarea");
  field.value = text; field.readOnly = true; field.tabIndex = -1;
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:2147483647";
  // Keep the fallback inside an active dialog when the application background is inert.
  const parent = previous instanceof Element ? previous.closest('[role="dialog"]') : null;
  (parent ?? document.body).appendChild(field);
  let copied = false;
  try { field.focus({ preventScroll: true }); field.select(); copied = document.execCommand("copy"); }
  catch { /* Try the modern API below if the browser refuses the fallback. */ }
  finally {
    field.remove();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
  if (copied) return;
  if (!navigator.clipboard?.writeText) throw new Error("CLIPBOARD_UNAVAILABLE");
  await navigator.clipboard.writeText(text);
}
