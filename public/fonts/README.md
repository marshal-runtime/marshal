# Bundled fonts

Vendored rather than resolved from `node_modules` at build time so the packaged
app never depends on a font package being present, and so the exact bytes we
ship are reviewable in-tree.

| File | Family | Source | License |
| --- | --- | --- | --- |
| `Geist-Variable.woff2` | Geist Sans (variable, 100–900) | [`geist`](https://www.npmjs.com/package/geist) | SIL Open Font License 1.1 |
| `Geist-Italic-Variable.woff2` | Geist Sans Italic (variable, 100–900) | [`geist`](https://www.npmjs.com/package/geist) | SIL Open Font License 1.1 |
| `GeistMono-Variable.woff2` | Geist Mono (variable, 100–900) | [`geist`](https://www.npmjs.com/package/geist) | SIL Open Font License 1.1 |

`Geist-LICENSE.txt` is the upstream license text, copied verbatim.

To re-vendor after a `geist` upgrade, copy the three `*-Variable.woff2` files out
of `node_modules/geist/dist/fonts/`. The italic source file is named
`Geist-Italic[wght].woff2`; the square brackets are a wildcard in PowerShell, so
copy it with `-LiteralPath`.
