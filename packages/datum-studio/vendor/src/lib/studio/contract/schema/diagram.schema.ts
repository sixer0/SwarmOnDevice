/**
 * JSON Schema 2020-12 `studio.diagram/v1` (01_specs.md §3.6, §3.10).
 * Bentuk = SPEC_FIELDS Garis A; aturan isi (id memuat `\d+\.\d+`, judul
 * diakhiri titik, rujukan edge ke simpul ada, tolak Mermaid DATUM-31) ditegakkan
 * `validateSpec`/`loadSpec` (I16), bukan skema.
 */
import {
  DIAGRAM_ARROW_SIZES,
  DIAGRAM_ARROW_TYPES,
  DIAGRAM_EDGE_DASHES,
  DIAGRAM_EDGE_KINDS,
  DIAGRAM_EDGE_ROUTES,
  DIAGRAM_EDGE_SIDES,
  DIAGRAM_EDGE_WEIGHTS,
  DIAGRAM_EVENT_TYPES,
  DIAGRAM_FAMILIES,
  DIAGRAM_JUMPS,
  DIAGRAM_LABEL_AT,
  DIAGRAM_LANE_ORIENTATIONS,
  DIAGRAM_SHAPES,
  DIAGRAM_ZONE_STYLES,
  PROVENANCE_MARKS,
} from "../enums";
import { JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE } from "./common.schema";
import { FIGURE_BOUNDS as B } from "./figure-bounds";

