<p align="center"><img src="extension/icons/icon-128.png" width="88" alt=""></p>

<h1 align="center">QuietShield</h1>

<p align="center"><b>No more &ldquo;disable ad blocker to continue.&rdquo;</b><br>A free ad and tracker blocker for Chrome, powered by Brave's ad-blocking engine.<br>
<a href="https://quietshield.arjunr.dev/">Website</a> · <a href="https://github.com/arjun-vegeta/QuietShield/releases/latest/download/quietshield.zip">Download</a> · <a href="ARCHITECTURE.md">Architecture</a></p>

---

## What it is

QuietShield brings the blocking you get in Brave to Chrome. It runs
[adblock-rust](https://github.com/brave/adblock-rust), the engine behind Brave Shields, with the
same default filter lists, and was tested side by side against Brave to block the same things.

- Blocks ads, trackers, cookie banners and disguised (CNAME) trackers
- Defeats anti-adblock walls by running fixes before the page's own scripts
- Built to be hard for websites to detect
- Everything runs on your device — no accounts, no analytics

Works in Chrome, Edge, Brave, Opera and other Chromium browsers.

## Install

About a minute. A [step-by-step guide with pictures](https://quietshield.arjunr.dev/#install) is on the website.

1. Download **[quietshield.zip](https://github.com/arjun-vegeta/QuietShield/releases/latest/download/quietshield.zip)** and unzip it.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Drag the unzipped **quietshield** folder onto the page.

Keep the folder where it is — Chrome runs QuietShield from it.

## Use

Click the QuietShield icon in the toolbar (pin it from the puzzle-piece menu).

| Setting | What it does |
|---|---|
| **Shields up for this site** | Untick to turn QuietShield off on the current site, e.g. if a page looks broken. |
| **Standard / Aggressive** | Standard keeps sites working by not blocking a site's own content. Aggressive blocks more. |
| **Block cross-site cookies** | Optional, like Brave's default. Chrome asks for permission the first time. |
| **Check GitHub for updates daily** | Shows a banner in the popup when a new version is out. |

Changes apply when you reload the page.

**Updating:** download the new zip, replace the contents of your `quietshield` folder, then click the
reload icon on the QuietShield card in `chrome://extensions`. Your settings are kept.

**If QuietShield switches itself off** after a Chrome update, turn it back on in `chrome://extensions`.

## Privacy

QuietShield collects nothing. All filtering happens locally. The only request it makes is the
optional daily update check to GitHub. See [PRIVACY.md](PRIVACY.md).

## More

- [Architecture](ARCHITECTURE.md) — how it was built: the research, architecture, testing against Brave, and how to build from source
- [Releases](https://github.com/arjun-vegeta/QuietShield/releases)

QuietShield is an independent project and is not affiliated with or endorsed by Brave Software.
"Brave" is a trademark of Brave Software, Inc.
