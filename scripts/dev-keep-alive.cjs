// Development stack only, loaded through NODE_OPTIONS. Node closes an idle
// connection of a server five seconds after its last answer, plus a buffer of one
// second. A client that sends on a pooled connection in that instant, as the request
// context of Playwright does, gets "socket hang up" (ECONNRESET). A timeout longer
// than any pause of a test (60 s) takes that race away. The header timeout stays
// above it, as Node advises.
const http = require("node:http");
const create = http.createServer;
http.createServer = function createServer(...args) {
  const server = create.apply(this, args);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 121_000;
  return server;
};
