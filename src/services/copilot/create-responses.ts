import consola from "consola"

import type {
  ResponsesApiRequest,
  ResponsesInputItem,
} from "~/routes/responses/types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

const MAX_RESPONSES_PAYLOAD_BYTES = 5_000_000
const CHARS_PER_TOKEN_ESTIMATE = 3.5
const TOKEN_RESERVE = 8_000
const IMAGE_STRIPPED_PLACEHOLDER =
  "[image removed to stay under upstream payload limit]"
const INPUT_DROPPED_PLACEHOLDER =
  "[older response input omitted to stay under context limit]"
const INPUT_TRUNCATED_PREFIX =
  "[older response input truncated to stay under context limit]\n\n"

export async function createResponses(
  payload: ResponsesApiRequest,
): Promise<Response> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const upstreamPayload = fitResponsesPayload(
    sanitizeResponsesPayload(payload),
    computeResponsesPayloadCeiling(payload.model),
  )
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
  ceiling: number,
): ResponsesApiRequest {
  const initialBody = JSON.stringify(payload)
  if (initialBody.length <= ceiling) return payload

  consola.info(
    `Responses context fit: payload ${initialBody.length} bytes exceeds ${ceiling} byte ceiling - reducing`,
  )

  if (typeof payload.input === "string") {
    const current = truncateStringInput(payload, ceiling)
    const currentBodyLength = JSON.stringify(current).length
    consola.warn(
      `Responses context fit: truncated string input (${initialBody.length} -> ${currentBodyLength} bytes)`,
    )
    return current
  }

  let current = payload
  let currentBodyLength = initialBody.length

  const imageLocations = collectImageLocations(payload)
  let strippedCount = 0

  for (const location of imageLocations) {
    current = replaceImageWithPlaceholder(current, location)
    strippedCount++
    currentBodyLength = JSON.stringify(current).length
    if (currentBodyLength <= ceiling) break
  }

  if (strippedCount > 0) {
    consola.warn(
      `Responses context fit: stripped ${strippedCount} images (${initialBody.length} -> ${currentBodyLength} bytes)`,
    )
  }

  if (currentBodyLength <= ceiling) return current

  const dropped = dropOldInputItems(current, ceiling)
  current = dropped.payload
  currentBodyLength = dropped.bodyLength
  if (dropped.count > 0) {
    consola.warn(
      `Responses context fit: dropped ${dropped.count} old input items (${initialBody.length} -> ${currentBodyLength} bytes)`,
    )
  }

  if (currentBodyLength <= ceiling) return current

  current = truncateLargestInputContent(current, ceiling)
  currentBodyLength = JSON.stringify(current).length
  consola.warn(
    `Responses context fit: truncated input content (${initialBody.length} -> ${currentBodyLength} bytes)`,
  )

  return current
}

function computeResponsesPayloadCeiling(modelId: string): number {
  const limits = state.models?.data.find((m) => m.id === modelId)?.capabilities
    .limits
  const maxPromptTokens = limits?.max_prompt_tokens
  if (!maxPromptTokens) return MAX_RESPONSES_PAYLOAD_BYTES

  const tokenDerivedBytes = Math.floor(
    (maxPromptTokens - TOKEN_RESERVE) * CHARS_PER_TOKEN_ESTIMATE,
  )
  return Math.min(MAX_RESPONSES_PAYLOAD_BYTES, tokenDerivedBytes)
}

function truncateStringInput(
  payload: ResponsesApiRequest,
  ceiling: number,
): ResponsesApiRequest {
  if (typeof payload.input !== "string") return payload

  const overhead = JSON.stringify({ ...payload, input: "" }).length
  const maxInputLength = Math.max(
    INPUT_TRUNCATED_PREFIX.length,
    ceiling - overhead,
  )
  const tailLength = Math.max(0, maxInputLength - INPUT_TRUNCATED_PREFIX.length)
  return {
    ...payload,
    input: INPUT_TRUNCATED_PREFIX + payload.input.slice(-tailLength),
  }
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

function dropOldInputItems(
  payload: ResponsesApiRequest,
  ceiling: number,
): { bodyLength: number; count: number; payload: ResponsesApiRequest } {
  if (typeof payload.input === "string") {
    return { bodyLength: JSON.stringify(payload).length, count: 0, payload }
  }

  const input = [...payload.input]
  let bodyLength = JSON.stringify({ ...payload, input }).length
  let count = 0

  for (let index = 0; index < input.length && bodyLength > ceiling; index++) {
    const item = input[index]
    if (item.role === "system" || item.role === "developer") continue
    if (countRecentDroppableItems(input, index) <= 2) continue

    input[index] = {
      ...item,
      content: INPUT_DROPPED_PLACEHOLDER,
    }
    count++
    bodyLength = JSON.stringify({ ...payload, input }).length
  }

  return { bodyLength, count, payload: { ...payload, input } }
}

function countRecentDroppableItems(
  input: Array<ResponsesInputItem>,
  index: number,
): number {
  let count = 0
  for (let i = index; i < input.length; i++) {
    if (input[i].role !== "system" && input[i].role !== "developer") count++
  }
  return count
}

function truncateLargestInputContent(
  payload: ResponsesApiRequest,
  ceiling: number,
): ResponsesApiRequest {
  if (typeof payload.input === "string") {
    return truncateStringInput(payload, ceiling)
  }

  let current = payload
  let bodyLength = JSON.stringify(current).length

  while (bodyLength > ceiling) {
    const target = findLargestTextContent(current)
    if (!target) return current

    current = truncateTextAtLocation(current, target, bodyLength - ceiling)
    const nextBodyLength = JSON.stringify(current).length
    if (nextBodyLength >= bodyLength) return current
    bodyLength = nextBodyLength
  }

  return current
}

interface TextLocation {
  contentIndex?: number
  inputIndex: number
  length: number
}

function findLargestTextContent(
  payload: ResponsesApiRequest,
): TextLocation | null {
  if (typeof payload.input === "string") return null

  let largest: TextLocation | null = null
  for (const [inputIndex, item] of payload.input.entries()) {
    if (item.role === "system" || item.role === "developer") continue

    if (typeof item.content === "string") {
      if (!largest || item.content.length > largest.length) {
        largest = { inputIndex, length: item.content.length }
      }
      continue
    }

    for (const [contentIndex, part] of item.content.entries()) {
      if (!part.text) continue
      if (!largest || part.text.length > largest.length) {
        largest = { contentIndex, inputIndex, length: part.text.length }
      }
    }
  }

  return largest
}

function truncateTextAtLocation(
  payload: ResponsesApiRequest,
  location: TextLocation,
  excessBytes: number,
): ResponsesApiRequest {
  if (typeof payload.input === "string") return payload

  const input = [...payload.input]
  const item = input[location.inputIndex]
  const keepLength = Math.max(
    0,
    location.length - excessBytes - INPUT_TRUNCATED_PREFIX.length - 10_000,
  )

  if (location.contentIndex === undefined) {
    if (typeof item.content !== "string") return payload
    input[location.inputIndex] = {
      ...item,
      content: INPUT_TRUNCATED_PREFIX + item.content.slice(-keepLength),
    }
    return { ...payload, input }
  }

  if (!Array.isArray(item.content)) return payload
  const content = [...item.content]
  const part = content[location.contentIndex]
  if (!part.text) return payload

  content[location.contentIndex] = {
    ...part,
    text: INPUT_TRUNCATED_PREFIX + part.text.slice(-keepLength),
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
