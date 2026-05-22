## What I verified (no code changes yet)

- **Webhook**: registered at `https://project--9ef62c09-04ce-4d3b-8fd9-0e217cf62a78-dev.lovable.app/api/public/telegram/webhook`, `pending_update_count: 0`, allowed updates `message` + `callback_query`. ✅
- **Secret token**: matches what the route expects (`sha256(telegram-webhook:<TOKEN>)` base64url). ✅
- **Group access**: `getChat` on `-1003814001847` ("Test For Bot") returns 200 and the bot has `can_send_messages`. A live test message posted to the group (message_id 99). ✅
- **DB state**: `bot_state` is currently empty (0 rows). It will be created lazily on the first `/generate` (`ensureMasterMnemonic`) — this is expected, not a bug. `generated_wallets` is also empty.
- **`/generate` and `gen_new_phrase` (the `/change` button)** code paths look correct: `ensureMasterMnemonic` lazily generates + posts the seed once, `rotateMasterMnemonic` replaces it and resets `next_index = 0`, and both post the phrase to the group.

So the webhook, generation, rotation and group notifications are wired correctly. You can `/start` → tap **Wallet Management → Generate New Wallet** and it will work.

## Why the address sometimes "doesn't match" your phone

This is the part you're asking me to explain. The bot uses the Solana standard derivation path:

```
m/44'/501'/N'/0'      // N = derivation_index, starting at 0
```

Phantom and Solflare use **the exact same path** — but only for the **active** account. Importing a seed phrase only restores account #1 (index 0) by default. Accounts at indexes 1, 2, 3… **exist mathematically but are invisible until you tap "Add account"** in the wallet app — once for each index past 0.

So what you're seeing is consistent with this:

- **"Phone first, then bot"** → you already added account #2 on your phone (index 1). The bot then reserves `next_index = 1` and derives the same address. They match because both sides looked at index 1. ✅
- **"Bot first, then phone"** → bot reserves index 1 (or 2, 3…) and shows you that address. You import the phrase on your phone but the phone only shows account #1 (index 0). The bot's address is at a higher index that the phone hasn't surfaced yet. You must tap **Add account** in Phantom until you reach the same index. The address IS in your phrase, just not auto-displayed.

There is **no bug in the derivation**. The bot and Phantom agree address-for-address at the same index.

After `/change`, `next_index` resets to 0, so the next bot wallet derives at index 0 — which is the **default** account a fresh Phantom import shows. If you see a mismatch right after `/change`, it usually means an older `bot_state` row wasn't actually rotated (e.g. someone hit `/generate` between the two actions) — fixed by the diagnostics below.

## Small improvements I'd like to make

To remove ambiguity, I'll change `src/routes/api/public/telegram/webhook.ts` only:

1. **Show the derivation index prominently in BOTH DM and group messages** (already there as `#N` and `m/44'/501'/N'/0'`), and add a one-line hint: _"On Phantom/Solflare: tap 'Add account' N times to see this wallet."_
2. **Add `/status` (dev-only) command** that DMs: current `next_index`, presence/length of `mnemonic`, and `seed_posted_at`. Useful to confirm rotation took effect.
3. **`rotateMasterMnemonic` post-message** — include the next derivation index (always 0) and the same Phantom hint, so you know that the very next `/generate` will land on account #1 of a fresh import.
4. **No DB migration, no schema change, no behavior change to address derivation.** The crypto is correct as-is.

## Test plan after the edits

1. `/start` in DM → **Generate New Wallet** → confirm DM + group both show the wallet, index 0, and the hint.
2. `/change` (you, dev id `8880961735`) → tap **Generate New Phrase** → confirm group gets the new phrase, then `/generate` and confirm index resets to 0.
3. Import the freshly rotated phrase into a clean Phantom — account #1 should equal the bot's index-0 address.
4. `/generate` a second time → bot shows index 1 → on Phantom tap **Add account** → matches.
