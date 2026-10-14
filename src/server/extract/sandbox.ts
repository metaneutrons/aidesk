import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { z } from "zod";
import { limits, type Extraction } from "./types";
// Reading a file with a parser is the riskiest thing the product does with what a
// sender wrote: pdf.js has had flaws that ran a script of the file. So it runs in
// a process of its own that has no network, may not write, start a process or
// start a worker, may read only its own program file, sees no environment and
// gets a ceiling for memory and time. Whatever the file achieves in there, it
// finds no secret and no way out.
const extraction = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    method: z.string().max(40),
    text: z.string().max(limits.textBytes + 1024),
    units: z.number().int().min(0),
    unit: z.enum(["pages", "sheets", "slides"]),
    truncated: z.boolean(),
    hidden: z.number().int().min(0),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      "unsupported",
      "damaged",
      "encrypted",
      "too_large",
      "timeout",
      "empty",
      "failed",
    ]),
  }),
]);
const sources = ["types.ts", "ooxml.ts", "pdf.ts", "core.ts", "child.ts"];
const here = () => path.join(process.cwd(), "src/server/extract");
// The program of the process: the reader and its libraries in one file, built
// once for a version of the sources, so that the process needs to read nothing
// else.
export async function reader(base = tmpdir()): Promise<string> {
  const folder = here();
  const hash = createHash("sha256");
  for (const name of sources) hash.update(readFileSync(path.join(folder, name)));
  for (const name of ["pdfjs-dist", "fflate", "esbuild"])
    hash.update(readFileSync(path.join(process.cwd(), "node_modules", name, "package.json")));
  const directory = path.join(base, `aidesk-extract-${hash.digest("hex").slice(0, 24)}`);
  const file = path.join(directory, "reader.mjs");
  if (existsSync(file)) return file;
  mkdirSync(directory, { recursive: true });
  const partial = path.join(directory, `reader-${String(process.pid)}.tmp`);
  await build({
    entryPoints: [path.join(folder, "child.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    outfile: partial,
    legalComments: "none",
    logLevel: "silent",
    // pdf.js tries a native canvas for drawing and works without it.
    external: ["@napi-rs/canvas"],
  });
  renameSync(partial, file);
  return file;
}
export interface Run {
  timeoutMs?: number;
  // The ceiling of the heap; the memory of the whole process may be twice that
  // plus a margin. The flag of the heap does not count buffers and typed arrays,
  // so the process is also watched from outside.
  memoryMb?: number;
  // The program that runs the file; only tests name another.
  executable?: string;
}
// The resident memory of a process in MiB, or null when it cannot be told.
export function residentMb(pid: number, procRoot = "/proc"): number | null {
  try {
    const pages = Number(readFileSync(`${procRoot}/${String(pid)}/statm`, "utf8").split(" ")[1]);
    return (pages * 4096) / (1024 * 1024);
  } catch {
    try {
      const kib = Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }),
      );
      return Number.isFinite(kib) ? kib / 1024 : null;
    } catch {
      return null;
    }
  }
}
const failed = (reason: "timeout" | "too_large" | "failed"): Extraction => ({ ok: false, reason });
// Runs a program file in the closed process with the bytes on its standard input
// and reads its answer.
export function runIsolated(program: string, input: Uint8Array, run: Run = {}): Promise<unknown> {
  return new Promise((resolve) => {
    // No memory image is written when the process aborts, since it would hold the
    // content of the file; `exec` leaves the process with the program as its pid.
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'ulimit -c 0; exec "$0" "$@"',
        run.executable ?? process.execPath,
        "--permission",
        `--allow-fs-read=${program}`,
        `--max-old-space-size=${String(run.memoryMb ?? limits.memoryMb)}`,
        program,
      ],
      {
        // The environment holds one harmless variable; secrets of the worker are not passed on.
        env: { NODE_ENV: "production" },
        cwd: tmpdir(),
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const output: Buffer[] = [];
    let size = 0;
    let verdict: "timeout" | "too_large" | null = null;
    const stop = (why: "timeout" | "too_large") => {
      verdict ??= why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      stop("timeout");
    }, run.timeoutMs ?? limits.timeoutMs);
    const ceiling = (run.memoryMb ?? limits.memoryMb) * 2 + 128;
    const watch = setInterval(() => {
      const used = child.pid === undefined ? null : residentMb(child.pid);
      if (used !== null && used > ceiling) stop("too_large");
    }, 50);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * limits.textBytes) stop("too_large");
      else output.push(chunk);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", () => {
      clearTimeout(timer);
      clearInterval(watch);
      resolve(failed("failed"));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(watch);
      // An abort is what a process that runs out of memory does.
      if (verdict) resolve(failed(verdict));
      else if (signal === "SIGABRT" || code === 134) resolve(failed("too_large"));
      else if (code !== 0) resolve(failed("failed"));
      else {
        try {
          resolve(JSON.parse(Buffer.concat(output).toString("utf8")));
        } catch {
          resolve(failed("failed"));
        }
      }
    });
    child.stdin.end(input);
  });
}
// What the process answered is believed only when it has the shape of a result.
export function checked(answer: unknown): Extraction {
  const parsed = extraction.safeParse(answer);
  return parsed.success ? parsed.data : failed("failed");
}
export async function extractSandboxed(input: Uint8Array, run: Run = {}): Promise<Extraction> {
  return checked(await runIsolated(await reader(), input, run));
}
