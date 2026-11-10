// The layout of the panes of the desk that a person adjusts: the width of the ticket list and whether it is
// shown. It is kept in the browser, because a width that fits one screen does not fit another, and not in the
// profile, which would carry the width of a large monitor to a laptop. The key is the same for every person of
// a browser, like the theme.
export const paneLayoutKey = "aidesk:layout";
export const listWidthLimits = {
  min: 260,
  max: 560,
  fallback: 350,
  step: 16,
  bigStep: 64,
} as const;
// The conversation keeps at least this much room, whatever the stored width is (the style of the list
// enforces it too, so a narrow window needs no script).
export const conversationMinWidth = 400;
export interface PaneLayout {
  listWidth: number;
  listCollapsed: boolean;
}
export const defaultPaneLayout: PaneLayout = {
  listWidth: listWidthLimits.fallback,
  listCollapsed: false,
};
export function clampListWidth(value: number): number {
  if (!Number.isFinite(value)) return listWidthLimits.fallback;
  return Math.min(listWidthLimits.max, Math.max(listWidthLimits.min, Math.round(value)));
}
// What the browser stored; anything that is not of the expected form is ignored, field by field.
export function parsePaneLayout(raw: string | null): PaneLayout {
  if (!raw) return defaultPaneLayout;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return defaultPaneLayout;
  }
  if (typeof value !== "object" || value === null) return defaultPaneLayout;
  const { listWidth, listCollapsed } = value as Record<string, unknown>;
  return {
    listWidth:
      typeof listWidth === "number" &&
      listWidth >= listWidthLimits.min &&
      listWidth <= listWidthLimits.max
        ? Math.round(listWidth)
        : defaultPaneLayout.listWidth,
    listCollapsed: listCollapsed === true,
  };
}
export function serializePaneLayout(layout: PaneLayout): string {
  return JSON.stringify({ listWidth: layout.listWidth, listCollapsed: layout.listCollapsed });
}
// Sets the properties of the document that the style reads: the width as a custom property, the hidden list
// as an attribute.
export function applyPaneLayout(root: HTMLElement, layout: PaneLayout): void {
  root.style.setProperty("--list-width", `${String(layout.listWidth)}px`);
  if (layout.listCollapsed) root.dataset.list = "collapsed";
  else delete root.dataset.list;
}
// Runs before the first paint, like the script of the theme, so the page opens with the stored layout and does
// not jump after it was drawn. It repeats the checks of parsePaneLayout with the same limits.
export const paneLayoutScript = `try{var l=JSON.parse(localStorage.getItem(${JSON.stringify(paneLayoutKey)})||"null");if(l&&typeof l==="object"){var r=document.documentElement;if(typeof l.listWidth==="number"&&l.listWidth>=${String(listWidthLimits.min)}&&l.listWidth<=${String(listWidthLimits.max)})r.style.setProperty("--list-width",Math.round(l.listWidth)+"px");if(l.listCollapsed===true)r.dataset.list="collapsed"}}catch(e){}`;
