import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
// A model provider as far as a connection test needs it: the list of models, behind
// a key in the header the provider names. It records what it was asked, so a test can
// see where the key went.
export interface FakeProvider {
  url: string;
  requests: { method: string; url: string; headers: IncomingHttpHeaders }[];
  // The status for every request, when not 200; a redirect needs `location`.
  behaviour: { status?: number; location?: string; delay?: number };
  close(): Promise<void>;
}
export async function startFakeProvider(validKey: string): Promise<FakeProvider> {
  const state: FakeProvider = {
    url: "",
    requests: [],
    behaviour: {},
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
  const server: Server = createServer((request, response) => {
    state.requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
    });
    const answer = () => {
      const given =
        request.headers["x-api-key"] ??
        request.headers["x-goog-api-key"] ??
        (request.headers.authorization ?? "").replace(/^Bearer /, "");
      const status = state.behaviour.status ?? (given === validKey ? 200 : 401);
      response.writeHead(status, {
        "content-type": "application/json",
        ...(state.behaviour.location ? { location: state.behaviour.location } : {}),
      });
      response.end(
        JSON.stringify(status === 200 ? { data: [{ id: "model-1" }] } : { error: "no" }),
      );
    };
    if (state.behaviour.delay) setTimeout(answer, state.behaviour.delay);
    else answer();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  state.url = `http://127.0.0.1:${String(address.port)}`;
  return state;
}
