// The text of a file, as the product reads it for an agent. Nothing here runs a
// file: a document is read as data, in a process that cannot reach the network,
// write a file or see a secret.
export type Failure =
  // Not a format the product reads, or an old binary or password protected one.
  | "unsupported"
  // The structure is broken, or it holds what a document of that kind never holds.
  | "damaged"
  | "encrypted"
  // A limit was hit: more bytes, more parts or more time than the product spends.
  | "too_large"
  | "timeout"
  // The file has no text.
  | "empty"
  | "failed";
export type Unit = "pages" | "sheets" | "slides";
export type Extraction =
  | {
      ok: true;
      method: string;
      text: string;
      // How many pages, sheets or slides were read.
      units: number;
      unit: Unit;
      // The text was cut at the limit, or pages beyond the limit were not read.
      truncated: boolean;
      // Parts that a reader of the file does not see (hidden text, hidden sheets,
      // hidden slides, text outside the page) and that were left out.
      hidden: number;
    }
  | { ok: false; reason: Failure };
export const limits = {
  // What the ingest already accepts per file.
  inputBytes: 15 * 1024 * 1024,
  // Parts of a package, and the bytes they may unpack to together and singly.
  entries: 2000,
  unpackedBytes: 64 * 1024 * 1024,
  partBytes: 32 * 1024 * 1024,
  pages: 200,
  cells: 200_000,
  // The text that is kept per file; an agent reads less (256 KiB) of it.
  textBytes: 1024 * 1024,
  timeoutMs: 30_000,
  memoryMb: 384,
} as const;
