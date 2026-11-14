import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { DesktopNonce } from "@/server/desktop-nonce"
import { InstanceHttpApi } from "../api"
import { ApiConfigPersonOnlyError, CONFIG_PERSON_ONLY, CONFIG_PERSON_ONLY_MESSAGE } from "../groups/config"
import { markInstanceForDisposal } from "../lifecycle"

type DesktopNonceHeaders = { readonly [DesktopNonce.HEADER]?: string | undefined }

// 1.2.8 row 40g (SR8-04, AC-SEC04): a config write rewrites `permission`, `mcp` and the skill paths, so on a server the
// desktop app started (it holds the per-launch nonce) only the person at the app may make one. Same helper as the
// 1.2.6 SEC-06 revert route (`DesktopNonce.matches`). A server holding no nonce (`swarm serve`) is unchanged: there the
// person is the only UI. Runs before any read or write, so a refusal touches nothing.
export const configPersonOnly = (headers: DesktopNonceHeaders) =>
  Effect.gen(function* () {
    if (!DesktopNonce.present()) return
    if (DesktopNonce.matches(headers[DesktopNonce.HEADER])) return
    return yield* new ApiConfigPersonOnlyError({
      name: "ConfigPersonOnlyError",
      data: { code: CONFIG_PERSON_ONLY, message: CONFIG_PERSON_ONLY_MESSAGE },
    })
  })

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configPersonOnly(ctx.headers)
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
