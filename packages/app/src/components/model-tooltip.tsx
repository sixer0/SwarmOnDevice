import { Show, type Component, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { formatPrice, hasPrice, isOnDevice, repriceSession } from "./model-price"

type InputKey = "text" | "image" | "audio" | "video" | "pdf"
type InputMap = Record<InputKey, boolean>

type ModelInfo = {
  id: string
  name: string
  provider: {
    name: string
    options?: Record<string, unknown>
  }
  cost?: { input: number; output: number; cache?: { read: number; write: number } }
  capabilities?: {
    reasoning: boolean
    toolcall?: boolean
    input: InputMap
  }
  modalities?: {
    input: Array<string>
  }
  reasoning?: boolean
  limit: {
    context: number
  }
}

function ModelTooltipRow(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.name}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

type SessionTokens = Parameters<typeof repriceSession>[0]

export const ModelTooltip: Component<{
  model: ModelInfo
  latest?: boolean
  free?: boolean
  v2?: boolean
  sessionTokens?: SessionTokens
}> = (props) => {
  const language = useLanguage()
  const sourceName = (model: ModelInfo) => {
    const value = `${model.id} ${model.name}`.toLowerCase()

    if (/claude|anthropic/.test(value)) return language.t("model.provider.anthropic")
    if (/gpt|o[1-4]|codex|openai/.test(value)) return language.t("model.provider.openai")
    if (/gemini|palm|bard|google/.test(value)) return language.t("model.provider.google")
    if (/grok|xai/.test(value)) return language.t("model.provider.xai")
    if (/llama|meta/.test(value)) return language.t("model.provider.meta")

    return model.provider.name
  }
  const inputLabel = (value: string) => {
    if (value === "text") return language.t("model.input.text")
    if (value === "image") return language.t("model.input.image")
    if (value === "audio") return language.t("model.input.audio")
    if (value === "video") return language.t("model.input.video")
    if (value === "pdf") return language.t("model.input.pdf")
    return value
  }
  const title = () => {
    const tags: Array<string> = []
    if (props.latest) tags.push(language.t("model.tag.latest"))
    if (props.free) tags.push(language.t("model.tag.free"))
    const suffix = tags.length ? ` (${tags.join(", ")})` : ""
    return `${sourceName(props.model)} ${props.model.name}${suffix}`
  }
  const name = () => {
    const tags: Array<string> = []
    if (props.latest) tags.push(language.t("model.tag.latest"))
    if (props.free) tags.push(language.t("model.tag.free"))
    const suffix = tags.length ? ` (${tags.join(", ")})` : ""
    return `${props.model.name}${suffix}`
  }
  const inputs = () => {
    if (props.model.capabilities) {
      const input = props.model.capabilities.input
      const order: Array<InputKey> = ["text", "image", "audio", "video", "pdf"]
      const entries = order.filter((key) => input[key]).map((key) => inputLabel(key))
      return entries.length ? entries.join(", ") : undefined
    }
    const raw = props.model.modalities?.input
    if (!raw) return
    const entries = raw.map((value) => inputLabel(value))
    return entries.length ? entries.join(", ") : undefined
  }
  const reasoning = () => {
    if (props.model.capabilities)
      return props.model.capabilities.reasoning
        ? language.t("model.tooltip.reasoning.allowed")
        : language.t("model.tooltip.reasoning.none")
    return props.model.reasoning
      ? language.t("model.tooltip.reasoning.allowed")
      : language.t("model.tooltip.reasoning.none")
  }
  const context = () => language.t("model.tooltip.context", { limit: props.model.limit.context.toLocaleString() })
  const contextLimit = () => props.model.limit.context.toLocaleString(language.intl())
  const price = () => {
    if (isOnDevice(props.model)) return language.t("model.tooltip.local.value")
    if (!hasPrice(props.model)) return
    return language.t("model.tooltip.price.value", {
      input: formatPrice(props.model.cost!.input),
      output: formatPrice(props.model.cost!.output),
    })
  }
  const priceName = () =>
    isOnDevice(props.model) ? language.t("model.tooltip.cost.label") : language.t("model.tooltip.price.label")
  const sessionCost = () => {
    if (!props.sessionTokens || !hasPrice(props.model)) return
    const value = repriceSession(props.sessionTokens, props.model.cost!)
    return `$${value < 0.01 ? "0.01" : value.toFixed(2)}`
  }
  const noTools = () => props.model.capabilities?.toolcall === false

  if (props.v2) {
    return (
      <div class="flex w-[240px] flex-col gap-2">
        <ModelTooltipRow name={language.t("model.tooltip.model")} value={name()} />
        <ModelTooltipRow name={language.t("model.tooltip.provider")} value={props.model.provider.name} />
        <Show when={inputs()}>
          {(value) => <ModelTooltipRow name={language.t("model.tooltip.inputs")} value={value()} />}
        </Show>
        <ModelTooltipRow name={language.t("model.tooltip.reasoning")} value={reasoning()} />
        <Show when={props.model.limit.context > 0}>
          <ModelTooltipRow name={language.t("model.tooltip.context.label")} value={contextLimit()} />
        </Show>
        <Show when={noTools()}>
          <ModelTooltipRow name={language.t("model.tooltip.tools.label")} value={language.t("model.tooltip.tools.none")} />
        </Show>
        <Show when={price()}>{(value) => <ModelTooltipRow name={priceName()} value={value()} />}</Show>
        <Show when={sessionCost()}>
          {(value) => <ModelTooltipRow name={language.t("model.tooltip.sessionCost.label")} value={value()} />}
        </Show>
      </div>
    )
  }

  return (
    <div class="flex flex-col gap-1 py-1">
      <div class="text-13-medium">{title()}</div>
      <Show when={inputs()}>
        {(value) => (
          <div class="text-12-regular text-text-invert-base">
            {language.t("model.tooltip.allows", { inputs: value() })}
          </div>
        )}
      </Show>
      <div class="text-12-regular text-text-invert-base">{reasoning()}</div>
      <Show when={props.model.limit.context > 0}>
        <div class="text-12-regular text-text-invert-base">{context()}</div>
      </Show>
      <Show when={noTools()}>
        <div class="text-12-regular text-text-invert-base">{language.t("model.tooltip.tools.none")}</div>
      </Show>
      <Show when={price()}>
        {(value) => (
          <div class="text-12-regular text-text-invert-base">
            {priceName()}: {value()}
          </div>
        )}
      </Show>
      <Show when={sessionCost()}>
        {(value) => (
          <div class="text-12-regular text-text-invert-base">
            {language.t("model.tooltip.sessionCost.label")}: {value()}
          </div>
        )}
      </Show>
    </div>
  )
}
