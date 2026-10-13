import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
// What a JSON response carries for a database row: the schema follows the table
// definition, so a new column cannot go missing from the published API
// definition. Timestamps travel as ISO strings, JSON columns are opaque unless
// the caller names a more exact schema for them.
export const isoDate = z.iso.datetime();
export function rowSchema(
  table: PgTable,
  options: { omit?: string[]; shapes?: Record<string, z.ZodType> } = {},
) {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, column] of Object.entries(getTableColumns(table))) {
    if (options.omit?.includes(name)) continue;
    let type: z.ZodType;
    if (options.shapes?.[name]) type = options.shapes[name];
    else if (column.enumValues && column.enumValues.length > 0)
      type = z.enum(column.enumValues as [string, ...string[]]);
    else if (column.dataType === "string") type = z.string();
    else if (column.dataType === "number" || column.dataType === "bigint") type = z.number();
    else if (column.dataType === "boolean") type = z.boolean();
    else if (column.dataType === "date") type = isoDate;
    else if (column.dataType === "array") type = z.array(z.unknown());
    else type = z.unknown();
    shape[name] = column.notNull ? type : type.nullable();
  }
  return z.object(shape);
}
