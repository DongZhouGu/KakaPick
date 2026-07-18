# Post-cull workflow content design

## Goal

Make it immediately clear what photographers can do after culling in KakaPick. The website and both README languages must explain the two supported handoff paths instead of mentioning export only in passing.

## Website

Add an independent section after the existing four-step workflow and before the feature band. Its message is that KakaPick does not lock users into a closed workflow: once culling is complete, they can continue in Lightroom or create a separate selects folder.

The section contains two equal cards:

1. **Continue in Lightroom.** Export Lightroom-compatible star ratings. Proprietary RAW files use XMP sidecars; JPEG and DNG use compatible metadata. After Lightroom reads the updated metadata, photographers can filter by rating and continue developing their photographs.
2. **Copy to a new folder.** Copy selected source photographs and related files into a separate destination. RAW+JPEG pairs remain together, while originals stay in place and are not deleted or moved.

Add a navigation link to the section so the handoff workflow is easy to find. Follow the site's current dark, restrained visual language and responsive card patterns.

## README

Add a dedicated post-cull section to both `README.zh-CN.md` and `README.md`, immediately after the quick-start instructions. Each version explains:

- when to choose the Lightroom metadata path;
- how to make Lightroom read the exported metadata and filter by star rating;
- when to choose copy export;
- that paired RAW, JPEG, and associated XMP files stay together;
- that copy export does not move or delete originals.

The README should give practical next steps without claiming to edit the Lightroom catalog or develop RAW files.

## Accuracy and boundaries

- KakaPick writes only the compatible rating metadata required for the handoff.
- Proprietary RAW bytes are not modified; their ratings are published through XMP sidecars.
- Lightroom wording should allow for version-dependent menu labels rather than promise a single exact menu path.
- No application export behavior changes are included in this work.

## Verification

- Check both README languages for equivalent meaning.
- Validate the website HTML and confirm its anchors and linked navigation target exist.
- Run the repository's existing public-release/link checks that cover the site and README surfaces.
- Inspect the responsive CSS rules to ensure the new two-card section collapses cleanly on narrow screens.
