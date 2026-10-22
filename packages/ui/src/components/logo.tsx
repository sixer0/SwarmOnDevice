import { type ComponentProps } from "solid-js"

// Swarm brand geometry: mark derived from implementation/02a_mark_master.svg (row 39,
// <use> elements flattened per its handoff recipe); wordmark drawn from the SWARM grid
// in implementation/01_theme_tokens.md section 3.2 (row 38). Single-tone currentColor
// keeps both theme-aware through the inherited text colour.
//
// The wordmark grid is 5 rows x 26 columns at pitch 8.4, widened from 24 by row 241c so that W and
// M each own a centre column: at four columns neither letter can draw its distinguishing stroke,
// which is why the mark read "SVARN" (research/s6_r241b_wordmark_legibility.md §2.3). The canvas
// grew to 250.8 rather than the pitch shrinking, because `M16.20 0.00h33.60` is the byte-level
// search key five instruments use to prove this mark is in the shipped bytes. packages/ui/test/
// wordmark-glyph.test.ts decodes this `d` back onto the grid and pins it against the four other
// transcriptions of the same art, so none of them can drift again.

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
      viewBox="0 0 250.8 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <path
        data-slot="logo-wordmark"
        fill="currentColor"
        d="M16.20 0.00h33.60v8.40h-33.60z M58.20 0.00h8.40v8.40h-8.40z M91.80 0.00h8.40v8.40h-8.40z M117.00 0.00h16.80v8.40h-16.80z M150.60 0.00h33.60v8.40h-33.60z M192.60 0.00h8.40v8.40h-8.40z M226.20 0.00h8.40v8.40h-8.40z M16.20 8.40h8.40v8.40h-8.40z M58.20 8.40h8.40v8.40h-8.40z M91.80 8.40h8.40v8.40h-8.40z M108.60 8.40h8.40v8.40h-8.40z M133.80 8.40h8.40v8.40h-8.40z M150.60 8.40h8.40v8.40h-8.40z M175.80 8.40h8.40v8.40h-8.40z M192.60 8.40h16.80v8.40h-16.80z M217.80 8.40h16.80v8.40h-16.80z M16.20 16.80h33.60v8.40h-33.60z M58.20 16.80h8.40v8.40h-8.40z M75.00 16.80h8.40v8.40h-8.40z M91.80 16.80h8.40v8.40h-8.40z M108.60 16.80h33.60v8.40h-33.60z M150.60 16.80h25.20v8.40h-25.20z M192.60 16.80h8.40v8.40h-8.40z M209.40 16.80h8.40v8.40h-8.40z M226.20 16.80h8.40v8.40h-8.40z M41.40 25.20h8.40v8.40h-8.40z M58.20 25.20h16.80v8.40h-16.80z M83.40 25.20h16.80v8.40h-16.80z M108.60 25.20h8.40v8.40h-8.40z M133.80 25.20h8.40v8.40h-8.40z M150.60 25.20h8.40v8.40h-8.40z M167.40 25.20h16.80v8.40h-16.80z M192.60 25.20h8.40v8.40h-8.40z M226.20 25.20h8.40v8.40h-8.40z M16.20 33.60h33.60v8.40h-33.60z M58.20 33.60h16.80v8.40h-16.80z M83.40 33.60h16.80v8.40h-16.80z M108.60 33.60h8.40v8.40h-8.40z M133.80 33.60h8.40v8.40h-8.40z M150.60 33.60h8.40v8.40h-8.40z M175.80 33.60h8.40v8.40h-8.40z M192.60 33.60h8.40v8.40h-8.40z M226.20 33.60h8.40v8.40h-8.40z"
      />
    </svg>
  )
}
