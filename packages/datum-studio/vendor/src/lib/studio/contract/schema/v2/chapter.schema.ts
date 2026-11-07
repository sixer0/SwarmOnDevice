/**
 * JSON Schema 2020-12 `studio.chapter/v2` (SID02; register 03_structural_sections_specs.md
 * §4.5 T2-47). Kiriman satu bab ke dokumen misi (R12). Target tepat-satu-cara,
 * `template`/`meta.title` saat membuat, dan pola kunci bab ditegakkan layanan.
 */
import { SLOT_KEY_PATTERN } from "../../env";
import { JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE } from "../common.schema";
import { commonV2Ref, docV1Ref } from "./common.schema";

export const CHAPTER_V2_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/studio.chapter/v2.json`;

export const chapterV2Schema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: CHAPTER_V2_SCHEMA_ID,
  title: "studio.chapter/v2",
  type: "object",
  properties: {
    $schema: { const: "studio.chapter/v2" },
    agentId: { type: "string", minLength: 1, maxLength: 80 },
    target: commonV2Ref("DocTargetV2"),
    template: docV1Ref("TemplateRef"),
    meta: commonV2Ref("DocMetaV2"),
    slot: { type: "string", pattern: SLOT_KEY_PATTERN },
    chapter: commonV2Ref("ChapterV2"),
    register: commonV2Ref("RegisterMapV2"),
    assets: commonV2Ref("AssetMapV2"),
    baseRevisionNo: { type: "integer", minimum: 1 },
    change: commonV2Ref("ChangeV2"),
    // D-247: tanpa `render` (dikirim -> 400 SCHEMA_INVALID checkId RENDER_FIELD, forbidden.ts).
  },
  required: ["$schema", "target", "chapter"],
  additionalProperties: false,
} as const;
