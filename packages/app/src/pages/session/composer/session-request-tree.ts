import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"

function sessionTreeIds(session: Session[], sessionID: string) {
  const map = session.reduce((acc, item) => {
    if (!item.parentID) return acc
    const list = acc.get(item.parentID)
    if (list) list.push(item.id)
    if (!list) acc.set(item.parentID, [item.id])
    return acc
  }, new Map<string, string[]>())

  const seen = new Set([sessionID])
  const ids = [sessionID]
  for (const id of ids) {
    const list = map.get(id)
    if (!list) continue
    for (const child of list) {
      if (seen.has(child)) continue
      seen.add(child)
      ids.push(child)
    }
  }
  return ids
}

function sessionTreeRequest<T>(
  session: Session[],
  request: Record<string, T[] | undefined>,
  sessionID?: string,
  include: (item: T) => boolean = () => true,
) {
  if (!sessionID) return
  const id = sessionTreeIds(session, sessionID).find((id) => request[id]?.some(include))
  if (!id) return
  return request[id]?.find(include)
}

export function sessionPermissionRequest(
  session: Session[],
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: PermissionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}

export function sessionQuestionRequest(
  session: Session[],
  request: Record<string, QuestionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: QuestionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}

export type MovedOnRequest =
  | { kind: "permission"; request: PermissionRequest }
  | { kind: "question"; request: QuestionRequest }

/**
 * What the agents in this session carried on without, oldest first. Every one is still waiting for a decision. Takes the
 * sessions lazily because this runs on every session update and there is almost never anything to place.
 */
export function sessionMovedOnRequests(
  session: () => Session[],
  permission: Record<string, PermissionRequest[] | undefined>,
  question: Record<string, QuestionRequest[] | undefined>,
  sessionID?: string,
): MovedOnRequest[] {
  if (!sessionID) return []
  const moved = [
    ...Object.values(permission).flatMap((requests) =>
      (requests ?? [])
        .filter((request) => request.movedOnAt)
        .map((request): MovedOnRequest => ({ kind: "permission", request })),
    ),
    ...Object.values(question).flatMap((requests) =>
      (requests ?? [])
        .filter((request) => request.movedOnAt)
        .map((request): MovedOnRequest => ({ kind: "question", request })),
    ),
  ]
  if (moved.length === 0) return []
  const tree = new Set(sessionTreeIds(session(), sessionID))
  return moved
    .filter((item) => tree.has(item.request.sessionID))
    .toSorted((a, b) => (a.request.movedOnAt ?? 0) - (b.request.movedOnAt ?? 0))
}
