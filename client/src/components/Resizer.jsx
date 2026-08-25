import { useEffect, useRef } from "react";

/**
 * Draggable resizer bar between two flex panels.
 * @param {"left"|"right"} side - which panel to resize
 * @param {number} min - min width px
 * @param {number} max - max width px
 * @param {string} cssVar - CSS variable to update (e.g. "--sidebar-w")
 * @param {string} rootSelector - parent element to set CSS var on
 */
export default function Resizer({ side = "left", min = 140, max = 600, cssVar, rootSelector = ".app", className = "" }) {
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = (e) => {
    e.preventDefault();
    startX.current = e.clientX;
    const root = document.querySelector(rootSelector);
    const panel = side === "left" ? root?.previousElementSibling || root?.parentElement?.querySelector(".sidebar") : root?.nextElementSibling;
    // get current width from computed style
    const computed = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    startW.current = parseInt(computed) || 220;

    document.body.classList.add("resizing");

    const onMouseMove = (ev) => {
      const delta = ev.clientX - startX.current;
      const newW = Math.min(max, Math.max(min, startW.current + (side === "left" ? delta : -delta)));
      document.documentElement.style.setProperty(cssVar, newW + "px");
    };

    const onMouseUp = () => {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  return <div className={`resizer ${className}`.trim()} onMouseDown={onMouseDown} />;
}
