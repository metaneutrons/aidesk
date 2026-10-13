import { createServer, type Server, type Socket } from "node:net";
// A minimal SMTP server for tests of the sending worker. It records what it
// received and can refuse a recipient, answer the message with a temporary
// error, or drop the connection while the message is in flight.
export interface FakeSmtp {
  port: number;
  connections: number;
  messages: string[];
  behaviour: {
    rcpt?: string;
    data?: string;
    dropAfterData?: boolean;
    dropAtConnect?: boolean;
    // Called once the message was received and before the server answers.
    onData?: () => Promise<void>;
  };
  close(): Promise<void>;
}
export async function startFakeSmtp(): Promise<FakeSmtp> {
  const state: FakeSmtp = {
    port: 0,
    connections: 0,
    messages: [],
    behaviour: {},
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    if (state.behaviour.dropAtConnect) {
      socket.destroy();
      return;
    }
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.write("220 fake ESMTP\r\n");
    let buffer = "";
    let message: string | null = null;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (message !== null) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          message = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          // A line that starts with a dot arrives with a second one (RFC 5321 4.5.2).
          const received = message.replace(/(^|\r\n)\.\./g, "$1.");
          message = null;
          state.messages.push(received);
          void (async () => {
            await state.behaviour.onData?.();
            if (state.behaviour.dropAfterData) socket.destroy();
            else socket.write(`${state.behaviour.data ?? "250 2.0.0 queued"}\r\n`);
          })();
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === "EHLO" || command === "HELO") socket.write("250 fake\r\n");
        else if (command === "RCPT") socket.write(`${state.behaviour.rcpt ?? "250 2.1.5 ok"}\r\n`);
        else if (command === "DATA") {
          socket.write("354 go ahead\r\n");
          message = "";
        } else if (command === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  state.port = typeof address === "object" && address ? address.port : 0;
  state.close = () =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        resolve();
      });
    });
  return state;
}
