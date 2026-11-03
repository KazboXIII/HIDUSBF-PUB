# HIDUSBF

USB polling-rate overclocking for mice, keyboards and controllers, plus PlayStation controller tools (stick check, calibration, lights).

## Download

Get the latest **HIDUSBF-x.y.z-Setup.exe** from [Releases](https://github.com/KazboXIII/HIDUSBF-PUB/releases/latest) and run it. HIDUSBF installs to Program Files and adds a Start menu entry.

After that, HIDUSBF checks this page for new versions while its loading window is up and offers to install them. You can turn that off in **About > Updates**.

Each release has a `.sha256` file next to the installer, so you can check the download:

```powershell
Get-FileHash .\HIDUSBF-4.0.0-Setup.exe -Algorithm SHA256
```

## Notes

- Windows 8.1 or later, 64-bit. Needs administrator rights, because it installs and manages the hidusbf filter driver.
- The installer isn't code-signed yet, so Windows SmartScreen may warn the first time. Choose **More info > Run anyway**.
- Uninstalling HIDUSBF leaves the driver in place. Remove it first from **Driver > Uninstall service** in the app if you want it gone.

Report problems in [Issues](https://github.com/KazboXIII/HIDUSBF-PUB/issues).

## Website

GitHub Pages serves this repository's `main` branch at https://hidusbf.app/.
The controller information guide lives in `information/index.html` and uses the shared stylesheet plus `information/information.css`. It requires no build step, JavaScript or third-party runtime dependency.

When updating the guide, check exact hardware/firmware revisions against the cited primary documentation, distinguish vendor claims from measurements, and update the research date only for a substantive source review. Keep inline source anchors, the source notes and homepage navigation working. The guide's polling chart shows calculated intervals, not latency measurements.

The private dashboard lives in `dashboard/` at https://hidusbf.app/dashboard/ and isn't linked from the site. Download numbers come straight from the GitHub API. Launch numbers come from the app's anonymous counter and need the stats key, which the page keeps in memory only: it is never stored here or in the browser. `node --test` runs the tests in `tests/` (Node 22 or newer, no packages needed).