export const DIAGRAM_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/studio.diagram/v1.json`;

const str = { type: "string", minLength: 1, maxLength: B.diagramText.label } as const;
// SEC-FIX2 (D-506): setiap larik berbatas (`FIGURE_BOUNDS`, uji secfix2-schema-walk); biaya mesin super-linear.
const strList = (max: number) => ({ type: "array", maxItems: max, items: { type: "string", maxLength: B.diagramText.item } }) as const;
// Swarm 1.2.8 row 52 (VIS-0a, F-VISIO 01f §2.1, register N8-247, N8-250, N8-253): swimlane phases and pools,
// `[{ id, label }]`; ids are named by `class.phase` / `class.pool` (checked by the engine, `P1-containers`).
const containerList = (max: number) =>
  ({
    type: "array",
    minItems: 1,
    maxItems: max,
    items: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 64 }, label: str },
      required: ["id", "label"],
      additionalProperties: false,
    },
  }) as const;
const side = { enum: [...DIAGRAM_EDGE_SIDES] } as const;
// Glue point along a side (fraction of its length, 0 and 1 excluded); needs an explicit side (engine, P1-edge-style).
const slot = { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 } as const;
const arrow = { enum: [...DIAGRAM_ARROW_TYPES] } as const;
const arrowSize = { enum: [...DIAGRAM_ARROW_SIZES] } as const;

export const diagramSchema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: DIAGRAM_SCHEMA_ID,
  title: "studio.diagram/v1",
  type: "object",
  properties: {
    $schema: { const: "studio.diagram/v1" },
    family: { enum: [...DIAGRAM_FAMILIES] },
    id: { type: "string", minLength: 1, maxLength: 64 },
    title: str,
    classification: { type: "string", minLength: 1, maxLength: 64 },
    // D-245 H1: lebar sah = turunan kertas (A4 128/166); keanggotaan ditegakkan mesin diagram (P1-width_mm).
    width_mm: { type: "number", exclusiveMinimum: 0 },
    apparatus: { enum: ["page", "figure"] },
    labels_verified: { type: "boolean" },
    sources: { type: "array", minItems: 1, maxItems: B.diagramSources, items: { type: "string", minLength: 1, maxLength: B.diagramText.source } },
    source: { type: "string", maxLength: B.diagramText.source },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: B.diagramNodes,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          label: str,
          sub: { type: "string", maxLength: B.diagramText.label },
          shape: { enum: [...DIAGRAM_SHAPES] },
          mark: { enum: [...PROVENANCE_MARKS] },
          tag: { type: "string", maxLength: 64 },
          u: { type: "number", minimum: 0 },
          external: { type: "boolean" },
          // Swarm patch (row 124b, CP-45; Table 10.1, SM-01/03/04 ID p.63, 66): library symbol id
          // (e.g. "iec:battery"); additive, optional; known-id and one-dialect rules are the engine's.
          symbol: { type: "string", minLength: 1, maxLength: 64 },
          class: {
            type: "object",
            properties: {
              tier: { type: "integer", minimum: 0 },
              lane: { type: ["integer", "string"], maxLength: 64 },
              col: { type: "integer", minimum: 0 },
              row: { type: "integer", minimum: 0 },
              accent: { type: "boolean" },
              secondary: { type: "boolean" },
              external: { type: "boolean" },
              // Swarm 1.2.8 row 52 (VIS-0a, N8-248, N8-251): the phase / pool id this node sits in (swimlane family).
              phase: { type: "string", minLength: 1, maxLength: 64 },
              pool: { type: "string", minLength: 1, maxLength: 64 },
            },
            additionalProperties: false,
          },
          // Swarm 1.2.8 row 52 (VIS-0a, N8-236): BPMN event trigger, only on event_start/_intermediate/_end
          // (engine, P1-event_type). Absent = "none".
          event_type: { enum: [...DIAGRAM_EVENT_TYPES] },
        },
        required: ["id", "label", "class"],
        additionalProperties: false,
      },
    },
    edges: {
      type: "array",
      maxItems: B.diagramEdges,
      items: {
        type: "object",
        properties: {
          from: { type: "string", minLength: 1, maxLength: 64 },
          to: { type: "string", minLength: 1, maxLength: 64 },
          kind: { enum: [...DIAGRAM_EDGE_KINDS] },
          label: { type: "string", maxLength: B.diagramText.label },
          // Swarm 1.2.8 row 52 (VIS-0a, F-VISIO 01f §3.1, N8-254..N8-265): connector style. Absent = today's drawing;
          // an explicit default draws the same bytes as the absent field. Colour stays owned by `kind`.
          route: { enum: [...DIAGRAM_EDGE_ROUTES] },
          from_side: side,
          to_side: side,
          from_slot: slot,
          to_slot: slot,
          // Bend points on the layout lattice (figure.lattice of the preview); flow without direction, graph, swimlane.
          via: {
            type: "array",
            minItems: 1,
            maxItems: B.diagramVia,
            items: {
              type: "object",
              properties: { col: { type: "integer", minimum: 0 }, row: { type: "integer", minimum: 0 } },
              required: ["col", "row"],
              additionalProperties: false,
            },
          },
          arrow_start: arrow,
          arrow_end: arrow,
          arrow_start_size: arrowSize,
          arrow_end_size: arrowSize,
          dash: { enum: [...DIAGRAM_EDGE_DASHES] },
          weight: { enum: [...DIAGRAM_EDGE_WEIGHTS] },
          label_at: { enum: [...DIAGRAM_LABEL_AT] },
        },
        required: ["from", "to", "kind", "label"],
        additionalProperties: false,
      },
    },
    zones: {
      type: "array",
      maxItems: B.diagramZones,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          label: str,
          members: { type: "array", maxItems: B.zoneMembers, items: { type: "string", minLength: 1, maxLength: 64 } },
          // Swarm 1.2.8 row 52 (VIS-0a, N8-252): "group" = BPMN group (rounded, dash-dot). Absent = "zone".
          style: { enum: [...DIAGRAM_ZONE_STYLES] },
        },
        required: ["id", "label", "members"],
        additionalProperties: false,
      },
    },
    legend: strList(B.diagramLegend),
    notes: strList(B.diagramNotes),
    per_row: { type: "integer", minimum: 1, maximum: 20 },
    // Swarm 1.2.6 row 45 (T-11, N-109, SEC-23): ranked flow direction, flow only (`P1-direction` in validateSpec and the
    // by-construction gate). Absent = legacy list layout. Enum only: any other value (RL, BT, "RL; x") is SCHEMA_INVALID
    // before any layout or ELK option is built.
    direction: { enum: ["TB", "LR"] },
    // Delta S03-d2 (D-89): opt-in multi-rel layout-c; aditif.
    sld: {
      type: "object",
      properties: { multiBus: { type: "boolean" } },
      additionalProperties: false,
    },
    // Swarm 1.2.8 row 52 (VIS-0a, F-VISIO 01f §2.1, §3.1; N8-249, N8-247, N8-250, N8-266): swimlane lanes as rows or
    // columns, phase and pool bands (swimlane family only, engine P1-containers), line jumps at crossings.
    lane_orientation: { enum: [...DIAGRAM_LANE_ORIENTATIONS] },
    phases: containerList(B.diagramPhases),
    pools: containerList(B.diagramPools),
    jumps: { enum: [...DIAGRAM_JUMPS] },
    // INTERNAL compose (D-288): diisi `services/compose/blocks.ts`, bukan medan agen.
    // `not: {}` = selalu ditolak pada masukan agen (artefak v1, dokumen v1); spec
    // terkomposisi tidak divalidasi ulang di jalur render.
    keyRowOnPage: { not: {}, description: "INTERNAL compose: not an agent field; always rejected on agent input" },
  },
  required: ["$schema", "family", "id", "title", "classification", "width_mm", "sources", "nodes"],
  additionalProperties: false,
} as const;
