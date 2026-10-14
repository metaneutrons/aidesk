import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { checked, extractSandboxed, runIsolated } from "../src/server/extract/sandbox";
import { extractBytes } from "../src/server/extract/core";
import { docx, pdf } from "./support/documents";
const program = (name: string) => path.join(process.cwd(), "tests/support", name);
const nothing = new Uint8Array(0);
describe("the process that reads a file", () => {
  it("may not write, read other files, reach the network or start a process, and sees no secret", async () => {
    process.env.DATABASE_URL ??= "postgres://secret@example.test/db";
    const result = (await runIsolated(program("probe-reach.mjs"), nothing)) as {
      env: string[];
    } & Record<string, unknown>;
    const { env, ...reach } = result;
    expect(reach).toEqual({
      write: "ERR_ACCESS_DENIED",
      read: "ERR_ACCESS_DENIED",
      network: "ERR_ACCESS_DENIED",
      spawn: "ERR_ACCESS_DENIED",
    });
    // The shell that starts the process may add a variable of its own; none of ours gets through.
    expect(env).toContain("NODE_ENV");
    expect(env).not.toContain("DATABASE_URL");
    expect(env.every((name) => ["NODE_ENV", "PWD", "OLDPWD", "SHLVL", "_"].includes(name))).toBe(
      true,
    );
  });
  it("is a probe that can tell: the same program without the closed process reaches everything", async () => {
    // A plain process with the environment of this one shows what the closed one is spared.
    const output = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [program("probe-reach.mjs")], {
        env: { ...process.env, PROBE_DIR: process.env.TMPDIR ?? "/tmp" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      child.on("close", () => {
        resolve(text);
      });
    });
    const open = JSON.parse(output) as Record<string, unknown>;
    expect(open.write).toBe("allowed");
    expect(open.read).toBe("allowed");
    expect(open.spawn).toBe("allowed");
    expect(open.network).not.toBe("ERR_ACCESS_DENIED");
    expect(open.env).toContain("DATABASE_URL");
  });
  it("is not allowed to leave a memory image, which would hold the content of the file", async () => {
    const answer = await runIsolated(program("print-core-limit.sh"), nothing, {
      executable: program("print-core-limit.sh"),
    });
    expect(answer).toEqual({ core: "0" });
  });
  it("is stopped when it runs too long, uses too much memory or answers too much", async () => {
    expect(await runIsolated(program("probe-spin.mjs"), nothing, { timeoutMs: 700 })).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(await runIsolated(program("probe-eat.mjs"), nothing, { memoryMb: 64 })).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(await runIsolated(program("probe-flood.mjs"), nothing)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
  it("is not believed when it answers with something that is not a result", async () => {
    // Through the reader of results: a wrong shape is a failure and never a text.
    expect(await runIsolated(program("probe-garbage.mjs"), nothing)).toEqual({ ok: "maybe" });
    expect(checked(await runIsolated(program("probe-garbage.mjs"), nothing))).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});
describe("reading files through the closed process", () => {
  it("gives the same text as reading in this process, for a Word file and a PDF file", async () => {
    for (const bytes of [
      docx(["Through the closed process, with ümlauts"]),
      pdf([[{ text: "A page read in isolation" }]]),
    ]) {
      const inside = await extractSandboxed(bytes);
      expect(inside.ok).toBe(true);
      expect(inside).toEqual(await extractBytes(bytes));
    }
  }, 60_000);
  it("answers with the reason for a file it cannot read", async () => {
    expect(await extractSandboxed(Buffer.from("not a document"))).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(await extractSandboxed(pdf([[{ text: "x" }]], { password: "hunter2" }))).toEqual({
      ok: false,
      reason: "encrypted",
    });
  }, 60_000);
  it("holds a package that lies about its size to the ceiling for memory", async () => {
    // 600 MiB of zeros, packed small, whose headers say it is 1 KiB.
    const packed = zipSync(
      { "word/document.xml": new Uint8Array(600 * 1024 * 1024) },
      { level: 1 },
    );
    const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    for (let index = 0; index + 4 <= packed.length; index += 1) {
      const signature = view.getUint32(index, true);
      // The local header holds the unpacked size at 22, the central directory at 24.
      if (signature === 0x04034b50) view.setUint32(index + 22, 1024, true);
      if (signature === 0x02014b50) view.setUint32(index + 24, 1024, true);
    }
    const answer = await extractSandboxed(packed, { memoryMb: 128 });
    expect(answer.ok).toBe(false);
  }, 120_000);
});
