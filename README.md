# Set → Post · Confessionail Studio

A phone-first hub for Confessionail Studio (24-hour nail salon, DTLA). Nail techs upload photos of a finished set. The app picks the best shots, orders them into a post (hero + carousel, with a short reason for each pick) and drafts captions in the studio voice. Tina reviews, approves and shares to Instagram herself.

Built for Converge.AI at Stanford, Nov 20 2026.

## Two sides, one data store

| Path | Who | What |
|---|---|---|
| `/studio` | Staff | The hub: techs upload sets (picking who did it from the team list), Tina approves and shares to Instagram |
| `/` | Clients | Home with the latest work, nail artists and locations |
| `/tech/:id` | Clients | An artist's page: bio, specialties, Instagram, Book button, and a gallery of their approved sets |
| `/request` | Clients | Request an artist now or at a set time, at the studio or as a house call, then follow it live |
| `/locations` | Clients | Map (Leaflet + OpenStreetMap), hours, directions and a gallery per location; the second location shows as coming soon |

A set appears on the public pages the moment Tina approves it in `/studio` (the public pages refresh every 4 seconds). Only approved sets and their photos are public; captions, drafts and skipped photos are not.

The team and locations live in `lib/brand.json` (`techs`, `locations`). **The three techs (Mia, Jasmine, Kim) are samples** with made-up bios: replace them with the real team. Set `BOOKING_URL` (for example in Render's environment settings) to the studio's booking page; until then the Book buttons say online booking is coming soon.

## Staff sign-in (PINs)

`/studio` asks each person to tap their name and enter a 4 to 6 digit PIN. The public pages stay open.

| Who | Can do | Demo PIN |
|---|---|---|
| Tina (owner) | Everything: review, approve, share, edit, delete, upload for any tech | 2468 |
| Mia, Jasmine, Kim (techs) | Upload sets only. Each set is credited to whoever is signed in | 1111, 2222, 3333 |

**The demo PINs are for testing only.** To set real ones on Render:

1. Run `npm run hash-pin -- 482913` (your chosen PIN). It prints a hash like `scrypt$...$...`.
2. In Render, open the service's Environment tab and set `PIN_HASH_TINA` to that hash. Do the same for `PIN_HASH_MIA`, `PIN_HASH_JASMINE` and `PIN_HASH_KIM` (the name is `PIN_HASH_` plus the tech's id from `lib/brand.json`, in capitals).
3. Save. Render redeploys, and the demo PIN for that person stops working.

How it works:

- PINs are stored only as scrypt hashes, never in the code.
- Signing in sets an HTTP-only, SameSite=Lax cookie with the person's id and role, signed with `SESSION_SECRET` (Render generates one from `render.yaml`). It lasts 14 days. Without `SESSION_SECRET` everyone is signed out when the server restarts.
- After 5 wrong PINs for one name (or 20 overall) from the same device, sign-in is locked for 15 minutes.
- Roles are checked on the server for every `/api` route, so a tech can't approve by calling the API directly. A tech only sees their own sets, and photos of unapproved sets are only served to Tina and the tech who uploaded them.
- The sign-out button is at the top right.

## On-demand requests (Uber-style)

Clients can ask for an artist right now or at a set time, at the studio or at their home, hotel or office. **Demo grade: no card is charged and payouts are only numbers.**

