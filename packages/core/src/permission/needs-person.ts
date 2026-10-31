// A spend limit and a repeating call stop a run so that a person looks at it. Anything that answers on someone's behalf,
// whatever its setting is called, leaves these alone: answering one would remove the only ceiling the run has.
const NEEDS_PERSON = new Set(["spend_limit", "doom_loop"])

export const needsPerson = (permission: string) => NEEDS_PERSON.has(permission)
