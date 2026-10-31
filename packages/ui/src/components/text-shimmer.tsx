import { type ValidComponent } from "solid-js"
import { Dynamic } from "solid-js/web"

export const TextShimmer = <T extends ValidComponent = "span">(props: {
  text: string
  class?: string
  as?: T
  active?: boolean
}) => (
  <Dynamic
    component={props.as ?? "span"}
    data-component="text-shimmer"
    data-active={(props.active ?? true) ? "true" : "false"}
    class={props.class}
  >
    {props.text ?? ""}
  </Dynamic>
)
