# PM-ES Deployment Notes

Deployment is intentionally manual for the first public website release.

## Repository Root Model

The site is stored directly at the root of the dedicated public repository `Juggerknot18/PM-ES`. There is no `website/` wrapper directory.

## Human Review Gate

Before activation:

1. Review the pull request diff.
2. Confirm that the public repository contains only approved public website content.
3. Run a final privacy scan.
4. Merge to `main` only after review.
5. Enable GitHub Pages manually if publication is approved.

## Manual GitHub Pages Configuration

Expected configuration after review and merge:

- Source branch: `main`
- Folder: `/(root)`
- Expected URL: `https://juggerknot18.github.io/PM-ES/`

Do not enable Pages until the human review gate is complete.

## Privacy Boundary

No private repository is accessed, synchronized, cloned or mirrored for this website. The public website must remain separate from firmware and internal engineering documentation.

## Disable Pages After Accidental Disclosure

If an accidental disclosure is detected:

1. Disable GitHub Pages in repository settings.
2. Remove the exposed content from the working tree.
3. Review whether repository history or cached Pages content needs additional action.
4. Re-run the privacy scan before re-enabling publication.

## Provisional Variables

```text
SITE_ORIGIN=https://juggerknot18.github.io
SITE_BASE_PATH=/PM-ES
SITE_URL=https://juggerknot18.github.io/PM-ES/
```

These values remain placeholders until final route confirmation.
