# Set → Post · Confessionail Studio

A phone-first hub for Confessionail Studio (24-hour nail salon, DTLA). Nail techs upload photos of a finished set. The app picks the best shots, orders them into a post (hero + carousel, with a short reason for each pick) and drafts captions in the studio voice. Tina reviews, approves and shares to Instagram herself.

Built for Converge.AI at Stanford, Nov 20 2026.

## Run it

```bash
node server.js          # or: npm start
```

Open http://localhost:3000. Node 18+ only, no install needed. Without an API key it runs fully offline with a built-in photo picker and caption templates.

For live Claude scoring and captions:

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

## The flow

1. **Upload** (nail tech): name, tap the service, add 5 to 20 photos. Each photo is checked in the browser right away.
2. **Pick**: the server sends the photos that passed to the vision model, scores them, and builds the post: hero first, then up to 4 more, with a detail close-up second.
3. **Caption**: three options (A Short & playful, B Detail with service and price, C 24-hour hook), each with an Instagram and a Facebook version. Buttons: Edit, Shorter, More playful, New options.
4. **Approve** (Tina): swap the hero, remove or add photos, pick a caption, Approve (or Approve all). Approved posts are spread out one a day.
5. **Share to Instagram**: one tap copies the caption and opens the phone's share sheet with the photos attached. Pick Instagram, long-press to paste. When she comes back the app asks "Did you post it?". Fallbacks: Save photos, Copy caption, Share to Facebook.

Statuses: Needs approval → Ready to post (with date, or Overdue) → Posted.

## How photos are scored (hybrid)

| Check | Where | How |
|---|---|---|
| Sharp focus | Browser (`public/quality.js`) | Variance of the Laplacian on the sharpest tiles |
| No glare | Browser | Share of blown-out pixels in the middle of the frame |
| Lighting | Browser | Brightness histogram (mean, clipped shadows/highlights) |
| Near-duplicates | Browser | 64-bit dHash, Hamming distance ≤ 10, keeps the best |
| Framing, clean background, house style | Server (`lib/vision.js`) | Vision model, one call per set |

Blurry, glare-heavy, too-dark or near-copy photos are dropped **before** any model call. Score = 40% pixel checks + 60% vision checks, 0 to 100. If the best photo scores under 60, the post shows a retake tip.

The vision step is pluggable (`lib/vision.js`). Providers: `claude` (used when `ANTHROPIC_API_KEY` is set) and `offline` (deterministic estimate from pixel features). Force one with `VISION_PROVIDER=offline`. Model calls that fail fall back to the offline estimate, so a demo never stalls.

**The app never changes the nail art.** Photos are only resized for upload; no generative edits, filters or retouching.

## Files

- `server.js`: tiny HTTP server, JSON storage in `data/`, scheduling, API.
- `lib/brand.json`: brand profile (services, prices, voice, hashtags, house style). Every step reads this.
- `lib/vision.js`: vision provider interface + Claude and offline providers.
- `lib/captions.js`: caption drafting with Claude, or templates in the studio voice.
- `public/`: the app (no framework, no build step), manifest and icons for Add to Home Screen.

## Assumptions

- Posting times: one post a day, 12pm Mon–Thu, 7pm Fri–Sun. A guess, easy to change in `server.js` (`slotFor`).
- Booking link is a placeholder: `{{BOOKING_URL}}` in `lib/brand.json`.
- Metrics logged: seconds from upload to approved, taps per post, posts planned vs. posted.

## Testing on a phone

The share sheet with files and the clipboard need HTTPS (localhost counts, a LAN IP does not). To test on a phone, put the server behind an HTTPS tunnel, for example `npx localtunnel --port 3000` or `cloudflared tunnel --url http://localhost:3000`, and open that URL. iPhone Safari 15+ and Android Chrome support sharing multiple photos. Test the Share button on a real iPhone and Android early: it is the riskiest step.

## Upgrade path

Direct auto-publishing through the Meta Graph API is a later upgrade. It needs an Instagram Business account linked to a Facebook Page and an approved Meta app. The share button lets the studio start on day one without any of that.
