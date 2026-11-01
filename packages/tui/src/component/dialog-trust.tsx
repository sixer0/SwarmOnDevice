import { DialogConfirm } from "../ui/dialog-confirm"

/**
 * Asks once when a folder has its own code or rules to load. Enter on its own means "Not now". The server cleans and caps the
 * items, including the "and N more" row, so they are shown as they come.
 */
export function DialogTrust(props: {
  directory: string
  items: readonly { label: string }[]
  onDecide: (decision: "trust" | "later") => void
}) {
  const message = [props.directory, ...props.items.map((item) => `- ${item.label}`)].join("\n")
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
