import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
// A model provider as far as a run of a task needs it: the endpoint that answers a
// prompt, in the form of each of the three providers. It records what it was
// asked, so that a test can see the path, the key and the body.
export type Kind = "anthropic" | "openai" | "google";
export interface FakeModels {
  url: string;
  requests: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[];
  behaviour: {
    status?: number;
    delay?: number;
    text?: string;
    error?: Record<string, unknown>;
    headers?: Record<string, string>;
    // The model asks for a tool instead of answering in text.
    toolCall?: { name: string; input: Record<string, unknown> };
  };
  close(): Promise<void>;
}
const callAnswers: Record<
  Kind,
  (call: { name: string; input: Record<string, unknown> }) => unknown
> = {
  anthropic: (call) => ({
    id: "msg_2",
    type: "message",
    role: "assistant",
    model: "fake",
    content: [{ type: "tool_use", id: "toolu_1", name: call.name, input: call.input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 21, output_tokens: 9 },
  }),
  openai: (call) => ({
    id: "chatcmpl-2",
    object: "chat.completion",
    created: 1,
    model: "fake",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
  }),
  google: (call) => ({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: call.name, args: call.input } }],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 9, totalTokenCount: 30 },
  }),
};
const answers: Record<Kind, (text: string) => unknown> = {
  anthropic: (text) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "fake",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 7 },
  }),
  openai: (text) => ({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "fake",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }),
  google: (text) => ({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
  }),
};
export async function startFakeModels(kind: Kind): Promise<FakeModels> {
  const state: FakeModels = {
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
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      state.requests.push({ url: request.url ?? "", headers: request.headers, body });
      const answer = () => {
        const status = state.behaviour.status ?? 200;
        response.writeHead(status, {
          "content-type": "application/json",
          ...(status === 200 ? {} : state.behaviour.headers),
        });
        response.end(
          JSON.stringify(
            status === 200
              ? state.behaviour.toolCall
                ? callAnswers[kind](state.behaviour.toolCall)
                : answers[kind](state.behaviour.text ?? "A drafted answer")
              : { error: state.behaviour.error ?? { message: "refused" } },
          ),
        );
      };
      if (state.behaviour.delay) setTimeout(answer, state.behaviour.delay);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  state.url = `http://127.0.0.1:${String(address.port)}`;
  return state;
}
