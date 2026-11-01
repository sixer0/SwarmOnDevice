/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function frame(items: { label: string }[]) {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const [{ DialogTrust }, { ArgsProvider }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }, { ToastProvider }, dialogs, keymaps] =
    await Promise.all([
      import("../../../src/component/dialog-trust"),
      import("../../../src/context/args"),
      import("../../../src/context/kv"),
      import("../../../src/context/theme"),
      import("../../../src/config"),
      import("../../../src/ui/toast"),
      import("../../../src/ui/dialog"),
      import("../../../src/keymap"),
    ])

  function Show() {
    const dialog = dialogs.useDialog()
    onMount(() => dialog.replace(() => <DialogTrust directory="/work/folder" items={items} onDecide={() => {}} />))
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    onCleanup(keymaps.registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <keymaps.OpencodeKeymapProvider keymap={keymap}>
          <ArgsProvider>
            <KVProvider>
              <ToastProvider>
                <TuiConfigProvider config={config}>
                  <ThemeProvider mode="dark">
                    <dialogs.DialogProvider>
                      <Show />
                    </dialogs.DialogProvider>
                  </ThemeProvider>
                </TuiConfigProvider>
              </ToastProvider>
            </KVProvider>
          </ArgsProvider>
        </keymaps.OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  try {
    const state = { frame: "" }
    const end = Date.now() + 3000
    while (Date.now() < end && !state.frame.includes("/work/folder")) {
      await Bun.sleep(20)
      await app.renderOnce()
      state.frame = app.captureCharFrame()
    }
    return state.frame
  } finally {
    app.renderer.destroy()
  }
}

test("an item's text is shown as it is, and markup in it means nothing", async () => {
  const shown = await frame([{ label: `Load plugin <b>bold</b> {red}[31m *x*` }])
  expect(shown).toContain(`- Load plugin <b>bold</b> {red}[31m *x*`)
})

test("the dialog shows the server's list and adds no count of its own", async () => {
  const items = [...Array.from({ length: 6 }, (_, index) => ({ label: `Load plugin p${index}` })), { label: "and 494 more" }]
  const shown = await frame(items)
  for (const item of items) expect(shown).toContain(`- ${item.label}`)
  expect(shown.match(/more/g)).toHaveLength(1)
})
