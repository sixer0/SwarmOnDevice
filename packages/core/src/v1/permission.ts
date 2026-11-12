export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@opencode-ai/schema/permission-v1"
import { DeferredError, ID } from "@opencode-ai/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

/**
 * P-03 (N-083): a request nobody has answered, whether it waited its time or was queued at once because its task's
 * family is already away (opencode permission/index.ts). It stays in the pending list, answerable; the agent goes on.
 */
export const QUEUED_TEXT =
  "Nobody has answered this permission request yet, so this call did not run. It waits for the user in the list and stays answerable; do not ask again and do not wait for it. Continue with other work."

export class AwayError extends Schema.TaggedErrorClass<AwayError>()("PermissionAwayError", {}) {
  override get message() {
    return QUEUED_TEXT + " If it only looked at something inside the project, use a tool that asks nobody and carry on: read for a file or a directory's listing (instead of cat or ls), glob to find files (instead of find), grep to search (instead of grep or rg), git for the repository's state (instead of git status, diff, log, show, blame or branch). Do not try to get any other effect another way, and do not ask for a file that holds secrets by another route. Carry on with everything that does not depend on it, and list what you skipped in your final message."
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError | AwayError | DeferredError
