import { createEffect, type ParentProps } from "solid-js"
import { Persist, removePersisted } from "@/utils/persist"
import { useGlobal } from "./global"
import { usePlatform } from "./platform"

/**
 * The renderer used to answer permission prompts by itself, from a preference stored here per server. The server holds
 * autonomous mode now and nothing reads that preference, so each server's copy is dropped whatever it holds.
 */
export function PermissionProvider(props: ParentProps) {
  const global = useGlobal()
  const platform = usePlatform()

  createEffect(() => {
    global.servers.list().forEach((conn) => {
      const target = Persist.serverGlobal(global.ensureServerCtx(conn).sdk.scope, "permission", ["permission.v3"])
      removePersisted(target, platform)
      target.legacy?.forEach((key) => removePersisted({ key }, platform))
    })
  })

  return props.children
}
