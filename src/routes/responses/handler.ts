import type { Context } from "hono"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"

import type { ResponsesApiRequest } from "./types"

import {
  createResponsesViaChat,
  isUnsupportedResponsesError,
} from "./chat-fallback"

const responsesUnsupportedModels = new Set<string>()

export async function handleResponses(c: Context): Promise<Response> {
  await checkRateLimit(state)

  const request = await c.req.json<ResponsesApiRequest>()
  consola.debug("Responses API request:", JSON.stringify(request).slice(-400))

  if (state.manualApprove) await awaitApproval()

  if (
    responsesUnsupportedModels.has(request.model)
    || isKnownChatBridgeModel(request.model)
  ) {
    return createResponsesViaChat(request)
  }

  try {
    return await createResponses(request)
  } catch (error) {
    if (await isUnsupportedResponsesError(error)) {
      responsesUnsupportedModels.add(request.model)
      return createResponsesViaChat(request)
    }
    throw error
  }
}

function isKnownChatBridgeModel(model: string): boolean {
  return model.toLowerCase().startsWith("claude-")
}
