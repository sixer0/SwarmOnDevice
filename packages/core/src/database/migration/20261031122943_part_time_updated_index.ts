import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261031122943_part_time_updated_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`part_time_updated_idx\` ON \`part\` (\`time_updated\`,\`id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
