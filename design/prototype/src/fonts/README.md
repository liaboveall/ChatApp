# Fonts

`inter-latin-wght-normal.woff2` is the Latin subset of Inter (variable, weights 100 to 900) from
`@fontsource-variable/inter` 5.3.0. Inter is licensed under the SIL Open Font License 1.1 (`Inter-OFL.txt`).

The build inlines it into the page as a data URI, so the font comparison needs no network. This is how the
D1 question "system font stack or Inter on Windows" can be answered on any machine, including ones that
cannot reach Google Fonts. Only Latin is included; Chinese always uses the system fonts (docs/02 section 4.3).
