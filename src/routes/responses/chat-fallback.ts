import consola from "consola"

import { HTTPError } from "~/lib/error"
import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { prepareResponsesPayload } from "~/services/copilot/create-responses"

import type { ResponsesApiRequest, ResponsesApiResponse } from "./types"

import {
  translateChatToResponses,
  translateResponsesToChat,
} from "./translation"
export const RESPONSES_CHAT_FALLBACK_MODEL = "gpt-4.1"
const CHAT_BRIDGE_MAX_RESPONSES_BYTES = 400_000

/**
 * Return true only when Copilot explicitly rejects the model/Responses API
 * combination. Validation, authentication, quota, and transient failures must
 * remain visible to the caller instead of being hidden by a protocol fallback.
 */
export async function isUnsupportedResponsesError(
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof HTTPError) || error.response.status !== 400) {
    return false
  }

  const body = (await error.response.clone().text()).toLowerCase()
  return (
    body.includes("model_not_supported")
    || body.includes("unsupported_api_for_model")
    || (body.includes("not supported")
      && (body.includes("responses api") || body.includes("model")))
  )
}

/**
 * Run a Responses request through the broadly supported Chat Completions API.
 * The fallback is deliberately buffered so callers never receive half of a
 * native Responses stream followed by a replay from another protocol.
 */
export async function createResponsesViaChat(
  request: ResponsesApiRequest,
): Promise<Response> {
  consola.warn(
    `Responses API unsupported for ${request.model}; preserving ${request.model} through Chat Completions`,
  )
  let selectedModel = request.model
  let chat: ChatCompletionResponse
  try {
    chat = await createViaChatModel(request, selectedModel)
  } catch (error) {
    if (!(await isUnsupportedChatModelError(error))) throw error
    selectedModel = RESPONSES_CHAT_FALLBACK_MODEL
    consola.warn(
      `Chat Completions also unsupported for ${request.model}; falling back to ${selectedModel}`,
    )
    chat = await createViaChatModel(request, selectedModel)
  }
  const response = translateChatToResponses(chat, selectedModel)
  const headers = bridgeHeaders(request.model, response.model)

  if (!request.stream) {
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...headers, "content-type": "application/json" },
    })
  }

  return new Response(responsesSSE(response), {
    status: 200,
    headers: {
      ...headers,
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    },
  })
}

async function createViaChatModel(
  request: ResponsesApiRequest,
  model: string,
): Promise<ChatCompletionResponse> {
  const prepared = prepareResponsesPayload(
    {
      ...request,
      model,
      stream: false,
    },
    CHAT_BRIDGE_MAX_RESPONSES_BYTES,
  )
  const payload = translateResponsesToChat(prepared)
  payload.stream = false
  consola.info(
    `Responses-via-Chat context: ${JSON.stringify(request).length} -> ${JSON.stringify(prepared).length} Responses bytes -> ${JSON.stringify(payload).length} Chat bytes, model: ${model}`,
  )
  // A 408 for a large body is deterministic for that body. Do not spend
  // another 6-9 minutes replaying it three times.
  return (await createChatCompletions(payload, {
    attempts: 1,
  })) as ChatCompletionResponse
}

export async function isUnsupportedChatModelError(
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof HTTPError) || error.response.status !== 400) {
    return false
  }
  const body = (await error.response.clone().text()).toLowerCase()
  return (
    body.includes("model_not_supported")
    || body.includes("unsupported_model")
    || (body.includes("model") && body.includes("not supported"))
  )
}

function bridgeHeaders(
  requestedModel: string,
  upstreamModel: string,
): Record<string, string> {
  return {
    "x-copilot-proxy-model-fallback": `${requestedModel}->${upstreamModel}`,
    "x-copilot-proxy-protocol-bridge": "responses-via-chat",
    "x-copilot-proxy-upstream-model": upstreamModel,
  }
}

export function responsesSSE(response: ResponsesApiResponse): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: "response.created",
      response: {
        id: response.id,
        model: response.model,
        status: "in_progress",
      },
    },
    ...response.output.map((item, outputIndex) => ({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    })),
    { type: "response.completed", response },
  ]

  return events
    .map(
      (event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("")
}
