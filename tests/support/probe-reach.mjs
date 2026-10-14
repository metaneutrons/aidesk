// What a process started under the permission model can do. It reports; the
// test decides. No input is read.
import { spawn } from "node:child_process";
import net from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
const result = { env: Object.keys(process.env).sort() };
const attempt = async (name, run) => {
  try {
    await run();
    result[name] = "allowed";
  } catch (error) {
    result[name] = error?.code ?? error?.cause?.code ?? error?.name ?? "failed";
  }
};
await attempt("write", () =>
  writeFileSync(`${process.env.PROBE_DIR ?? "/tmp"}/aidesk-probe.txt`, "x"),
);
await attempt("read", () => readFileSync("/etc/hosts"));
await attempt(
  "network",
  () =>
    new Promise((resolve, reject) => {
      // A raw socket: fetch refuses some ports on its own and would tell nothing.
      const socket = net.connect(9, "127.0.0.1");
      socket.on("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", reject);
    }),
);
await attempt("spawn", () => {
  spawn("true");
});
process.stdout.write(JSON.stringify(result));
