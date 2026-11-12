# FLUX 3 image generation: local raster images over HTTP

Use this when a task needs a raster image made on this machine: a product shot, a landscape, a character, an illustration for a document. It talks to a local FLUX 3 service over its HTTP API. Diagrams and charts are not raster images: make those with Studio's figure tools.

The FLUX service is the person's own tool. Swarm does not ship it, install it or configure it. Swarm's tool health check may start it again when it was running before. You never start, install or change it yourself.

## 1. Find the service

Base URL, first match wins:
1. `FLUX3_URL` from the environment, if set.
2. The probe URL of the `flux3` entry in `~/.config/swarm/tool-health.json`, without the trailing `/health`.
3. `http://127.0.0.1:7863`.

The host must be `127.0.0.1` or `localhost`. The service answers 403 to any other host name, so never replace it with the machine's name or a LAN address, and never set a Host header yourself.

## 2. Check health before the first image

```
curl -s -w ' %{http_code}' "$BASE/health"
```

Ready means HTTP 200 and `"weights_downloaded": true`, for example `{"model":"flux3-image-klein","weights_downloaded":true,"model_loaded":false}`.

- `model_loaded: false` is normal. The model loads on the first `POST /generate`, so the first image after a start takes longer. Do not wait for `model_loaded`.
- 503, or `weights_downloaded: false`: the model weights are missing. The service cannot make images. Go to section 6.
- 403: the host name is wrong (section 1).
- No answer (code 000, connection refused): the service is not running. Go to section 6.

Check once per session, and again after any failure.

## 3. Make an image

`POST $BASE/generate` with a JSON body of exactly four fields. The answer is HTTP 200 with `Content-Type: image/png`.

```
curl -s -X POST "$BASE/generate" -H 'Content-Type: application/json' \
  -d '{"prompt":"<prompt>","width":768,"height":512,"seed":42}' \
  -o images/<name>.png -w '%{http_code}' --max-time 180
```

Limits, enforced by the service (a breach answers 422):
- `prompt`: 1-4000 characters.
- `width`, `height`: 256-1024, each a multiple of 16.
- `seed`: 0-4294967295.
- No other parameter exists: no negative prompt, no steps, no guidance scale. Every control goes through the prompt text.

Verify every file before you use it:
1. The printed code is 200. Any other code means the file holds an error body, not an image: read it, delete it, and handle the code (section 6).
2. The file starts with the PNG signature: `head -c 8 images/<name>.png | od -An -tx1` prints `89 50 4e 47 0d 0a 1a 0a`.
3. Record `shasum -a 256 images/<name>.png` next to the prompt, size and seed.

The output is deterministic: the same prompt, width, height and seed give a byte-identical PNG. Keep the four inputs with each file. To reuse an image, keep the file and regenerate it only when an input changes.

One request at a time. 429 means the service is busy with another image: wait for about one image time from the table below and retry once. Never send requests in parallel.

Measured times on the reference machine (Apple silicon, 4-bit model). Set `--max-time` to at least the figure in the last column:

| Size | Time per image | Use | --max-time |
|---|---|---|---|
| 512x512 | 18-25 s | quick tests, comparing prompts | 120 |
| 768x512 | about 34 s | best measured result; default for landscape subjects | 180 |
| 640x832 | not measured | characters and people | 180 |
| 1024x576 | about 58 s | lower measured result; only when asked | 180 |
| 1024x1024 | about 73 s | 4.2x the cost of 512x512 | 180 |

The first image after a start also loads the model; allow up to 300 s for it. Times rise under load during a long session, so compare times only within one batch.

## 4. Write the prompt

These rules come from 13 measured prompt changes on this service, three seeds each. The numbers are from a pixel-statistics proxy (detail 0.30, colourfulness 0.25, contrast 0.20, exposure 0.15, balance 0.10) that is not part of Swarm. It measures technical quality, not whether the picture matches the prompt. Treat the numbers as relative guidance.

