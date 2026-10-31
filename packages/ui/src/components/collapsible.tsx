import { Collapsible as Kobalte, CollapsibleRootProps } from "@kobalte/core/collapsible"
import { ComponentProps, createSignal, ParentProps, splitProps } from "solid-js"
import { Icon } from "./icon"

export interface CollapsibleProps extends ParentProps<CollapsibleRootProps> {
  class?: string
  classList?: ComponentProps<"div">["classList"]
  variant?: "normal" | "ghost"
}

function CollapsibleRoot(props: CollapsibleProps) {
  const [local, others] = splitProps(props, ["class", "classList", "variant", "onOpenChange"])
  // Timeline rows remount as they scroll back into view; only an opening someone just asked for should animate.
  const [toggled, setToggled] = createSignal(false)
  return (
    <Kobalte
      data-component="collapsible"
      data-variant={local.variant || "normal"}
      data-toggled={toggled() ? "" : undefined}
      onOpenChange={(open) => {
        setToggled(true)
        local.onOpenChange?.(open)
      }}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}

function CollapsibleTrigger(props: ComponentProps<typeof Kobalte.Trigger>) {
  return <Kobalte.Trigger data-slot="collapsible-trigger" {...props} />
}

function CollapsibleContent(props: ComponentProps<typeof Kobalte.Content>) {
  return <Kobalte.Content data-slot="collapsible-content" {...props} />
}

function CollapsibleArrow(props?: ComponentProps<"div">) {
  return (
    <div data-slot="collapsible-arrow" {...(props || {})}>
      <span data-slot="collapsible-arrow-icon">
        <Icon name="chevron-down" size="small" />
      </span>
    </div>
  )
}

export const Collapsible = Object.assign(CollapsibleRoot, {
  Arrow: CollapsibleArrow,
  Trigger: CollapsibleTrigger,
  Content: CollapsibleContent,
})
