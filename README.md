# Hundred

Find every number from 1 to 100 out in the world, together. Tap a number, shoot it, submit, and the
thumbnail lands in that square on every player's board.

## How the data flows

- **Sign-in:** Firebase Auth with Google, asking for the `drive.file` scope (non-sensitive: the app only
  sees files it created).
- **Media:** goes straight from the phone to a `Hundred/<game>` folder in the player's **own** Google Drive,
  shared "anyone with the link". Nothing passes through or is stored by us.
- **Board index:** Firestore holds only `number → {thumbId, fileId, player}`. Live listeners push new
  captures to every open board. Docs carry `expireAt` (14 days) for a TTL policy.
- **Viewing others' captures:** browsers fetch link-shared files with a Drive API key restricted to our domain.
- **Saving:** Web Share API with files, so iPhone gets "Save Image/Video" and Android gets "Save".
  Files are fetched before the tap, because iOS only opens the share sheet straight from a tap.

Submit order: thumbnail uploads first and the index is written as soon as it's up, then the full clip
uploads in the background (progress ring in the square).

## Local dev

```sh
npm install
npm run emulate        # Firebase auth + Firestore emulators (needs Java)
npm run fake-drive     # stand-in for the Drive endpoints on :9300
npm run dev:emulator   # http://localhost:5173 ; sign in from devtools: __testSignIn('alice','Alice')
```

Against real Google: copy `.env.example` to `.env.local`, fill it in, `npm run dev`.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`. It needs:
- secret `FIREBASE_SERVICE_ACCOUNT` (from `firebase init hosting:github`)
- repo variables `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`,
  `FIREBASE_MESSAGING_SENDER_ID`, `DRIVE_API_KEY`

Firestore rules deploy with `npm run deploy` (`firebase deploy --only hosting,firestore`).
Index cleanup: `gcloud firestore fields ttls update expireAt --collection-group=captures --enable-ttl`
(and the same for `games`).

## Known limits of the prototype

- Keep the app open until the ring in your square finishes. iOS may pause uploads when the screen locks.
- While the consent screen is in Testing mode: 100 test users max, and sign-ins expire after 7 days.
- Android shows a Video / Photo / Library sheet; iOS opens the camera directly with its own switch.
- Games are always 1–100 for now (the board already pages for bigger ranges).
