import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import type { CompatibleApi } from "./server-compat"

// The list the person looked at. An approval names it, or the server shows the entry again; none means version 1.
export function heldVersion(metadata: Record<string, unknown> | undefined) {
  const version = metadata?.version
  return typeof version === "number" && Number.isInteger(version) && version > 0 ? version : undefined
}

// The one way the app answers a held request. A merged entry only lets an approval through when it names the list
// version the person saw (`metadata.version`); without it the server shows the entry again and nothing runs.
export function replyHeld(
  api: { readonly permission: Pick<CompatibleApi["permission"], "reply"> },
  input: {
    request: Pick<PermissionRequest, "id" | "sessionID" | "metadata">
    reply: "once" | "always" | "reject"
    location?: { directory?: string }
  },
) {
  const version = heldVersion(input.request.metadata)
  return api.permission.reply({
    sessionID: input.request.sessionID,
    requestID: input.request.id,
    reply: input.reply,
    ...(input.location && { location: input.location }),
    ...(version !== undefined && { version }),
  })
}
