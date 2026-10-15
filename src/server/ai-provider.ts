import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { ZodType } from "zod";
// The one place that talks to a model provider. A call is one request: it is not
// repeated by the SDK (`maxRetries: 0`), because a request whose outcome is unknown
// may have been accepted, and it ends at a time limit.
// A file in the request: an image or a PDF as bytes, never as an address the SDK or
// the provider would fetch.
export interface CallFile {
  mediaType: string;
  data: Uint8Array;
}
// A tool that the model may call. The product executes it, never the SDK: a tool has no
// `execute`, so a call comes back as data and every side effect passes the checks of the
// product first.
export interface CallTool {
  description: string;
  schema: ZodType;
}
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface Call {
  kind: "anthropic" | "openai" | "google";
  // The base address of a connection that names its own, without the version path.
  endpoint: string | undefined;
  apiKey: string;
  // Only for Anthropic: the workspace of a key that is not tied to one.
  workspaceId?: string | undefined;
  model: string;
  system: string;
  prompt: string;
  files?: CallFile[] | undefined;
  // The conversation so far, with the calls of tools and what they gave back, that
  // follows the prompt (which is the first message of the person).
  messages?: ModelMessage[] | undefined;
  tools?: Record<string, CallTool> | undefined;
  maxOutputTokens: number;
  timeoutMs: number;
}
export interface Answer {
  text: string;
  finishReason: string;
  // What the model asked to be called; missing means none.
  toolCalls?: ToolCall[] | undefined;
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
}
export type Generate = (call: Call) => Promise<Answer>;
// The version path that the paths of a provider live under, which the base address of
// a connection leaves out.
const versionPath = { anthropic: "/v1", openai: "/v1", google: "/v1beta" } as const;
function modelOf(call: Call): LanguageModel {
  const baseURL =
    call.endpoint === undefined
      ? {}
      : { baseURL: `${call.endpoint.replace(/\/+$/, "")}${versionPath[call.kind]}` };
  const settings = { apiKey: call.apiKey, ...baseURL };
  if (call.kind === "anthropic")
    return createAnthropic({
      ...settings,
      ...(call.workspaceId ? { headers: { "anthropic-workspace-id": call.workspaceId } } : {}),
    })(call.model);
  // Chat completions, which the gateways that offer a compatible address speak.
  if (call.kind === "openai") return createOpenAI(settings).chat(call.model);
  return createGoogle(settings)(call.model);
}
export const generate: Generate = async (call) => {
  const limits = {
    maxOutputTokens: call.maxOutputTokens,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(call.timeoutMs),
  };
  // The tools carry no `execute`, which the type of a tool set does not express with the
  // strict optional properties of this project.
  const tools = call.tools
    ? {
        tools: Object.fromEntries(
          Object.entries(call.tools).map(([name, { description, schema }]) => [
            name,
            tool({ description, inputSchema: schema }),
          ]),
        ) as ToolSet,
      }
    : {};
  const first: ModelMessage = call.files?.length
    ? {
        role: "user",
        content: [
          { type: "text", text: call.prompt },
          ...call.files.map(
            (file) => ({ type: "file", data: file.data, mediaType: file.mediaType }) as const,
          ),
        ],
      }
    : { role: "user", content: call.prompt };
  const result =
    call.files?.length || call.messages?.length || call.tools
      ? await generateText({
          model: modelOf(call),
          system: call.system,
          messages: [first, ...(call.messages ?? [])],
          ...tools,
          ...limits,
        })
      : await generateText({
          model: modelOf(call),
          system: call.system,
          prompt: call.prompt,
          ...limits,
        });
  return {
    text: result.text,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls.map((entry) => ({
      id: entry.toolCallId,
      name: entry.toolName,
      input: entry.input as unknown,
    })),
    usage: result.usage,
  };
};
