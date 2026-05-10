import consola from "consola"

import type { ResponsesApiRequest } from "~/routes/responses/types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

const MAX_RESPONSES_PAYLOAD_BYTES = 5_000_000
const IMAGE_STRIPPED_PLACEHOLDER =
  "[image removed to stay under upstream payload limit]"

export async function createResponses(
  payload: ResponsesApiRequest,
): Promise<Response> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const upstreamPayload = fitResponsesPayload(sanitizeResponsesPayload(payload))
  const body = JSON.stringify(upstreamPayload)
  const headers: Record<string, string> = {
    ...copilotHeaders(state, responsesPayloadHasImages(upstreamPayload)),
    accept: upstreamPayload.stream ? "text/event-stream" : "application/json",
    "X-Initiator": "agent",
  }

  consola.info(
    `Sending responses payload: ${body.length} bytes, model: ${payload.model}`,
  )

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body,
  })

  if (!response.ok) {
    const errorBody = await response.text()
    consola.error(
      `Failed to create responses - Status: ${response.status} ${response.statusText}`,
    )
    consola.error(`Response body: ${errorBody}`)
    consola.error(`Request payload size: ${body.length} bytes`)

    if (isContextOverflow(response, errorBody, body.length)) {
      const estimatedTokens = Math.ceil(body.length / 4)
      const modelCaps = state.models?.data.find((m) => m.id === payload.model)
        ?.capabilities.limits
      const modelLimit =
        modelCaps?.max_prompt_tokens
        ?? modelCaps?.max_context_window_tokens
        ?? 200_000
      const maxOutputTokens = payload.max_output_tokens ?? 0

      consola.warn(
        `Responses context overflow -> returning 400 prompt-too-long (~${estimatedTokens} + ${maxOutputTokens} > ${modelLimit})`,
      )

      throw new HTTPError(
        "Prompt too long",
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: `prompt is too long: input length and \`max_tokens\` exceed context limit: ${estimatedTokens} + ${maxOutputTokens} > ${modelLimit} tokens`,
            },
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: { "content-type": "application/json" },
          },
        ),
      )
    }

    throw new HTTPError(
      "Failed to create responses",
      new Response(errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    )
  }

  return response
}

function fitResponsesPayload(
  payload: ResponsesApiRequest,
): ResponsesApiRequest {
  const initialBody = JSON.stringify(payload)
  if (initialBody.length <= MAX_RESPONSES_PAYLOAD_BYTES) return payload
  if (typeof payload.input === "string") return payload

  const imageLocations = collectImageLocations(payload)
  if (imageLocations.length === 0) return payload

  consola.info(
    `Responses context fit: payload ${initialBody.length} bytes exceeds ${MAX_RESPONSES_PAYLOAD_BYTES} byte ceiling - stripping old images`,
  )

  let current = payload
  let currentBodyLength = initialBody.length
  let strippedCount = 0

  for (const location of imageLocations) {
    current = replaceImageWithPlaceholder(current, location)
    strippedCount++
    currentBodyLength = JSON.stringify(current).length
    if (currentBodyLength <= MAX_RESPONSES_PAYLOAD_BYTES) break
  }

  consola.warn(
    `Responses context fit: stripped ${strippedCount} images (${initialBody.length} -> ${currentBodyLength} bytes)`,
  )

  return current
}

interface ImageLocation {
  contentIndex: number
  inputIndex: number
}

function collectImageLocations(
  payload: ResponsesApiRequest,
): Array<ImageLocation> {
  if (typeof payload.input === "string") return []

  const locations: Array<ImageLocation> = []
  for (const [inputIndex, item] of payload.input.entries()) {
    if (!Array.isArray(item.content)) continue

    for (const [contentIndex, part] of item.content.entries()) {
      if (part.type === "input_image") {
        locations.push({ contentIndex, inputIndex })
      }
    }
  }
  return locations
}

function replaceImageWithPlaceholder(
  payload: ResponsesApiRequest,
  location: ImageLocation,
): ResponsesApiRequest {
  if (typeof payload.input === "string") return payload

  const input = [...payload.input]
  const item = input[location.inputIndex]
  if (!Array.isArray(item.content)) return payload

  const content = [...item.content]
  content[location.contentIndex] = {
    type: "input_text",
    text: IMAGE_STRIPPED_PLACEHOLDER,
  }

  input[location.inputIndex] = { ...item, content }
  return { ...payload, input }
}

function isContextOverflow(
  response: Response,
  errorBody: string,
  bodyLength: number,
): boolean {
  return (
    response.status === 413
    || /request entity too large/i.test(errorBody)
    || /exceeds the limit of \d+/i.test(errorBody)
    || /context_length_exceeded/i.test(errorBody)
    || /operation timed out/i.test(errorBody)
    || /payload too large/i.test(errorBody)
    || /maximum context length/i.test(errorBody)
    || (response.status >= 500
      && response.status < 600
      && bodyLength > 2_000_000)
  )
}

function sanitizeResponsesPayload(
  payload: ResponsesApiRequest,
): ResponsesApiRequest {
  const sanitized: ResponsesApiRequest = { ...payload }

  // Codex sends ChatGPT-only fast mode metadata; Copilot Responses rejects it.
  delete (sanitized as ResponsesApiRequest & { service_tier?: unknown })
    .service_tier

  if (!sanitized.tools?.some((tool) => tool.type === "image_generation")) {
    return sanitized
  }

  return {
    ...sanitized,
    tools: sanitized.tools.filter((tool) => tool.type !== "image_generation"),
  }
}

function responsesPayloadHasImages(payload: ResponsesApiRequest): boolean {
  if (typeof payload.input === "string") return false

  return payload.input.some(
    (item) =>
      Array.isArray(item.content)
      && item.content.some((part) => part.type === "input_image"),
  )
}
