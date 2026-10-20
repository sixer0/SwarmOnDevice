import { type ComponentProps } from "solid-js"

// Swarm brand geometry: mark derived from implementation/02a_mark_master.svg (row 39,
// <use> elements flattened per its handoff recipe); wordmark drawn from the SWARM grid
// in implementation/01_theme_tokens.md section 3.2 (row 38). Single-tone currentColor
// keeps both theme-aware through the inherited text colour.

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g data-slot="logo-mark" fill="currentColor" transform="translate(8 10) scale(0.019961) translate(-512.0 -512.0)">
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(512 512)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(678.28 512)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(595.14 368)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(428.86 368)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(345.72 512)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(428.86 656)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(595.14 656)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(842 267) scale(0.55)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(182 757) scale(0.55)"
        />
      </g>
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g
        data-slot="logo-mark"
        fill="currentColor"
        transform="translate(40 50) scale(0.101137) translate(-512.0 -512.0)"
      >
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(512 512)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(678.28 512)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(595.14 368)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(428.86 368)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(345.72 512)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(428.86 656)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(595.14 656)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(842 267) scale(0.55)"
        />
        <path
          data-slot="logo-mark-cell"
          d="M-12.12 -89 Q0 -96 12.12 -89 L71.01 -55 Q83.14 -48 83.14 -34 L83.14 34 Q83.14 48 71.01 55 L12.12 89 Q0 96 -12.12 89 L-71.01 55 Q-83.14 48 -83.14 34 L-83.14 -34 Q-83.14 -48 -71.01 -55 Z"
          transform="translate(182 757) scale(0.55)"
        />
      </g>
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <path
        data-slot="logo-wordmark"
        fill="currentColor"
        d="M16.20 0.00h33.60v8.40h-33.60z M58.20 0.00h8.40v8.40h-8.40z M83.40 0.00h8.40v8.40h-8.40z M108.60 0.00h16.80v8.40h-16.80z M142.20 0.00h33.60v8.40h-33.60z M184.20 0.00h8.40v8.40h-8.40z M209.40 0.00h8.40v8.40h-8.40z M16.20 8.40h8.40v8.40h-8.40z M58.20 8.40h8.40v8.40h-8.40z M83.40 8.40h8.40v8.40h-8.40z M100.20 8.40h8.40v8.40h-8.40z M125.40 8.40h8.40v8.40h-8.40z M142.20 8.40h8.40v8.40h-8.40z M167.40 8.40h8.40v8.40h-8.40z M184.20 8.40h16.80v8.40h-16.80z M209.40 8.40h8.40v8.40h-8.40z M16.20 16.80h33.60v8.40h-33.60z M58.20 16.80h8.40v8.40h-8.40z M75.00 16.80h16.80v8.40h-16.80z M100.20 16.80h33.60v8.40h-33.60z M142.20 16.80h25.20v8.40h-25.20z M184.20 16.80h8.40v8.40h-8.40z M201.00 16.80h16.80v8.40h-16.80z M41.40 25.20h8.40v8.40h-8.40z M58.20 25.20h33.60v8.40h-33.60z M100.20 25.20h8.40v8.40h-8.40z M125.40 25.20h8.40v8.40h-8.40z M142.20 25.20h8.40v8.40h-8.40z M159.00 25.20h16.80v8.40h-16.80z M184.20 25.20h8.40v8.40h-8.40z M209.40 25.20h8.40v8.40h-8.40z M16.20 33.60h33.60v8.40h-33.60z M66.60 33.60h16.80v8.40h-16.80z M100.20 33.60h8.40v8.40h-8.40z M125.40 33.60h8.40v8.40h-8.40z M142.20 33.60h8.40v8.40h-8.40z M167.40 33.60h8.40v8.40h-8.40z M184.20 33.60h8.40v8.40h-8.40z M209.40 33.60h8.40v8.40h-8.40z"
      />
    </svg>
  )
}