1. **Client** (`/request`, or "Request an artist" on the home page and each artist's page): picks a service, when, where (address or "Use my current location"), any artist or a specific one, and leaves a first name and phone number. No account: the phone keeps a private link to follow the request.
2. **Artists** (`/studio`, Jobs tab): turn **On call** on and choose right-now jobs, booked-ahead jobs or both. With **House calls** on, they also set how far they'll go, a travel fee and the smallest job they'll take. They only see requests they qualify for (service, distance, minimum, not busy with another right-now job), with what they'd make. Accept or decline. The client's address and phone appear only once the job is theirs.
3. **Tina** (Jobs tab): sees every request and who is on call. She chooses **First to accept** (the first artist who says yes is booked) or **I choose** (artists say yes, she gives the job to one). She can cancel or mark jobs done, and sets the artist's share of the price (travel fees go to the artist in full).
4. **Client's page** updates every few seconds: Finding your artist, then "Mia is booked". A right-now request nobody takes closes after 20 minutes.

Which services each artist does is `serviceIds` in `lib/brand.json`; durations are `minutes` on each service (estimates). Defaults live under `onDemand`. Still to do for real use: payments and payouts (Stripe Connect), text messages to clients, address lookup for typed addresses (distance is known only with "Use my current location"), and shifts, so walk-in staff on the floor are tried first.

## Host it (fixed link for phones)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jz6424/30x30-2026)

Sign in to Render, click the button, and deploy. Render reads `render.yaml`, runs `npm install` and `node server.js`, and gives you a fixed `https://….onrender.com` link to open on every phone. Add `ANTHROPIC_API_KEY` in Render's settings for Claude scoring and captions, or leave it empty for the offline mode.

Free plan limits: the app sleeps after 15 minutes without visits, so the first load after that takes about a minute (open it before the demo), and saved sets are cleared when it restarts or redeploys. Anyone with the link can open the app.

GitHub Pages won't work: it serves static files only, so there is no server for techs and Tina to share sets or for captions.

## Run it on a phone from your computer

```bash
npm run phone
```

This starts the app and prints an HTTPS link and a QR code. Scan the code with the phone camera, then use Add to Home Screen so it opens like an app. The share sheet with photos and the clipboard only work over HTTPS.

The link comes from a free Cloudflare quick tunnel. If `cloudflared` isn't installed, the script fetches it through npx the first time (`brew install cloudflared` makes startup faster). `USE_LOCALTUNNEL=1 npm run phone` uses localtunnel instead, which can drop photo uploads.

Photos upload one at a time as small JPEGs (1440 px), with one retry each, so a slow connection or a tunnel's size limit doesn't fail the whole set. The link changes on every run. For a fixed link, deploy the app to any Node host.

On a computer: `node server.js` (or `npm start`), then open http://localhost:3000.

Needs Node 18 or later and nothing else. Without an API key it runs fully offline with a built-in photo picker and caption templates.

For live Claude scoring and captions:

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

## The flow

1. **Upload** (nail tech): enter a name, pick one service from the menu (with full set or fill, or hands or toes, where it applies), tick any add-ons, then add 5 to 20 photos. The menu and prices live in `lib/brand.json`; captions only use those prices. The phone checks each photo as it is added.
   The upload finishes as soon as the photos are saved. The tech can close the app; everything after this runs on the server.
2. **Pick** (server, in the background): the photos that passed go to the vision model, get scored, and become the post: the best photo first, then up to 4 more, with a detail close-up second.
3. **Caption** (server, in the background, right after picking): three options (A Short & playful, B Detail with service and price, C 24-hour hook), each with an Instagram and a Facebook version. Buttons: Edit, Shorter, More playful, New options.
4. **Approve** (Tina): choose the first photo, remove or add photos, pick a caption, then Approve or Approve all. Approved posts are spread out, one a day.
5. **Share to Instagram**: one tap copies the caption and opens the phone's share sheet with the photos attached. She picks Instagram and long-presses to paste. When she comes back, the app asks "Did you post it?" Fallbacks: Save photos, Copy caption, Share to Facebook.

Statuses: Needs approval → Ready to post (with date, or Overdue) → Posted. While the server is still picking or writing, Tina sees the set as "Getting ready" and the page fills in on its own. If a step fails, she gets a Try again button. Unfinished sets resume when the server restarts.

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

- `server.js`: HTTP server, JSON storage in `data/`, scheduling, API.
- `lib/brand.json`: brand profile (services, prices, voice, hashtags, house style). Every step reads this.
- `lib/vision.js`: vision provider interface, with Claude and offline providers.
- `lib/captions.js`: caption drafting with Claude, or templates in the studio voice.
- `public/`: the app (no framework, no build step), manifest, icons and service worker for Add to Home Screen.
- `scripts/phone.js`: `npm run phone`, the app plus an HTTPS tunnel and QR code.
- `lib/dispatch.js`: on-demand requests: who qualifies, payouts, accept, assign, expiry.
- `lib/auth.js`: PIN sign-in, signed session cookie, rate limit.
- `scripts/hash-pin.js`: `npm run hash-pin -- <pin>` prints the value for a `PIN_HASH_<ID>` env var.

## Assumptions

- Posting times: one post a day, 12 PM Mon–Thu and 7 PM Fri–Sun. This is a guess; change it in `server.js` (`slotFor`).
- Booking link is a placeholder: `{{BOOKING_URL}}` in `lib/brand.json`.
- Metrics logged: seconds from upload to approved, taps per post, posts planned vs. posted.

## Phone details

- Techs can **Take photo** with the camera or **Choose photos** from the library.
- Photos are checked and resized on the phone; skipped photos upload as small thumbnails to save data. The upload shows progress.
- **Save photos** opens the share sheet on phones ("Save Images" puts them in the camera roll); on a computer it downloads them.
- Tap any photo to see it full screen.
- Installable: web app manifest, icons, and a service worker so the app shell opens even on a weak signal.
- iPhone Safari 15+ and Android Chrome support sharing several photos at once. Test the Share button on a real iPhone and Android early: it is the riskiest step.

## Upgrade path

Direct auto-publishing through the Meta Graph API is a later upgrade. It needs an Instagram Business account linked to a Facebook Page and an approved Meta app. The share button lets the studio start on day one without any of that.
