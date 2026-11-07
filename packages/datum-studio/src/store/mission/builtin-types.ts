/**
 * The four builtin mission types (U20), as data (`studio.mission-type/v1`), copied from the row 118 file
 * /private/tmp/claude-501/row118/schema/types.json (spec §3.3, Appendix B). Canonical sha256 of the array is
 * BUILTIN_MISSION_TYPES_SHA256; the test checks it. A change to a type ships as version + 1 (spec §3.1 rule 4).
 */
import type { MissionTypeDoc } from "./types.ts"

export const BUILTIN_MISSION_TYPES_SHA256 = "f811045932f275204f5c909d07f36280e506ce6f5f19c80c73dc512c9f4b2ca3"

export const BUILTIN_MISSION_TYPES: readonly MissionTypeDoc[] = [
  {
    "$schema": "studio.mission-type/v1",
    "id": "research",
    "version": 1,
    "name": {
      "id": "Riset",
      "en": "Research"
    },
    "phases": [
      {
        "id": "identification",
        "name": {
          "id": "Identifikasi",
          "en": "Identification"
        },
        "order": 1,
        "kinds": [
          "intake",
          "spec",
          "gate"
        ]
      },
      {
        "id": "research",
        "name": {
          "id": "Riset",
          "en": "Research"
        },
        "order": 2,
        "kinds": [
          "research",
          "gate"
        ]
      },
      {
        "id": "synthesis",
        "name": {
          "id": "Sintesis",
          "en": "Synthesis"
        },
        "order": 3,
        "kinds": [
          "synthesis",
          "spec",
          "review",
          "gate"
        ]
      },
      {
        "id": "report",
        "name": {
          "id": "Laporan",
          "en": "Report"
        },
        "order": 4,
        "kinds": [
          "report",
          "review",
          "gate"
        ]
      }
    ]
  },
  {
    "$schema": "studio.mission-type/v1",
    "id": "debug",
    "version": 1,
    "name": {
      "id": "Debug",
      "en": "Debug"
    },
    "phases": [
      {
        "id": "reproduce",
        "name": {
          "id": "Reproduksi",
          "en": "Reproduce"
        },
        "order": 1,
        "kinds": [
          "intake",
          "reproduce",
          "test"
        ]
      },
      {
        "id": "diagnose",
        "name": {
          "id": "Diagnosis",
          "en": "Diagnose"
        },
        "order": 2,
        "kinds": [
          "diagnose",
          "gate"
        ]
      },
      {
        "id": "fix",
        "name": {
          "id": "Perbaikan",
          "en": "Fix"
        },
        "order": 3,
        "kinds": [
          "fix",
          "test",
          "gate"
        ]
      },
      {
        "id": "verify",
        "name": {
          "id": "Verifikasi",
          "en": "Verify"
        },
        "order": 4,
        "kinds": [
          "test",
          "review",
          "gate",
          "report"
        ]
      }
    ]
  },
  {
    "$schema": "studio.mission-type/v1",
    "id": "feature-release",
    "version": 1,
    "name": {
      "id": "Fitur / rilis",
      "en": "Feature / release"
    },
    "phases": [
      {
        "id": "identification",
        "name": {
          "id": "Identifikasi",
          "en": "Identification"
        },
        "order": 1,
        "kinds": [
          "intake",
          "spec",
          "gate"
        ]
      },
      {
        "id": "research",
        "name": {
          "id": "Riset",
          "en": "Research"
        },
        "order": 2,
        "kinds": [
          "research",
          "spec",
          "gate",
          "test"
        ]
      },
      {
        "id": "implementation",
        "name": {
          "id": "Implementasi",
          "en": "Implementation"
        },
        "order": 3,
        "kinds": [
          "implementation",
          "fix",
          "test",
          "gate",
          "review"
        ]
      },
      {
        "id": "verification",
        "name": {
          "id": "Verifikasi",
          "en": "Verification"
        },
        "order": 4,
        "kinds": [
          "test",
          "review",
          "gate"
        ]
      },
      {
        "id": "release",
        "name": {
          "id": "Rilis",
          "en": "Release"
        },
        "order": 5,
        "kinds": [
          "release",
          "report",
          "gate",
          "review"
        ]
      }
    ]
  },
  {
    "$schema": "studio.mission-type/v1",
    "id": "document",
    "version": 1,
    "name": {
      "id": "Dokumen",
      "en": "Document"
    },
    "phases": [
      {
        "id": "brief",
        "name": {
          "id": "Brief",
          "en": "Brief"
        },
        "order": 1,
        "kinds": [
          "intake",
          "research",
          "spec"
        ]
      },
      {
        "id": "draft",
        "name": {
          "id": "Draf",
          "en": "Draft"
        },
        "order": 2,
        "kinds": [
          "draft",
          "research",
          "gate"
        ]
      },
      {
        "id": "review",
        "name": {
          "id": "Tinjauan",
          "en": "Review"
        },
        "order": 3,
        "kinds": [
          "review",
          "test",
          "gate"
        ]
      },
      {
        "id": "publish",
        "name": {
          "id": "Terbit",
          "en": "Publish"
        },
        "order": 4,
        "kinds": [
          "publish",
          "release",
          "report",
          "gate"
        ]
      }
    ]
  }
]
