/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

test("the spend question names the amount and offers to continue or stop", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const [
    { PermissionPrompt },
    { ArgsProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { DialogProvider },
    { SDKProvider },
    { PermissionProvider },
    { ProjectProvider },
    { ExitProvider },
    { SyncProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { LocationProvider },
  ] = await Promise.all([
    import("../../../src/routes/session/permission"),
    import("../../../src/context/args"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/ui/dialog"),
    import("../../../src/context/sdk"),
    import("../../../src/context/permission"),
    import("../../../src/context/project"),
    import("../../../src/context/exit"),
    import("../../../src/context/sync"),
    import("../../../src/keymap"),
    import("../../../src/context/location"),
  ])
  const request: PermissionRequest = {
    id: "per_spend",
    sessionID: "ses_paid",
    permission: "spend_limit",
    patterns: ["$12.04 of $10.00"],
    metadata: { spent: 12.04, limit: 10, next: 22.04 },
    always: [],
  }
  const calls = createFetch()
  const events = createEventSource()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <ArgsProvider>
            <KVProvider>
              <ToastProvider>
                <TuiConfigProvider config={config}>
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <ExitProvider exit={() => {}}>
                          <SyncProvider>
                            <ThemeProvider mode="dark">
                              <LocationProvider>
                                <DialogProvider>
                                  <PermissionPrompt request={request} />
                                </DialogProvider>
                              </LocationProvider>
                            </ThemeProvider>
                          </SyncProvider>
                        </ExitProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </ToastProvider>
            </KVProvider>
          </ArgsProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  try {
    let frame = ""
    const end = Date.now() + 3000
    while (Date.now() < end && !frame.includes("Spend limit reached")) {
      await Bun.sleep(20)
      await app.renderOnce()
      frame = app.captureCharFrame()
    }
    expect(frame).toContain("Spend limit reached")
    expect(frame).toContain("$12.04 of $10.00")
    expect(frame).toContain("Continue to $22.04")
    expect(frame).toContain("Stop here")
    // Money is not something "always" applies to.
    expect(frame).not.toContain("Allow always")
  } finally {
    app.renderer.destroy()
  }
})
