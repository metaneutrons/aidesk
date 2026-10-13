// The ticket list is loaded in steps and never beyond a ceiling; the overview
// counts everything regardless.
export const listStep = 250;
export const listCeiling = 2000;
// A requested size is a whole number between one and the ceiling; anything else
// falls back to the first step.
export function clampLimit(value: number): number {
  const rows = Number.isFinite(value) ? Math.trunc(value) : listStep;
  return Math.min(Math.max(rows, 1), listCeiling);
}
