# Design reference

This folder captures the Claude Design handoff for Custos so the source of truth for
the UI lives in the repo alongside the code.

- **Source project:** Claude Design — *"Custos — keeper of your queries · tokens, main
  window, and supporting screens"*.
- `screens/1a.html` … `1i.html` — the individual screen mockups, extracted from the
  design bundle (self-contained inline HTML/CSS/SVG).

## Screen → implementation map

| # | Screen | Status | Implemented in |
| --- | --- | --- | --- |
| 1a | Design tokens (light & dark) | ✅ adopted | `renderer/src/styles/tokens.css` |
| 1b | App icon / guardian shield | ✅ asset | `renderer/public/custos-mark.svg` |
| 1c | Main window — light | ✅ built | `renderer/src/app/app.component.html` |
| 1d | Main window — dark | ✅ built (same markup, tokens swap) | `ThemeService` + `tokens.css` |
| 1e | New / edit connection | ⬜ | — |
| 1f | Welcome / first launch | ⬜ | — |
| 1g | Safety dialog | ⬜ | — |
| 1h | Query history | ⬜ | — |
| 1i | Component states | ⬜ | — |
| 1j | Layout spec | reference | — |

## How the main window was implemented

The design's screen 1c uses local CSS variables (`--sf`, `--tx`, `--ac`, …). During
implementation these were remapped 1:1 onto the global token names in `tokens.css`
(`--surface`, `--text`, `--accent`, …), so the exact same markup renders correctly in
both themes purely by flipping `data-theme`. The theme toggle in the titlebar is wired
to `ThemeService`.

When building the remaining screens, follow the same approach: take the screen's
markup as the visual spec, reference tokens instead of hardcoded hexes, and wire
behavior through `CustosClient`.
