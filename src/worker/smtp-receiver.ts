import { sqlClient } from "../server/db";
import { startReceiver } from "../server/inbound-smtp";
// The SMTP receiver as a process of its own, so that it is switched on and off on its own (the profile
// smtp-inbound of the production stack). It reads the inbound connections of kind smtp from the
// database on every recipient and does nothing else.
// An empty value is a value that is not set (Compose passes the name on empty).
const text = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};
const port = Number(process.env.SMTP_INBOUND_PORT ?? "2525");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("smtp_inbound_port");
const receiver = await startReceiver({
  port,
  host: process.env.SMTP_INBOUND_HOST ?? "0.0.0.0",
  name: text("SMTP_INBOUND_NAME"),
  tlsKeyFile: text("SMTP_INBOUND_TLS_KEY_FILE"),
  tlsCertFile: text("SMTP_INBOUND_TLS_CERT_FILE"),
});
console.log(JSON.stringify({ event: "smtp_in.ready", port: receiver.port }));
const stop = () => {
  void receiver.close().then(async () => {
    await sqlClient().end();
    process.exit(0);
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
