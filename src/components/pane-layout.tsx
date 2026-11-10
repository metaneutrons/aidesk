"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import {
  applyPaneLayout,
  clampListWidth,
  conversationMinWidth,
  defaultPaneLayout,
  listWidthLimits,
  paneLayoutKey,
  parsePaneLayout,
  serializePaneLayout,
  type PaneLayout,
} from "../domain/pane-layout";
// The width of the ticket list and whether it is shown, kept in the browser (see domain/pane-layout.ts). The
// page opens with the stored layout through the script of the layout, so this hook only reads it again for the
// state of the controls and writes what the person changes.
export function usePaneLayout() {
  const [layout, setLayout] = useState<PaneLayout>(defaultPaneLayout);
  const current = useRef(layout);
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(paneLayoutKey);
    } catch {
      // Storage can be blocked; the layout then holds for this visit only.
    }
    const next = parsePaneLayout(stored);
    current.current = next;
    setLayout(next);
  }, []);
  const commit = useCallback((next: PaneLayout) => {
    current.current = next;
    setLayout(next);
    applyPaneLayout(document.documentElement, next);
    try {
      localStorage.setItem(paneLayoutKey, serializePaneLayout(next));
    } catch {
      // See above.
    }
  }, []);
  return {
    layout,
    setWidth: (width: number) => {
      commit({ ...current.current, listWidth: clampListWidth(width) });
    },
    resetWidth: () => {
      commit({ ...current.current, listWidth: defaultPaneLayout.listWidth });
    },
    toggle: () => {
      commit({ ...current.current, listCollapsed: !current.current.listCollapsed });
    },
  };
}
export function ListToggle({
  collapsed,
  label,
  controls,
  onToggle,
}: {
  collapsed: boolean;
  label: string;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-button list-toggle"
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
    </button>
  );
}
// The handle between the list and the conversation, a window splitter: dragged with a pointer, moved with the
// arrow keys (more with Shift), set to the smallest and the largest width with Home and End, hides the list
// with Enter and returns to the usual width on a double click. While it is dragged only the style changes,
// and the width is stored when the handle is let go, so the desk is not drawn again for every pixel.
export function PaneResizer({
  width,
  label,
  onResize,
  onReset,
  onCollapse,
}: {
  width: number;
  label: string;
  onResize: (width: number) => void;
  onReset: () => void;
  onCollapse: () => void;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; start: number; width: number; max: number } | null>(null);
  function available(): number {
    const container = handle.current?.parentElement?.clientWidth ?? Number.POSITIVE_INFINITY;
    return Math.max(
      listWidthLimits.min,
      Math.min(listWidthLimits.max, container - conversationMinWidth),
    );
  }
  function preview(next: number) {
    document.documentElement.style.setProperty("--list-width", `${String(next)}px`);
  }
  function end(event: PointerEvent<HTMLDivElement>, keep: boolean) {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    delete document.documentElement.dataset.resizing;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (keep) onResize(state.width);
    else preview(state.start);
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? listWidthLimits.bigStep : listWidthLimits.step;
    const next =
      event.key === "ArrowRight"
        ? width + step
        : event.key === "ArrowLeft"
          ? width - step
          : event.key === "Home"
            ? listWidthLimits.min
            : event.key === "End"
              ? available()
              : null;
    if (next !== null) {
      event.preventDefault();
      onResize(Math.min(next, available()));
    } else if (event.key === "Enter") {
      event.preventDefault();
      onCollapse();
    }
  }
  return (
    <div
      ref={handle}
      className="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={listWidthLimits.min}
      aria-valuemax={listWidthLimits.max}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={key}
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, start: width, width, max: available() };
        document.documentElement.dataset.resizing = "true";
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state) return;
        state.width = Math.min(clampListWidth(state.start + event.clientX - state.x), state.max);
        preview(state.width);
      }}
      onPointerUp={(event) => {
        end(event, true);
      }}
      onPointerCancel={(event) => {
        end(event, false);
      }}
    />
  );
}
// The arrow keys, Home and End move the focus between the rows of a list, which are buttons, so a long list
// does not take a tab for every ticket. Enter and Space open the ticket as they do on any button.
export function moveRowFocus(event: KeyboardEvent<HTMLElement>): void {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("ticket-row")) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".ticket-row"));
  const index = rows.indexOf(target);
  const next =
    event.key === "ArrowDown"
      ? index + 1
      : event.key === "ArrowUp"
        ? index - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : null;
  if (next === null || index < 0) return;
  event.preventDefault();
  const row = rows[Math.min(rows.length - 1, Math.max(0, next))];
  row?.focus();
  row?.scrollIntoView({ block: "nearest" });
}
