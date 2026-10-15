import { eq } from "drizzle-orm";
import type { Tx } from "./changes";
import { db } from "./db";
import { workspaceSettings } from "./db/schema";
// The switches of the whole installation that only an owner sets (see `agent-controls`). They
// are read by the places that act: the queue of a run, the check before a run acts and the
// worker that sends. A missing row means that both are off.
let key = "controls";
export const controlsKey = (): string => key;
// For tests only: the test files run side by side against one database, and a switch of the
// whole workspace would stop the runs and the mail of the others. A file picks a row of its own.
export function useControlsKey(name: string): void {
  key = name;
}
export interface WorkspaceControls {
  stopAutonomous: boolean;
  pauseOutgoing: boolean;
}
export async function workspaceControls(
  reader: Pick<Tx, "select"> = db(),
): Promise<WorkspaceControls> {
  const [row] = await reader.select().from(workspaceSettings).where(eq(workspaceSettings.key, key));
  return {
    stopAutonomous: row?.value.stopAutonomous === true,
    pauseOutgoing: row?.value.pauseOutgoing === true,
  };
}
