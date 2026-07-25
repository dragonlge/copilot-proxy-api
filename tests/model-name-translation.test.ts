import { afterEach, describe, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

function addModel(id: string) {
  state.models ??= { object: "list", data: [] }
  state.models.data.push({
    id,
    object: "model",
    name: id,
    model_picker_enabled: true,
    preview: false,
    vendor: "anthropic",
    version: id,
    capabilities: {
      family: id,
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  })
}

afterEach(() => {
  state.models = undefined
})

describe("model name translation", () => {
  test("maps integer Claude versions like Sonnet 5 to Copilot model ids", () => {
    addModel("claude-sonnet-4.6")
    addModel("claude-sonnet-5")

    const result = translateToOpenAI({
      model: "claude-sonnet-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    })

    expect(result.model).toBe("claude-sonnet-5")
  })

  test("uses Sonnet 5 for the short sonnet alias", () => {
    const result = translateToOpenAI({
      model: "sonnet",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    })

    expect(result.model).toBe("claude-sonnet-5")
  })

  test("uses Opus 5 for the short opus alias", () => {
    const result = translateToOpenAI({
      model: "opus",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    })

    expect(result.model).toBe("claude-opus-5")
  })

  test("preserves explicit Opus 5 requests when not in cached models", () => {
    addModel("claude-opus-4.8")

    const result = translateToOpenAI({
      model: "claude-opus-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    })

    expect(result.model).toBe("claude-opus-5")
  })

  test("normalizes Opus 5 aliases and dated Anthropic ids", () => {
    for (const model of ["opus-5", "claude-opus-5-20260724"]) {
      const result = translateToOpenAI({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "x" }],
      })

      expect(result.model).toBe("claude-opus-5")
    }
  })

  test("does not invent unsupported future Claude model ids", () => {
    addModel("claude-sonnet-5")

    const result = translateToOpenAI({
      model: "claude-sonnet-6",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    })

    expect(result.model).toBe("claude-sonnet-5")
  })

  test("keeps legacy Opus requests on the latest advertised major 4 model", () => {
    addModel("claude-opus-4.7")
    addModel("claude-opus-5")

    const result = translateToOpenAI({
      model: "claude-opus-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    })

    expect(result.model).toBe("claude-opus-4.7")
  })

  test("does not pass through Anthropic hyphenated version ids", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    })

    expect(result.model).toBe("claude-opus-4.8")
  })

  test("does not pass through bare legacy major-version ids", () => {
    const result = translateToOpenAI({
      model: "claude-opus-4",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    })

    expect(result.model).toBe("claude-opus-4.8")
  })
})
