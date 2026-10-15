import { db } from "./db";
import { attachments, ingress, messages } from "./db/schema";
import { deleteObjects, listObjects } from "./storage";
// Objects are named by what they hold (`inbound/<project>/<checksum>.eml`,
// `attachments/<project>/<checksum>`), so one object can be the file of several
// attachments or the original of several messages, and the rows of a ticket that is
// deleted take their references with them (a cascade) but not the objects. The rule:
// an object is kept as long as any row names it, and an object that no row names is
// removed by this sweep, never by the code that deletes a ticket, which cannot know
// whether another ticket still uses it.
export interface Sweep {
  scanned: number;
  referenced: number;
  // Not named by any row and old enough to be sure that no write is still in flight:
  // an object is stored before the row that names it.
  unreferenced: { key: string; size: number }[];
  tooYoung: number;
  deleted: number;
  failed: string[];
}
export async function sweepObjects(
  options: {
    remove?: boolean;
    graceMs?: number;
    prefix?: string;
    // Objects in a request to the storage; for a test that needs more than one page.
    pageSize?: number;
    now?: Date;
  } = {},
): Promise<Sweep> {
  const grace = options.graceMs ?? 24 * 3600 * 1000;
  const now = (options.now ?? new Date()).getTime();
  const named = new Set<string>();
  for (const rows of [
    await db().select({ key: attachments.objectKey }).from(attachments),
    await db().select({ key: messages.rawObjectKey }).from(messages),
    await db().select({ key: ingress.rawObjectKey }).from(ingress),
  ])
    for (const { key } of rows) if (key) named.add(key);
  const result: Sweep = {
    scanned: 0,
    referenced: 0,
    unreferenced: [],
    tooYoung: 0,
    deleted: 0,
    failed: [],
  };
  for await (const object of listObjects(options.prefix, options.pageSize)) {
    result.scanned += 1;
    if (named.has(object.key)) result.referenced += 1;
    else if (now - object.lastModified.getTime() < grace) result.tooYoung += 1;
    else result.unreferenced.push({ key: object.key, size: object.size });
  }
  if (options.remove && result.unreferenced.length > 0) {
    result.failed = await deleteObjects(result.unreferenced.map((object) => object.key));
    result.deleted = result.unreferenced.length - result.failed.length;
  }
  return result;
}
