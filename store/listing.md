# Chrome Web Store listing — QuietShield

## Store listing tab
**Name:** QuietShield — Ad & Tracker Blocker
**Summary (≤132 chars):** Blocks ads and trackers quietly, using Brave's open-source adblock-rust engine and filter lists.
**Category:** Privacy & Security
**Language:** English

**Description:**
QuietShield blocks ads, trackers, cookie banners and anti-adblock walls, while staying hard for websites to detect.

• Powered by Brave's open-source adblock-rust engine, the same engine behind Brave's built-in blocker
• Uses the same default filter lists (EasyList, EasyPrivacy, uBlock Origin filters and Brave's own lists)
• Hides leftover ad boxes and runs anti-adblock fixes before page scripts load
• Standard mode keeps sites working by not blocking their own first-party content; Aggressive mode blocks more
• Turn it off for any site with one click
• No accounts, no analytics, no data collection. Everything runs locally in your browser.

Open source: https://github.com/arjun-vegeta/QuietShield

QuietShield is an independent project and is not affiliated with or endorsed by Brave Software. "Brave" is a trademark of Brave Software, Inc.

**Graphics:** icon `../extension/icons/icon-128.png`, screenshots `assets/screenshot-*.png` (1280×800), small promo tile `assets/promo-tile-440x280.png`.

## Privacy practices tab
**Single purpose:** Block ads and trackers on web pages.

**Permission justifications:**
- `declarativeNetRequest`: Blocks or redirects ad and tracker network requests using bundled filter rules.
- `scripting`: Injects the bundled content scripts that hide ad elements and neutralize anti-adblock scripts on the sites that need them.
- `storage` / `unlimitedStorage`: Stores the bundled per-site cosmetic filtering data (about 35,000 entries) and the user's settings locally.
- `activeTab`: Lets the popup show and change settings for the current site.
- Host permissions (`<all_urls>`): Ads and trackers appear on every site; filtering and element hiding must run on any page the user visits.

**Remote code:** No. All JavaScript and WebAssembly is included in the package.

**Data usage:** Does not collect or transmit any user data. (Tick none of the data categories; certify the three disclosures.)

**Privacy policy URL:** https://github.com/arjun-vegeta/QuietShield/blob/main/PRIVACY.md
