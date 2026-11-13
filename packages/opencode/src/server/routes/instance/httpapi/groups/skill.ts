import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { DesktopNonceHeaders } from "./autonomy"
import { described } from "./metadata"

// 1.2.8 row 40c (F-SKILL SK-d, SK-f; 01b section 5.2, N8-040..N8-043, N8-400, N8-401): the person's skill routes.
// `GET /skill` stays in the instance group (`app.skills`). Writes are person-only twice: the autonomy table refuses an
// agent's PUT/POST/DELETE under /skill (row 28, PERSON_ONLY_WRITES), and every write handler here needs the desktop
// app's per-launch nonce, whoever calls (a server holding none refuses every caller).

export const SkillPaths = {
  skill: "/skill",
  source: "/skill/source",
  drafts: "/skill/drafts",
  draft: "/skill/drafts/:name",
  draftApprove: "/skill/drafts/:name/approve",
} as const

const WriteScope = Schema.Literals(["global", "project"])

const SkillQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields, scope: WriteScope, name: Schema.String })
const DraftQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields, scope: WriteScope })

// One error per status; `data.code` is the register code the app maps to its string (01b section 5.6).
const errorData = <const C extends readonly [string, ...string[]]>(codes: C) =>
  Schema.Struct({ code: Schema.Literals(codes), message: Schema.String })

export class ApiSkillInvalidError extends Schema.ErrorClass<ApiSkillInvalidError>("SkillInvalidError")(
  {
    name: Schema.Literal("SkillInvalidError"),
    data: errorData([
      "SKILL_NAME_INVALID",
      "SKILL_NAME_RESERVED",
      "SKILL_FRONTMATTER_INVALID",
      "SKILL_TRIGGERS_INVALID",
      "SKILL_PATH_UNSAFE",
      "SKILL_SHELL_UNCONFIRMED",
    ]),
  },
  { httpApiStatus: 400 },
) {}

export class ApiSkillForbiddenError extends Schema.ErrorClass<ApiSkillForbiddenError>("SkillForbiddenError")(
  {
    name: Schema.Literal("SkillForbiddenError"),
    data: errorData(["SKILL_PERSON_ONLY", "SKILL_SHELL_UNTRUSTED"]),
  },
  { httpApiStatus: 403 },
) {}

export class ApiSkillMissingError extends Schema.ErrorClass<ApiSkillMissingError>("SkillMissingError")(
  {
    name: Schema.Literal("SkillMissingError"),
    data: errorData(["SKILL_NOT_FOUND", "SKILL_DRAFT_MISSING"]),
  },
  { httpApiStatus: 404 },
) {}

export class ApiSkillChangedError extends Schema.ErrorClass<ApiSkillChangedError>("SkillChangedError")(
  {
    name: Schema.Literal("SkillChangedError"),
    data: errorData(["SKILL_CHANGED"]),
  },
  { httpApiStatus: 409 },
) {}

export class ApiSkillTooLargeError extends Schema.ErrorClass<ApiSkillTooLargeError>("SkillTooLargeError")(
  {
    name: Schema.Literal("SkillTooLargeError"),
    data: errorData(["SKILL_TOO_LARGE"]),
  },
  { httpApiStatus: 413 },
) {}

export class ApiSkillArchiveError extends Schema.ErrorClass<ApiSkillArchiveError>("SkillArchiveError")(
  {
    name: Schema.Literal("SkillArchiveError"),
    data: errorData(["SKILL_ARCHIVE_FAILED"]),
  },
  { httpApiStatus: 500 },
) {}

const WriteErrors = [
  ApiSkillInvalidError,
  ApiSkillForbiddenError,
  ApiSkillMissingError,
  ApiSkillChangedError,
  ApiSkillTooLargeError,
  HttpApiError.InternalServerError,
] as const

export const SkillSource = Schema.Struct({
  location: Schema.String,
  scope: WriteScope,
  content: Schema.String,
  hash: Schema.String,
}).annotate({ identifier: "SkillSource" })

export const SkillSaved = Schema.Struct({
  location: Schema.String,
  hash: Schema.String,
  note: Schema.Literals(["added", "updated", "skipped"]).annotate({
    description: "The skill's memory note: skipped when memory is off or refused it; the skill is saved either way",
  }),
}).annotate({ identifier: "SkillSaved" })

