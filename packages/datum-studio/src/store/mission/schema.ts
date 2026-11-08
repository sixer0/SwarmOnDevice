/**
 * `studio.mission/v1` (draft 2020-12), copied from the row 118 schema file
 * /private/tmp/claude-501/row118/schema/studio.mission.v1.schema.json (spec masterplan/01_specs_mission_contract.md
 * §6.1, Appendix A). Canonical sha256 (keys sorted, no whitespace) is MISSION_SCHEMA_V1_SHA256; the test checks it.
 * Do not edit: any change is a new schema id (studio.mission/v2), spec §6.1 change rule.
 * Exception, row 166 (user finding 2026-11-08, before 1.2.0 shipped): $defs/Model tiers are the GSP AI tiers
 * thinker | worker | worker-fast | inherit (reason required below thinker), edited in place with the id kept and the
 * sha updated; store migration 0005 moves stored rows (opus -> thinker, sonnet -> worker).
 */
export const MISSION_SCHEMA_V1_ID = "studio.mission/v1"
export const MISSION_SCHEMA_V1_SHA256 = "02e27723814943e7578f4327e3e31f3536d37b3a309a1f28cbd6e9378307edcd"

export const MISSION_SCHEMA_V1: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "studio.mission/v1",
  "title": "DATUM Studio mission contract v1 (Swarm 1.2.0, U19/U20)",
  "oneOf": [
    {
      "$ref": "#/$defs/MissionDoc"
    },
    {
      "$ref": "#/$defs/MissionTypeDoc"
    },
    {
      "$ref": "#/$defs/ReportEnvelope"
    },
    {
      "$ref": "#/$defs/StatusSnapshot"
    }
  ],
  "$defs": {
    "MissionId": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}[_-][a-z0-9][a-z0-9_-]{0,80}$"
    },
    "RowId": {
      "type": "string",
      "pattern": "^[1-9][0-9]{0,3}[a-z]?$"
    },
    "DecisionId": {
      "type": "string",
      "pattern": "^[UC][1-9][0-9]{0,3}$"
    },
    "FindingId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
    },
    "Actor": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
    },
    "Slug": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,31}$"
    },
    "Instant": {
      "type": "string",
      "pattern": "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d{1,3})?Z$"
    },
    "Date": {
      "type": "string",
      "pattern": "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$"
    },
    "Line": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300,
      "pattern": "^[^\\u0000-\\u001f]+$"
    },
    "Cell": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000,
      "pattern": "^[^\\u0000-\\u001f]+$"
    },
    "LongText": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8000,
      "pattern": "^[^\\u0000-\\u001f]+$"
    },
    "Path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "pattern": "^(?!.*(^|/)\\.\\.(/|$))[^\\u0000-\\u001f]+$"
    },
    "Bilingual": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "en"
      ],
      "properties": {
        "id": {
          "$ref": "#/$defs/Line"
        },
        "en": {
          "$ref": "#/$defs/Line"
        }
      }
    },
    "RowKind": {
      "enum": [
        "intake",
        "research",
        "spec",
        "synthesis",
        "reproduce",
        "diagnose",
        "fix",
        "implementation",
        "draft",
        "test",
        "gate",
        "review",
        "release",
        "publish",
        "report"
      ]
    },
    "MissionStatus": {
      "enum": [
        "draft",
        "approved",
        "running",
        "paused",
        "done",
        "cancelled"
      ]
    },
    "RowStatus": {
      "enum": [
        "pending",
        "running",
        "needs-review",
        "blocked",
        "done",
        "dropped"
      ]
    },
    "Dep": {
      "type": "string",
      "pattern": "^[1-9][0-9]{0,3}[a-z]?:[BC]$"
    },
    "Phase": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "name",
        "order",
        "kinds"
      ],
      "properties": {
        "id": {
          "$ref": "#/$defs/Slug"
        },
        "name": {
          "$ref": "#/$defs/Bilingual"
        },
        "order": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12
        },
        "kinds": {
          "type": "array",
          "minItems": 1,
          "maxItems": 15,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/RowKind"
          }
        }
      }
    },
    "MissionTypeDoc": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "$schema",
        "id",
        "version",
        "name",
        "phases"
      ],
      "properties": {
        "$schema": {
          "const": "studio.mission-type/v1"
        },
        "id": {
          "$ref": "#/$defs/Slug"
        },
        "version": {
          "type": "integer",
          "minimum": 1
        },
        "name": {
          "$ref": "#/$defs/Bilingual"
        },
        "phases": {
          "type": "array",
          "minItems": 1,
          "maxItems": 12,
          "items": {
            "$ref": "#/$defs/Phase"
          }
        }
      }
    },
    "SessionLink": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "client",
        "ref"
      ],
      "properties": {
        "client": {
          "enum": [
            "swarm",
            "claude"
          ]
        },
        "ref": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_.:-]{1,128}$"
        },
        "role": {
          "enum": [
            "controller",
            "driver",
            "viewer"
          ]
        },
        "linkedAt": {
          "$ref": "#/$defs/Instant"
        }
      },
      "if": {
        "properties": {
          "client": {
            "const": "swarm"
          }
        }
      },
      "then": {
        "properties": {
          "ref": {
            "pattern": "^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$",
            "type": "string"
          }
        }
      }
    },
    "Project": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "dir"
      ],
      "properties": {
        "dir": {
          "type": "string",
          "minLength": 2,
          "maxLength": 1024,
          "pattern": "^/[^\\u0000-\\u001f]*$"
        },
        "swarmProjectId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]{1,128}$"
        }
      }
    },
    "Model": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "tier"
      ],
      "properties": {
        "tier": {
          "enum": [
            "thinker",
            "worker",
            "worker-fast",
            "inherit"
          ]
        },
        "reason": {
          "$ref": "#/$defs/Line"
        }
      },
      "if": {
        "properties": {
          "tier": {
            "enum": [
              "worker",
              "worker-fast"
            ]
          }
        }
      },
      "then": {
        "required": [
          "reason"
        ],
        "properties": {
          "reason": true
        }
      }
    },
    "Ownership": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "text"
      ],
      "properties": {
        "text": {
          "$ref": "#/$defs/Cell"
        },
        "paths": {
          "type": "array",
          "maxItems": 64,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "path",
              "state"
            ],
            "properties": {
              "path": {
                "$ref": "#/$defs/Path"
              },
              "state": {
                "enum": [
                  "exists",
                  "new",
                  "unknown"
                ]
              }
            }
          }
        }
      }
    },
    "ReportRef": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "documentId",
        "revisionNo",
        "kind"
      ],
      "properties": {
        "documentId": {
          "type": "string",
          "pattern": "^[a-z0-9]{20,40}$"
        },
        "revisionNo": {
          "type": "integer",
          "minimum": 1
        },
        "kind": {
          "enum": [
            "row",
            "delegation"
          ]
        },
        "status": {
          "enum": [
            "draft",
            "complete",
            "partial",
            "blocked",
            "needs-review"
          ]
        }
      }
    },
    "Row": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "phase",
        "kind",
        "title",
        "agent",
        "model",
        "deps",
        "status",
        "output",
        "verification"
      ],
      "properties": {
        "id": {
          "$ref": "#/$defs/RowId"
        },
        "phase": {
          "$ref": "#/$defs/Slug"
        },
        "kind": {
          "$ref": "#/$defs/RowKind"
        },
        "title": {
          "$ref": "#/$defs/Cell"
        },
        "agent": {
          "$ref": "#/$defs/Actor"
        },
        "model": {
          "$ref": "#/$defs/Model"
        },
        "ownership": {
          "$ref": "#/$defs/Ownership"
        },
        "deps": {
          "type": "array",
          "maxItems": 64,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/Dep"
          }
        },
        "size": {
          "enum": [
            "S",
            "M",
            null
          ]
        },
        "status": {
          "$ref": "#/$defs/RowStatus"
        },
        "output": {
          "$ref": "#/$defs/Cell"
        },
        "verification": {
          "$ref": "#/$defs/Cell"
        },
        "resources": {
          "type": "array",
          "maxItems": 16,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/Line"
          }
        },
        "checks": {
          "$ref": "#/$defs/Line"
        },
        "review": {
          "enum": [
            "gate",
            "none"
          ]
        },
        "note": {
          "$ref": "#/$defs/Cell"
        },
        "decision": {
          "$ref": "#/$defs/DecisionId"
        },
        "createdAt": {
          "$ref": "#/$defs/Instant"
        },
        "updatedAt": {
          "$ref": "#/$defs/Instant"
        },
        "startedAt": {
          "$ref": "#/$defs/Instant"
        },
        "finishedAt": {
          "$ref": "#/$defs/Instant"
        },
        "reports": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "$ref": "#/$defs/ReportRef"
          }
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "enum": [
                  "dropped",
                  "blocked"
                ]
              }
            }
          },
          "then": {
            "required": [
              "note"
            ],
            "properties": {
              "note": true
            }
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "enum": [
                  "pending",
                  "running",
                  "needs-review",
                  "blocked"
                ]
              }
            }
          },
          "then": {
            "properties": {
              "size": {
                "enum": [
                  "S",
                  "M"
                ]
              }
            },
            "required": [
              "size"
            ]
          }
        }
      ]
    },
    "Decision": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "by",
        "date",
        "text"
      ],
      "properties": {
        "id": {
          "$ref": "#/$defs/DecisionId"
        },
        "by": {
          "enum": [
            "user",
            "controller"
          ]
        },
        "date": {
          "$ref": "#/$defs/Date"
        },
        "text": {
          "$ref": "#/$defs/LongText"
        },
        "rows": {
          "type": "array",
          "maxItems": 64,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/RowId"
          }
        },
        "supersedes": {
          "type": "array",
          "maxItems": 16,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/DecisionId"
          }
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "by": {
                "const": "user"
              }
            }
          },
          "then": {
            "properties": {
              "id": {
                "pattern": "^U",
                "type": "string"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "by": {
                "const": "controller"
              }
            }
          },
          "then": {
            "properties": {
              "id": {
                "pattern": "^C",
                "type": "string"
              }
            }
          }
        }
      ]
    },
    "Finding": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "severity",
        "title",
        "sourceRow",
        "status"
      ],
      "properties": {
        "id": {
          "$ref": "#/$defs/FindingId"
        },
        "severity": {
          "enum": [
            "critical",
            "high",
            "medium",
            "low",
            "info"
          ]
        },
        "title": {
          "$ref": "#/$defs/Cell"
        },
        "sourceRow": {
          "$ref": "#/$defs/RowId"
        },
        "ownerRow": {
          "$ref": "#/$defs/RowId"
        },
        "status": {
          "enum": [
            "open",
            "fixed",
            "accepted",
            "deferred"
          ]
        },
        "decision": {
          "$ref": "#/$defs/DecisionId"
        },
        "evidence": {
          "$ref": "#/$defs/Cell"
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "enum": [
                  "accepted",
                  "deferred"
                ]
              }
            }
          },
          "then": {
            "required": [
              "decision"
            ],
            "properties": {
              "decision": true
            }
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "const": "open"
              }
            }
          },
          "then": {
            "required": [
              "ownerRow"
            ],
            "properties": {
              "ownerRow": true
            }
          }
        }
      ]
    },
    "Lock": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "resource",
        "row",
        "holder",
        "acquiredAt"
      ],
      "properties": {
        "resource": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9._/-]{0,79}$"
        },
        "row": {
          "$ref": "#/$defs/RowId"
        },
        "holder": {
          "$ref": "#/$defs/Actor"
        },
        "acquiredAt": {
          "$ref": "#/$defs/Instant"
        },
        "releasedAt": {
          "$ref": "#/$defs/Instant"
        }
      }
    },
    "MissionDoc": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "$schema",
        "id",
        "title",
        "type",
        "typeVersion",
        "status",
        "owner",
        "project",
        "rows"
      ],
      "properties": {
        "$schema": {
          "const": "studio.mission/v1"
        },
        "id": {
          "$ref": "#/$defs/MissionId"
        },
        "title": {
          "$ref": "#/$defs/Line"
        },
        "type": {
          "$ref": "#/$defs/Slug"
        },
        "typeVersion": {
          "type": "integer",
          "minimum": 1
        },
        "status": {
          "$ref": "#/$defs/MissionStatus"
        },
        "supersededBy": {
          "$ref": "#/$defs/MissionId"
        },
        "owner": {
          "$ref": "#/$defs/Actor"
        },
        "project": {
          "$ref": "#/$defs/Project"
        },
        "createdAt": {
          "$ref": "#/$defs/Instant"
        },
        "updatedAt": {
          "$ref": "#/$defs/Instant"
        },
        "approvedAt": {
          "$ref": "#/$defs/Instant"
        },
        "approvalDecision": {
          "$ref": "#/$defs/DecisionId"
        },
        "closedAt": {
          "$ref": "#/$defs/Instant"
        },
        "sessions": {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/SessionLink"
          }
        },
        "rows": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "$ref": "#/$defs/Row"
          }
        },
        "decisions": {
          "type": "array",
          "maxItems": 1000,
          "items": {
            "$ref": "#/$defs/Decision"
          }
        },
        "findings": {
          "type": "array",
          "maxItems": 1000,
          "items": {
            "$ref": "#/$defs/Finding"
          }
        },
        "locks": {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/Lock"
          }
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "enum": [
                  "approved",
                  "running",
                  "paused",
                  "done"
                ]
              }
            },
            "required": [
              "status"
            ]
          },
          "then": {
            "required": [
              "approvedAt",
              "approvalDecision"
            ],
            "properties": {
              "approvedAt": true,
              "approvalDecision": true
            }
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "enum": [
                  "done",
                  "cancelled"
                ]
              }
            },
            "required": [
              "status"
            ]
          },
          "then": {
            "required": [
              "closedAt"
            ],
            "properties": {
              "closedAt": true
            }
          }
        },
        {
          "if": {
            "required": [
              "supersededBy"
            ],
            "properties": {
              "supersededBy": true
            }
          },
          "then": {
            "properties": {
              "status": {
                "const": "cancelled"
              }
            }
          }
        }
      ]
    },
    "ReportEnvelope": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "$schema",
        "mission",
        "kind",
        "docKey",
        "status"
      ],
      "properties": {
        "$schema": {
          "const": "studio.mission-report/v1"
        },
        "mission": {
          "$ref": "#/$defs/MissionId"
        },
        "kind": {
          "enum": [
            "row",
            "delegation"
          ]
        },
        "row": {
          "$ref": "#/$defs/RowId"
        },
        "docKey": {
          "type": "string",
          "maxLength": 64,
          "pattern": "^(row-[1-9][0-9]{0,3}[a-z]?|delegation)$"
        },
        "owner": {
          "$ref": "#/$defs/Actor"
        },
        "status": {
          "enum": [
            "draft",
            "complete",
            "partial",
            "blocked",
            "needs-review"
          ]
        },
        "reportedAt": {
          "$ref": "#/$defs/Instant"
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "row"
              }
            }
          },
          "then": {
            "required": [
              "row"
            ],
            "properties": {
              "docKey": {
                "pattern": "^row-",
                "type": "string"
              },
              "row": true
            }
          },
          "else": {
            "not": {
              "required": [
                "row"
              ],
              "properties": {
                "row": true
              }
            },
            "properties": {
              "docKey": {
                "const": "delegation"
              }
            }
          }
        }
      ]
    },
    "StatusSnapshot": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "$schema",
        "mission",
        "takenAt",
        "missionStatus",
        "counts",
        "waves"
      ],
      "properties": {
        "$schema": {
          "const": "studio.mission-status/v1"
        },
        "mission": {
          "$ref": "#/$defs/MissionId"
        },
        "takenAt": {
          "$ref": "#/$defs/Instant"
        },
        "reason": {
          "enum": [
            "approve",
            "status",
            "export",
            "manual"
          ]
        },
        "missionStatus": {
          "$ref": "#/$defs/MissionStatus"
        },
        "counts": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "pending",
            "running",
            "needs-review",
            "blocked",
            "done",
            "dropped"
          ],
          "properties": {
            "pending": {
              "type": "integer",
              "minimum": 0
            },
            "running": {
              "type": "integer",
              "minimum": 0
            },
            "needs-review": {
              "type": "integer",
              "minimum": 0
            },
            "blocked": {
              "type": "integer",
              "minimum": 0
            },
            "done": {
              "type": "integer",
              "minimum": 0
            },
            "dropped": {
              "type": "integer",
              "minimum": 0
            }
          }
        },
        "waves": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "wave",
              "rows"
            ],
            "properties": {
              "wave": {
                "type": "integer",
                "minimum": 1
              },
              "rows": {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/RowId"
                }
              }
            }
          }
        },
        "ready": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RowId"
          }
        },
        "locks": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Lock"
          }
        }
      }
    }
  }
}
