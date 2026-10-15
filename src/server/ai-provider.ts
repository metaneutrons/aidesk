import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
// The one place that talks to a model provider. A call is one request: it is not
// repeated by the SDK (`maxRetries: 0`), because a request whose outcome is unknown
// may have been accepted, and it ends at a time limit.
// A file in the request: an image or a PDF as bytes, never as an address the SDK or
// the provider would fetch.
export interface CallFile {
  mediaType: string;
  data: Uint8Array;
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
  maxOutputTokens: number;
  timeoutMs: number;
}
export interface Answer {
  text: string;
  finishReason: string;
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
  const result = call.files?.length
    ? await generateText({
        model: modelOf(call),
        system: call.system,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: call.prompt },
              ...call.files.map(
                (file) => ({ type: "file", data: file.data, mediaType: file.mediaType }) as const,
              ),
            ],
          },
        ],
        ...limits,
      })
    : await generateText({
        model: modelOf(call),
        system: call.system,
        prompt: call.prompt,
        ...limits,
      });
  return { text: result.text, finishReason: result.finishReason, usage: result.usage };
};