export const SkillSavePayload = Schema.Struct({
  scope: WriteScope,
  name: Schema.String,
  content: Schema.String,
  baseHash: Schema.optional(Schema.String).annotate({
    description: "The hash read from GET /skill/source. Required to overwrite an existing skill",
  }),
})

export const SkillDraft = Schema.Struct({
  name: Schema.String,
  scope: WriteScope,
  content: Schema.String,
  time: Schema.Number,
  sessionID: Schema.optional(Schema.String),
  untrusted: Schema.Boolean,
  runsCommands: Schema.Boolean,
  replaces: Schema.Boolean,
}).annotate({ identifier: "SkillDraft" })

export const SkillDraftApprovePayload = Schema.Struct({
  scope: WriteScope,
  acceptCommands: Schema.optional(Schema.Boolean).annotate({
    description: "Set only after the person's second, explicit confirm; required when the draft runs shell commands",
  }),
})

const PERSON_ONLY =
  " Person-only: needs the desktop app's per-launch x-swarm-desktop-nonce, else 403 SKILL_PERSON_ONLY (also on a server holding no nonce)."

export const SkillApi = HttpApi.make("skill")
  .add(
    HttpApiGroup.make("skill")
      .add(
        HttpApiEndpoint.get("source", SkillPaths.source, {
          query: SkillQuery,
          success: described(SkillSource, "The SKILL.md text and its sha256"),
          error: [ApiSkillInvalidError, ApiSkillMissingError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.source",
            summary: "Read a skill's source",
            description:
              "The raw SKILL.md (frontmatter included) of a global or project skill Swarm saved, with the hash PUT /skill takes as baseHash. Show it as plain text.",
          }),
        ),
        HttpApiEndpoint.put("save", SkillPaths.skill, {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          headers: DesktopNonceHeaders,
          payload: SkillSavePayload,
          success: described(SkillSaved, "Where the skill was saved"),
          error: WriteErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.save",
            summary: "Save a skill",
            description:
              "Write <scope root>/skills/<name>/SKILL.md atomically after the shared checks, record the approval and keep one memory note for the skill." +
              PERSON_ONLY,
          }),
        ),
        HttpApiEndpoint.delete("delete", SkillPaths.skill, {
          query: SkillQuery,
          headers: DesktopNonceHeaders,
          success: described(
            Schema.Struct({ archive: Schema.String }).annotate({ identifier: "SkillDeleted" }),
            "The archive entry, relative to the scope root",
          ),
          error: [...WriteErrors, ApiSkillArchiveError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.delete",
            summary: "Delete a skill",
            description:
              "Move the skill's folder to the archive (never deleted outright) and remove its memory note." +
              PERSON_ONLY,
          }),
        ),
        HttpApiEndpoint.get("drafts", SkillPaths.drafts, {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          success: described(Schema.Array(SkillDraft), "Drafts waiting for the person"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.drafts",
            summary: "List skill drafts",
            description:
              "Skills an agent drafted, global and project. A draft is never loaded until the person approves it. Show the content as plain text.",
          }),
        ),
        HttpApiEndpoint.post("draftApprove", SkillPaths.draftApprove, {
          params: { name: Schema.String },
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          headers: DesktopNonceHeaders,
          payload: SkillDraftApprovePayload,
          success: described(SkillSaved, "Where the skill was saved"),
          error: WriteErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.draftApprove",
            summary: "Approve a skill draft",
            description:
              "Save the draft with the same checks as PUT /skill and remove the draft. A draft that runs shell commands needs acceptCommands: true, else 400 SKILL_SHELL_UNCONFIRMED and nothing is written." +
              PERSON_ONLY,
          }),
        ),
        HttpApiEndpoint.delete("draftDiscard", SkillPaths.draft, {
          params: { name: Schema.String },
          query: DraftQuery,
          headers: DesktopNonceHeaders,
          success: described(
            Schema.Struct({ removed: Schema.Literal(true) }).annotate({ identifier: "SkillDraftRemoved" }),
            "The draft was removed",
          ),
          error: [ApiSkillInvalidError, ApiSkillForbiddenError, ApiSkillMissingError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.draftDiscard",
            summary: "Discard a skill draft",
            description: "Remove one draft, named by scope and name." + PERSON_ONLY,
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "skill", description: "Person-managed skill routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "swarm HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
