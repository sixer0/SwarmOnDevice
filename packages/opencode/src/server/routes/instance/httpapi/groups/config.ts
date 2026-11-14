import { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Provider } from "@/provider/provider"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { DesktopNonceHeaders } from "./autonomy"
import { described } from "./metadata"

const root = "/config"

// 1.2.8 row 40g (SR8-04, AC-SEC04; N8-394): on a server the desktop app started, a config write is taken only with the
// per-launch desktop nonce. The password is readable by an agent's shell; the nonce is not. Shared by `PATCH /config`
// and `PATCH /global/config`.
export const CONFIG_PERSON_ONLY = "CONFIG_PERSON_ONLY"
export const CONFIG_PERSON_ONLY_MESSAGE = "config changes are only taken from the Swarm desktop app"

export class ApiConfigPersonOnlyError extends Schema.ErrorClass<ApiConfigPersonOnlyError>("ConfigPersonOnlyError")(
  {
    name: Schema.Literal("ConfigPersonOnlyError"),
    data: Schema.Struct({
      code: Schema.Literal(CONFIG_PERSON_ONLY),
      message: Schema.String,
    }),
  },
  { httpApiStatus: 403 },
) {}

export const PERSON_ONLY_NOTE =
  " While the server holds the desktop app's per-launch nonce, the request needs the matching x-swarm-desktop-nonce header, else 403 CONFIG_PERSON_ONLY; a server started without the app takes it as before."

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current Swarm configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          headers: DesktopNonceHeaders,
          payload: ConfigV1.Info,
          success: described(ConfigV1.Info, "Successfully updated config"),
          error: [HttpApiError.BadRequest, ApiConfigPersonOnlyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update Swarm configuration settings and preferences." + PERSON_ONLY_NOTE,
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "swarm experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
