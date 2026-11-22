# veraqis-pages

The published site for [veraqis.tech](https://veraqis.tech), served by GitHub Pages from the
`main` branch (custom domain in `CNAME`, no Jekyll build — `.nojekyll`).

Everything here is static and ships exactly as committed: there is no build step in this
repository. A merge to `main` is a deployment.

## Layout

| Path | Contents |
|---|---|
| `*.html` (root) | Product and company pages: home, download, pricing, docs, security, privacy, terms, changelog |
| `formats/`, `reference/`, `guides/`, `archives/`, `sqlite/` | Format references and repair guides |
| `research/` | Research reports and the experiment ledger |
| `tools/` | Browser tools (ZIP checker) |
| `studio/` | VERAQIS Studio, including the in-browser engine at `studio/engine/` |
| `play/` | Browser games about archive safety |
| `android/` | Android product pages |
| `downloads/` | Release artifacts and `SHA256SUMS.txt` |
| `assets/` | Styles, scripts, images and the built WebAssembly modules |
| `web-engine/` | Source of the browser adapter for the engine — see [`web-engine/README.md`](web-engine/README.md) |
| `sitemap.xml`, `robots.txt`, `feed.xml`, `llms.txt`, `.well-known/` | Discovery and policy files |

## Changing the site

1. Branch from `main` as `deploy/<topic>`.
2. Open a pull request into `main`.
3. Merging publishes the change to veraqis.tech.

When a release artifact in `downloads/` changes, update `downloads/SHA256SUMS.txt` in the same
pull request.

## What is not here

The core recovery engine is developed in a private repository. `web-engine/` contains only what
is specific to the browser version, under the licences in that folder. The open structural
recovery engine and CLI live in [veraqis-recover](https://github.com/yurlith/veraqis-recover).

Site content is © VERAQIS unless a file or folder states otherwise.

Security contact: see [`.well-known/security.txt`](.well-known/security.txt).
