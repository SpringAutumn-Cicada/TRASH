import React, { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import "./modal-layer.css";

let opened = 0;
let previousOverflow = "";
let previousInert = false;
function modalRoot(): HTMLElement {
  let root = document.getElementById("modal-root");
  if (!root) { root = document.createElement("div"); root.id = "modal-root"; document.body.appendChild(root); }
  return root;
}

// All application dialogs live outside the page stacking context, including nested pickers.
export function ModalLayer({ children }: { children: React.ReactNode }) {
  const target = modalRoot();
  useLayoutEffect(() => {
    const app = document.getElementById("root");
    if (opened++ === 0) {
      previousOverflow = document.body.style.overflow;
      previousInert = app?.inert ?? false;
      document.body.style.overflow = "hidden";
      if (app) app.inert = true;
    }
    return () => {
      if (--opened === 0) {
        document.body.style.overflow = previousOverflow;
        if (app) app.inert = previousInert;
      }
    };
  }, []);
  return createPortal(children, target);
}
