# Dual Audio Output — Chrome Extension

Play browser audio through **both HDMI and 3.5mm jack simultaneously** on your Chromebook.

[Click Here for Webpage!](https://stevegates24.github.io/Steves-Audio-Mixer/)

---

## Installation (Chromebook)

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `dual-audio-extension` folder

---

## How to use

1. Click the extension icon in your toolbar
2. Click **"Click to grant"** if prompted (needed to see device names)
3. In the device list, **click to select** your HDMI output and your 3.5mm output  
   (both cards should glow green when selected)
4. Toggle **Dual output** ON
5. Adjust the per-output volume sliders if needed
6. Click **"Apply to active tab"**

The extension will now route audio on that tab to both devices at once.

---

## How it works

Uses the **Web Audio API** with `AudioContext.setSinkId()` to create two separate audio pipelines — one for each output device. The audio stream is duplicated and sent to both sinks simultaneously.

- ✅ Works with: YouTube, Spotify Web, Netflix, any browser media
- ❌ Does not work with: Android apps, Linux apps, or system sounds (these are outside the browser's control)

---

## Troubleshooting

**I can't see my device names**  
Grant microphone permission when prompted — Chrome requires this to show output device labels.

**"Cannot inject on this page"**  
Extension can't run on `chrome://` pages or the Chrome Web Store. Navigate to any normal media page.

**Only one output works**  
`setSinkId()` is supported in Chrome 110+. Make sure your Chromebook is up to date.

**The device list is empty**  
Click "↻ Refresh device list" after connecting your devices.

---

## Icons

The extension uses a placeholder icon. To add a real icon, replace `icon16.png`, `icon48.png`, and `icon128.png` in the extension folder.
