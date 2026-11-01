import { DialogConfirm } from "../ui/dialog-confirm"

const SHOWN = 6

/** Asks once when a folder has its own code or rules to load. Enter on its own means "Not now". */
export function DialogTrust(props: {
  directory: string
  items: readonly { label: string }[]
  onDecide: (decision: "trust" | "later") => void
}) {
  const more = props.items.length - SHOWN
  const message = [
    props.directory,
    ...props.items.slice(0, SHOWN).map((item) => `- ${item.label}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
  ].join("\n")
  return (
    <DialogConfirm
      title="This folder wants to run its own code or change what Swarm may do"
      message={message}
      label="Not now"
      confirmLabel="Trust"
      start="cancel"
      onConfirm={() => props.onDecide("trust")}
      onCancel={() => props.onDecide("later")}
    />
  )
}
