import { NodeHttpServer } from "@effect/platform-node"
import Http from "node:http"
import { Layer } from "effect"
import { FetchHttpClient, HttpServer } from "effect/unstable/http"

// 1.1.1 F22/F23/F24: `NodeHttpServer.layerTest` listens on every interface (`::`) while its client always calls
// `127.0.0.1:<port>`, so another process that binds `127.0.0.1` on the same port number takes the request (and answers
// 401). The same test server and client, bound to the address the client calls.
export const loopbackServer = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false }))),
  ),
  Layer.provideMerge(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 })),
)
