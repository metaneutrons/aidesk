import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  clampListWidth,
  defaultPaneLayout,
  listWidthLimits,
  paneLayoutKey,
  paneLayoutScript,
  parsePaneLayout,
  serializePaneLayout,
} from "../src/domain/pane-layout";
describe("layout of the panes", () => {
  it("keeps the width of the list between its limits", () => {
    expect(clampListWidth(100)).toBe(listWidthLimits.min);
    expect(clampListWidth(9999)).toBe(listWidthLimits.max);
    expect(clampListWidth(333.6)).toBe(334);
    expect(clampListWidth(Number.NaN)).toBe(listWidthLimits.fallback);
  });
  it("reads what the browser stored, field by field", () => {
    expect(parsePaneLayout(null)).toEqual(defaultPaneLayout);
    expect(parsePaneLayout("not json")).toEqual(defaultPaneLayout);
    expect(parsePaneLayout("42")).toEqual(defaultPaneLayout);
    expect(parsePaneLayout('{"listWidth":420,"listCollapsed":true}')).toEqual({
      listWidth: 420,
      listCollapsed: true,
    });
    // A width outside the limits or of another type and a hidden list that is not `true` are ignored.
    expect(parsePaneLayout('{"listWidth":50,"listCollapsed":"yes"}')).toEqual(defaultPaneLayout);
    expect(parsePaneLayout('{"listWidth":"420"}')).toEqual(defaultPaneLayout);
    expect(parsePaneLayout('{"listWidth":420.4}').listWidth).toBe(420);
  });
  it("writes a layout that reads back the same", () => {
    const layout = { listWidth: 512, listCollapsed: true };
    expect(parsePaneLayout(serializePaneLayout(layout))).toEqual(layout);
  });
  it("applies the stored layout before the first paint, with the same checks as the parser", () => {
    const run = (stored: string | null) => {
      const style = new Map<string, string>();
      const dataset: Record<string, string> = {};
      const root = {
        style: { setProperty: (name: string, value: string) => style.set(name, value) },
        dataset,
      };
      const storage = { getItem: (key: string) => (key === paneLayoutKey ? stored : null) };
      runInNewContext(paneLayoutScript, {
        localStorage: storage,
        document: { documentElement: root },
      });
      return { width: style.get("--list-width"), list: dataset.list };
    };
    expect(run('{"listWidth":480,"listCollapsed":true}')).toEqual({
      width: "480px",
      list: "collapsed",
    });
    expect(run('{"listWidth":480}')).toEqual({ width: "480px", list: undefined });
    expect(run('{"listWidth":50,"listCollapsed":"yes"}')).toEqual({
      width: undefined,
      list: undefined,
    });
    expect(run("not json")).toEqual({ width: undefined, list: undefined });
    expect(run(null)).toEqual({ width: undefined, list: undefined });
  });
});