- **P1** Write natural sentences, not a tag list. Natural language scored +2.60 and was 1.8x more stable. Tags such as "8k, best quality" burned out the saturation.
- **P2** Order: subject, then background, then light, then camera and style. The background is the strongest lever (+5.90).
- **P3** Be concrete: material, action, numbers. "Matte black ceramic" raised detail by 41%. Avoid "beautiful", "8k", "masterpiece".
- **P4** About 30 words is the best length. Short prompts scored best and ran among the fastest. A camera or style clause adds about 17% time.
- **P5** Do not write negations ("no text, no logo"). They are inert (-0.03) and cost characters. Do not replace them with a positive phrase either: "empty negative space" scored -2.06. Remove the clause.
- **P6** Control the palette with an explicit light clause: "golden hour" raised colourfulness by 74% without hurting the structure.
- **P7** Use labelled fields ("Subject: ... Background: ...") only in long prompts (+0.45). In short prompts they hurt (-1.72): write a flowing sentence.
- **P8** Choose the aspect ratio by subject: products and landscapes 768x512, characters 640x832. Larger is not better: 768x512 beat both 640x832 and 1024x576.
- **P9** Write prompts in English. Another language is served but scored lower (-1.71). Fix the seed when you compare two prompts, and change one thing per comparison. Use three seeds to compare and six seeds before you claim a result is robust.

Templates (about 30 words, flowing):

- Product: `<object and material> on <surface>, seamless <colour> backdrop. Softbox key light <position>, soft contact shadow. 85mm lens, f/8, sharp focus, catalogue style.`
- Landscape: `Wide establishing shot of <landscape> at golden hour, low sun raking from <direction>, warm rim light on <vegetation>, cool valley shadows, thin mist. 24mm lens, f/11, deep focus.`
- Character: `Waist-up medium shot, three-quarter left of <character and clothing>, <face detail>, holding <prop>. <paint medium, e.g. gouache> with dry-brush texture, limited palette of <3 colours>, <background>, soft diffused daylight.`

Best measured prompt (768x512, six seeds, highest proxy result): `Matte black ceramic coffee mug on a rustic wooden table, seamless light grey backdrop. Softbox key light upper left, soft contact shadow. 85mm lens, f/8, sharp focus, catalogue style.`

Terms measured on this service: `softbox key light upper left`, `soft contact shadow`, `rim light`, `golden hour`, `low sun raking`, `soft diffused daylight`, `85mm lens`, `24mm lens`, `f/8`, `f/11`, `sharp focus`, `deep focus`, `seamless light grey backdrop`, `catalogue style`. Not yet measured here (try one per comparison): `close up`, `waist up medium shot`, `eye level view`, `cinematic natural light`, `soft gallery lighting`, `large diffusion panel`, `subtle rim light`. Text inside the image is untested: quote the exact words, two to six per string.

Style anchors: name a medium, an era and a technique, not an artist.

## 5. Check the content

You cannot judge an image from its bytes. Before an image counts as done, an agent that reads images, or the person, looks at it and confirms it shows what the task asked for. Report an image you could not inspect as unchecked.

## 6. When the service is not available

Never install, start, stop or reconfigure the FLUX service or its model. Do not run launchctl, uvicorn, pip, brew or a download script, and do not edit `~/.config/swarm/tool-health.json`.

1. Load the `tool-health` skill and read the `flux3` status.
2. Act on the status:

| `flux3` status | What it means | What you do |
|---|---|---|
| no `flux3` entry | the service is not registered on this machine | Tell the user the image service is not available and continue without images |
| `healthy`, `revived` | running | Check health (section 2) and continue |
| `skipped_not_installed` | its program is missing | Tell the user the image service is not installed and continue without images |
| `skipped_never_healthy` | never seen running, so Swarm did not start it | Tell the user to start it once themselves, then continue without images |
| `dead`, `revive_failed` | down, and Swarm's start did not bring it back | Ask for a re-check of `flux3` through the `tool-health` skill, once. If it is still down, show the user the status message and continue without images |

3. A missing image is never a reason to stop the rest of the task. Mark where each image was meant to go, say which images are missing and why, and list them in the final message.

To register the service on another machine, propose the `flux3` entry for `tool-health.json` in your final message, after a healthy probe, and let the person add it. Leave its revive command out when you do not know how the service was started.

In autonomous mode a call to a local FLUX address (127.0.0.1 or localhost) runs at once; it is not held. If a call is refused, treat the service as not available and continue without images.
