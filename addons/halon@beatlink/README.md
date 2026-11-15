# Halon

A slate and blue theme for Trilium, built on the TriliumNext `next` base. Navigation chrome — the
launcher rail, the tab bar, the toolbars — sits one step *back* from the content it wraps, and the
thing you have selected is a raised card rather than a block of colour. Structure comes from
hairline borders and a three-step surface scale; shadows appear only where something genuinely
floats. One blue accent carries links, focus and the primary action, and nothing else.

It ships a matching dark mode and follows your operating system's colour scheme, as the `next` base
it sits on does.

Halon is a whole-desktop theme, not only a Trilium one. The same token set drives its GTK, Cinnamon,
Qt, VS Code, Firefox, Tilix, LMMS, LightDM and Plymouth implementations, so Trilium matches the rest
of the session. Every foreground and background pair it specifies meets WCAG 2.1 AA in both schemes.

## Install

Install through the Addon Manager, then pick **Halon** under Options → Appearance → Theme.

The stylesheet note carries the two labels the theme needs, so there is nothing to set by hand:

```
#appThemeBase=next   #appTheme=Halon
```

## Where the stylesheet comes from

This addon does not keep its own copy of the CSS. Its stylesheet note points straight at
`halon/trilium/halon.css` in the [X-Themes repository](https://github.com/x-tech-laboratories/X-Themes), pinned to a
commit, so the theme here and the theme everywhere else cannot drift apart. The design guide, the
token set and the contrast audit all live there.

## Previously

This addon replaces **TAMTheme** (`tamtheme@beatlink`), which was the same theme under its earlier
name and before it was rebuilt against Halon's specification. The visible changes are a light-mode
navigation frame in place of the dark navy one, the three button weights, and a dark mode whose
fills carry dark text rather than white. TAMTheme is not updated in place — install this and remove
the old addon.
