import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderError } from "@/provider/error"

describe("provider stream errors", () => {
  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })
})

describe("isUnreachable", () => {
  const apiError = (message: string, statusCode?: number) =>
    new APICallError({ message, url: "http://x/v1", requestBodyValues: {}, statusCode })

  test.each([
    ["the SDK's connection failure", apiError("Cannot connect to API: Unable to connect. Is the computer able to access the url?")],
    ["a refused connection", Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" })],
    ["a name that does not resolve", Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })],
    ["no route", Object.assign(new Error("no route"), { code: "EHOSTUNREACH" })],
    ["our own check", new ProviderError.UnreachableError("box:8000")],
  ])("%s", (_, error) => {
    expect(ProviderError.isUnreachable(error)).toBe(true)
  })

  test.each([
    ["a server that answered with an error", apiError("Bad gateway: cannot connect to api upstream", 502)],
    ["a refusal", apiError("This model's maximum context length is 32768 tokens", 400)],
    ["a stream cut partway", new Error("The provider closed the connection before finishing its answer")],
    ["not an error at all", "ECONNREFUSED"],
  ])("%s is something else", (_, error) => {
    expect(ProviderError.isUnreachable(error)).toBe(false)
  })
})
